import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { href, navigate } from '../../app/router';
import { useWorkspace } from '../../app/workspace';
import { charCount, LIMITS, overLimitMessage } from '../../domain/limits';
import { DAY_MS, formatInterval, previewQuickCheck, previewRatings, QUICK_CHECK_LIMIT } from '../../domain/scheduler';
import {
  CONFIDENCE_LABELS,
  CONFIDENCE_LEVELS,
  KIND_LABELS,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  RATING_DESCRIPTIONS,
  RATING_LABELS,
  RATINGS,
  type Confidence,
  type Rating,
  type Review,
  type SkipReason,
} from '../../domain/types';
import type { CommitResult, PracticeState } from '../../storage/repository';
import { CharCount, ConfirmDialog, Markdown, Notice, OptionText, Segmented, SourceLine } from '../components/common';

type Phase = 'loading' | 'none' | 'answering' | 'revealing' | 'revealed' | 'saving';

type Problem =
  /** `rating` is null for a quick check, which has no self-rating. */
  | { kind: 'save-error'; message: string; rating: Rating | null }
  | { kind: 'reveal-error'; message: string }
  | { kind: 'edited' }
  | { kind: 'reviewed-elsewhere' }
  | { kind: 'paused' }
  | { kind: 'deleted' }
  | { kind: 'session-changed' };

const DRAFT_DEBOUNCE_MS = 400;

/** Elements where Space has its own meaning (typing, pressing a button, choosing an option). */
function spaceIsTaken(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    'input, textarea, select, button, a[href], summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="radio"]',
  );
}

/** Elements where digits are text input. */
function digitsAreTyped(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function savedAnnouncement(review: Review, duplicate: boolean): string {
  const outcome =
    review.mode === 'quick-check' ? (review.quickCheck.correct ? 'correct' : 'missed') : RATING_LABELS[review.rating];
  const due = formatInterval((review.after.dueAt - review.committedAt) / DAY_MS);
  return `${duplicate ? 'Already saved' : 'Saved'}: ${outcome}. Due again in ${due}.`;
}

export function Practice() {
  const ws = useWorkspace();
  const { repo, refresh } = ws;
  const [state, setState] = useState<PracticeState | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [response, setResponse] = useState('');
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const questionHeading = useRef<HTMLHeadingElement>(null);
  const answerHeading = useRef<HTMLHeadingElement>(null);
  const draft = useRef({ response: '', confidence: null as Confidence | null, dirty: false });
  const focusTarget = useRef<'question' | 'answer' | null>(null);

  const session = state?.session ?? null;
  const attempt = session?.attempt ?? null;
  const card = state?.card ?? null;

  const apply = useCallback((next: PracticeState | null, focus: 'question' | 'answer' | null = null) => {
    if (!next) {
      setState(null);
      setPhase('none');
      return;
    }
    if (next.session.status !== 'active' || !next.session.attempt || !next.card) {
      navigate(`session/${next.session.id}`, undefined, { replace: true });
      return;
    }
    const a = next.session.attempt;
    setState(next);
    setResponse(a.response);
    setConfidence(a.confidence);
    draft.current = { response: a.response, confidence: a.confidence, dirty: false };
    setProblem(null);
    setInputError(null);
    setPhase(a.revealed ? 'revealed' : 'answering');
    focusTarget.current = focus;
  }, []);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      const active = await repo.getActiveSession();
      if (!active) {
        apply(null);
        return;
      }
      apply(await repo.ensureAttempt(active.id, Date.now()), 'question');
      void refresh();
    } catch (err) {
      setPhase('none');
      setProblem({ kind: 'reveal-error', message: message(err) });
    }
  }, [repo, refresh, apply]);

  useEffect(() => {
    void load();
  }, [load]);

  // Move focus after the DOM for a new card or a revealed answer exists.
  useEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    focusTarget.current = null;
    (target === 'question' ? questionHeading : answerHeading).current?.focus();
  });

  // ---- Draft persistence: debounced while typing, flushed when leaving. ----
  const flushDraft = useCallback(() => {
    if (!session || !attempt || attempt.revealed || !draft.current.dirty) return;
    draft.current.dirty = false;
    void repo.saveDraft(session.id, attempt.id, { response: draft.current.response, confidence: draft.current.confidence });
  }, [repo, session, attempt]);

  useEffect(() => {
    if (phase !== 'answering') return;
    draft.current = { response, confidence, dirty: response !== attempt?.response || confidence !== attempt?.confidence };
    if (!draft.current.dirty) return;
    const id = window.setTimeout(flushDraft, DRAFT_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [response, confidence, phase, attempt, flushDraft]);

  useEffect(() => {
    const onHide = () => flushDraft();
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
      flushDraft();
    };
  }, [flushDraft]);

  // ---- Actions ----
  const reveal = useCallback(async () => {
    if (phase !== 'answering' || !session || !attempt) return;
    const tooLong = overLimitMessage('Your answer', response, LIMITS.response);
    if (tooLong) {
      setInputError(tooLong);
      return;
    }
    setPhase('revealing');
    setProblem(null);
    try {
      const next = await repo.reveal(session.id, attempt.id, { response, confidence }, Date.now());
      if (next && next.session.attempt?.id !== attempt.id) {
        apply(next, 'question');
        setProblem({ kind: 'session-changed' });
        return;
      }
      apply(next, 'answer');
    } catch (err) {
      setPhase('answering');
      setProblem({ kind: 'reveal-error', message: message(err) });
    }
  }, [phase, session, attempt, response, confidence, repo, apply]);

  /** Quick check: the first pick freezes the attempt and shows the result. */
  const pick = useCallback(
    async (index: number) => {
      if (phase !== 'answering' || !session || !attempt?.options) return;
      setPhase('revealing');
      setProblem(null);
      try {
        const next = await repo.pickOption(session.id, attempt.id, index, Date.now());
        if (next && next.session.attempt?.id !== attempt.id) {
          apply(next, 'question');
          setProblem({ kind: 'session-changed' });
          return;
        }
        apply(next, 'answer');
      } catch (err) {
        setPhase('answering');
        setProblem({ kind: 'reveal-error', message: message(err) });
      }
    },
    [phase, session, attempt, repo, apply],
  );

  /** Commit the revealed attempt: a self-rating for full recall, or null to save a quick check. */
  const commit = useCallback(
    async (rating: Rating | null) => {
      if (!session || !attempt) return;
      if (phase !== 'revealed') return;
      if (problem && problem.kind !== 'save-error') return;
      setPhase('saving');
      setProblem(null);
      try {
        const result: CommitResult =
          rating === null
            ? await repo.commitQuickCheck(session.id, attempt.id, Date.now())
            : await repo.commitReview(session.id, attempt.id, rating, Date.now());
        if (result.status === 'committed' || result.status === 'duplicate') {
          setAnnouncement(savedAnnouncement(result.review, result.status === 'duplicate'));
          void ws.refresh();
          apply(result.state, 'question');
          return;
        }
        if (result.status === 'stale' || result.status === 'ineligible') {
          setPhase('revealed');
          setProblem({ kind: result.reason });
        }
      } catch (err) {
        setPhase('revealed');
        setProblem({ kind: 'save-error', message: message(err), rating });
      }
    },
    [session, attempt, phase, problem, repo, ws, apply],
  );

  const skipCard = useCallback(
    async (reason: SkipReason) => {
      if (!session || !attempt) return;
      apply(await repo.skipCurrent(session.id, attempt.id, reason, Date.now()), 'question');
      void ws.refresh();
    },
    [session, attempt, repo, ws, apply],
  );

  const loadUpdated = useCallback(async () => {
    if (!session || !attempt) return;
    apply(await repo.refreshAttempt(session.id, attempt.id, Date.now()), 'question');
  }, [session, attempt, repo, apply]);

  const endSession = useCallback(async () => {
    if (!session) return;
    flushDraft();
    await repo.endSession(session.id, Date.now());
    await ws.refresh();
    navigate(`session/${session.id}`, undefined, { replace: true });
  }, [session, repo, ws, flushDraft]);

  // ---- Another tab moved this session on (rated, skipped, or ended it). ----
  useEffect(() => {
    if (ws.status !== 'ready' || !session || phase === 'loading' || phase === 'saving' || phase === 'revealing') return;
    // A snapshot read before this session began knows nothing about it yet.
    if (ws.loadedAt < session.startedAt) return;
    const remote = ws.activeSession;
    // A remote index at or behind ours is just this tab's own write not yet reflected in the workspace.
    if (remote && remote.id === session.id && remote.index <= session.index) return;
    setProblem((p) => p ?? { kind: 'session-changed' });
  }, [ws.status, ws.loadedAt, ws.activeSession, session, phase]);

  // ---- Keyboard. Full recall: Space reveals, 1–4 rate. Quick check: 1–4 pick, Space continues.
  // Never while typing, in a dialog, or saving. ----
  const quick = session?.mode === 'quick-check';
  const optionCount = attempt?.options?.length ?? 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.key === ' ' && !spaceIsTaken(e.target)) {
        if (!quick && phase === 'answering') {
          e.preventDefault();
          void reveal();
        } else if (quick && phase === 'revealed') {
          e.preventDefault();
          void commit(null);
        }
      } else if (/^[1-9]$/.test(e.key) && !digitsAreTyped(e.target)) {
        const n = Number(e.key);
        if (quick && phase === 'answering' && n <= optionCount) {
          e.preventDefault();
          void pick(n - 1);
        } else if (!quick && phase === 'revealed' && n <= 4) {
          e.preventDefault();
          void commit(n as Rating);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, quick, optionCount, reveal, pick, commit]);

  // ---- Render ----
  if (phase === 'loading') {
    return (
      <div className="screen practice">
        <h1 className="visually-hidden" tabIndex={-1}>
          Practice
        </h1>
        <p className="muted" role="status">
          Loading your session…
        </p>
      </div>
    );
  }

  if (phase === 'none' || !session || !attempt || !card) {
    return (
      <div className="screen practice">
        <h1 tabIndex={-1}>Practice</h1>
        {problem && problem.kind === 'reveal-error' ? (
          <Notice tone="error">
            <p>{problem.message}</p>
          </Notice>
        ) : null}
        <p className="lead">There’s no session in progress.</p>
        <p>
          <a className="button button--primary" href={href('')}>
            Go to Today
          </a>
        </p>
      </div>
    );
  }

  const revealed = phase === 'revealed' || phase === 'saving';
  const saving = phase === 'saving';
  const position = session.index + 1;
  const total = session.queue.length;
  const reviewedSoFar = session.results.filter((r) => r.outcome === 'reviewed').length;
  const previews = state?.schedule ? previewRatings(state.schedule, ws.now) : [];
  const ratingBlocked = !!problem && problem.kind !== 'save-error';
  const isNewCard = state?.schedule?.reviewCount === 0;
  const problemNotice = problem ? (
    <ProblemNotice problem={problem} onRetry={commit} onSkip={skipCard} onLoadUpdated={loadUpdated} onReload={load} />
  ) : null;

  return (
    <div className="screen practice">
      <h1 className="visually-hidden" tabIndex={-1}>
        Practice
      </h1>
      <div className="practice__bar">
        <div className="practice__progress">
          <p>
            Card <strong>{position}</strong> of {total}
            <span className="muted"> · {reviewedSoFar} reviewed</span>
          </p>
          <div
            className="progress-rule"
            role="progressbar"
            aria-label="Session progress"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={session.index}
          >
            <span style={{ width: `${(session.index / total) * 100}%` }} />
          </div>
        </div>
        <button
          type="button"
          className="button button--quiet button--small"
          onClick={() => setConfirmEnd(true)}
          disabled={saving}
        >
          End session
        </button>
      </div>

      <article className="practice__card" aria-label={`Card ${position} of ${total}`}>
        <p className="practice__meta">
          <span>{card.topic}</span>
          <span aria-hidden="true"> · </span>
          <span>{KIND_LABELS[card.kind]}</span>
          {quick ? (
            <>
              <span aria-hidden="true"> · </span>
              <span>{MODE_LABELS['quick-check']}</span>
            </>
          ) : null}
          {isNewCard ? (
            <>
              <span aria-hidden="true"> · </span>
              <span>New card</span>
            </>
          ) : null}
        </p>
        <h2 className="visually-hidden" ref={questionHeading} tabIndex={-1}>
          Question
        </h2>
        <Markdown source={card.question} className="practice__question" />

        {quick && attempt.options ? (
          <QuickCheck
            options={attempt.options}
            picked={attempt.picked}
            correctOption={card.choices?.correct ?? null}
            answer={card.answer}
            source={card.source}
            phase={phase}
            daysIfCorrect={state?.schedule ? previewQuickCheck(state.schedule, true, ws.now) : null}
            daysIfMissed={state?.schedule ? previewQuickCheck(state.schedule, false, ws.now) : null}
            reachesLimit={(state?.schedule?.quickChecksSinceRecall ?? 0) + 1 >= QUICK_CHECK_LIMIT}
            blocked={ratingBlocked}
            problem={problemNotice}
            resultHeading={answerHeading}
            onPick={pick}
            onContinue={() => void commit(null)}
          />
        ) : !revealed ? (
          <form
            className="practice__attempt"
            onSubmit={(e) => {
              e.preventDefault();
              void reveal();
            }}
          >
            <div className={`field${inputError ? ' has-error' : ''}`}>
              <div className="field__label-row">
                <label htmlFor="response" className="field__label">
                  Your answer
                </label>
                <CharCount count={charCount(response)} limit={LIMITS.response} />
              </div>
              <p id="response-hint" className="field__hint">
                Type it, or say it aloud and leave this blank. Retrieve first, then check.
              </p>
              <textarea
                id="response"
                className="practice__response"
                value={response}
                onChange={(e) => {
                  setResponse(e.target.value);
                  setInputError(null);
                }}
                rows={5}
                aria-describedby={inputError ? 'response-hint response-error' : 'response-hint'}
                aria-invalid={inputError ? true : undefined}
                disabled={phase === 'revealing'}
              />
              {inputError ? (
                <p id="response-error" className="field__error">
                  {inputError}
                </p>
              ) : null}
            </div>
            <Segmented
              legend={
                <>
                  How confident are you? <span className="muted">(optional, before you check)</span>
                </>
              }
              options={CONFIDENCE_LEVELS.map((c) => ({ value: c, label: CONFIDENCE_LABELS[c] }))}
              value={confidence}
              onChange={setConfidence}
              allowClear
              disabled={phase === 'revealing'}
            />
            {problemNotice}
            <div className="button-row">
              <button type="submit" className="button button--primary button--large" disabled={phase === 'revealing'}>
                Reveal answer <kbd aria-hidden="true">Space</kbd>
              </button>
            </div>
          </form>
        ) : (
          <>
            <section className="practice__frozen" aria-labelledby="your-answer-title">
              <h2 id="your-answer-title" className="eyebrow">
                Your answer
              </h2>
              {attempt.response.trim() ? (
                <p className="practice__frozen-text">{attempt.response}</p>
              ) : (
                <p className="muted">No typed answer (answered aloud or skipped typing).</p>
              )}
              <p className="muted">Confidence: {attempt.confidence ? CONFIDENCE_LABELS[attempt.confidence] : 'not recorded'}</p>
            </section>

            <section className="practice__answer" aria-labelledby="answer-title">
              <h2 id="answer-title" className="eyebrow" ref={answerHeading} tabIndex={-1}>
                Answer
              </h2>
              <Markdown source={card.answer} className="practice__answer-text" />
              <SourceLine source={card.source} />
            </section>

            {problemNotice}

            <section className="rating" aria-labelledby="rating-title">
              <h2 id="rating-title" className="rating__title">
                How well did you recall it?
              </h2>
              <p className="rating__hint muted">
                Rate your recall, not how familiar the answer looks. Your choice saves immediately.
              </p>
              <div className="rating__grid">
                {RATINGS.map((r) => {
                  const p = previews.find((x) => x.rating === r);
                  return (
                    <button
                      key={r}
                      type="button"
                      className={`rating__button rating__button--${r}`}
                      onClick={() => void commit(r)}
                      disabled={saving || ratingBlocked}
                      aria-keyshortcuts={String(r)}
                    >
                      <span className="rating__label">
                        {RATING_LABELS[r]} <kbd aria-hidden="true">{r}</kbd>
                      </span>
                      <span className="rating__desc">{RATING_DESCRIPTIONS[r]}</span>
                      <span className="rating__interval">{p ? `Next in ${formatInterval(p.intervalDays)}` : ''}</span>
                    </button>
                  );
                })}
              </div>
              {saving ? (
                <p className="muted" role="status">
                  Saving…
                </p>
              ) : null}
            </section>
          </>
        )}
      </article>

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      <ConfirmDialog
        open={confirmEnd}
        title="End this session?"
        confirmLabel="End session"
        onCancel={() => setConfirmEnd(false)}
        onConfirm={() => {
          setConfirmEnd(false);
          void endSession();
        }}
      >
        <p>
          You’ve reviewed {reviewedSoFar} of {total} cards. The current card won’t be rated and stays due, along with the rest of
          the queue.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function QuickCheck({
  options,
  picked,
  correctOption,
  answer,
  source,
  phase,
  daysIfCorrect,
  daysIfMissed,
  reachesLimit,
  blocked,
  problem,
  resultHeading,
  onPick,
  onContinue,
}: {
  options: string[];
  picked: number | null;
  correctOption: string | null;
  answer: string;
  source: string | null;
  phase: Phase;
  daysIfCorrect: number | null;
  daysIfMissed: number | null;
  reachesLimit: boolean;
  blocked: boolean;
  problem: ReactNode;
  resultHeading: RefObject<HTMLHeadingElement | null>;
  onPick: (index: number) => void;
  onContinue: () => void;
}) {
  if (picked === null) {
    return (
      <section className="choices" aria-labelledby="choices-title">
        <h2 id="choices-title" className="choices__title">
          Choose the best answer
        </h2>
        <p className="choices__hint muted">{MODE_DESCRIPTIONS['quick-check']}. Your first pick counts.</p>
        <ol className="choices__list">
          {options.map((option, i) => (
            <li key={i}>
              <button
                type="button"
                className="choice"
                onClick={() => onPick(i)}
                disabled={phase !== 'answering'}
                aria-keyshortcuts={String(i + 1)}
              >
                <kbd className="choice__key" aria-hidden="true">
                  {i + 1}
                </kbd>
                <OptionText source={option} className="choice__text" />
              </button>
            </li>
          ))}
        </ol>
        {problem}
      </section>
    );
  }

  const correct = correctOption !== null && options[picked] === correctOption;
  const days = correct ? daysIfCorrect : daysIfMissed;
  const saving = phase === 'saving';
  return (
    <>
      <section className="choices" aria-labelledby="result-title">
        <h2
          id="result-title"
          ref={resultHeading}
          tabIndex={-1}
          className={`choices__result choices__result--${correct ? 'correct' : 'missed'}`}
        >
          <span aria-hidden="true">{correct ? '✓' : '✗'} </span>
          {correct ? 'Correct' : 'Not quite'}
        </h2>
        <ol className="choices__list">
          {options.map((option, i) => {
            const isCorrect = option === correctOption;
            const isPicked = i === picked;
            const status = isCorrect ? (isPicked ? 'Your pick · correct' : 'Correct answer') : isPicked ? 'Your pick' : null;
            return (
              <li
                key={i}
                className={`choice choice--result${isCorrect ? ' is-correct' : ''}${isPicked && !isCorrect ? ' is-wrong' : ''}`}
              >
                <span className="choice__key choice__mark" aria-hidden="true">
                  {isCorrect ? '✓' : isPicked ? '✗' : ''}
                </span>
                <span className="choice__body">
                  <OptionText source={option} className="choice__text" />
                  {status ? <span className="choice__status">{status}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="practice__answer" aria-labelledby="answer-title">
        <h2 id="answer-title" className="eyebrow">
          Full answer
        </h2>
        <Markdown source={answer} className="practice__answer-text" />
        <SourceLine source={source} />
      </section>

      {problem}

      <section className="quick-next" aria-label="Save and continue">
        <p className="muted">
          {correct
            ? 'Recognizing the answer doesn’t lengthen its interval.'
            : 'A miss counts as Again, the same as in full recall.'}
          {days !== null ? ` Back in ${formatInterval(days)}.` : ''}
          {reachesLimit ? ' Next time, this card needs a full recall.' : ''}
        </p>
        <button type="button" className="button button--primary button--large" onClick={onContinue} disabled={saving || blocked}>
          Continue <kbd aria-hidden="true">Space</kbd>
        </button>
        {saving ? (
          <p className="muted" role="status">
            Saving…
          </p>
        ) : null}
      </section>
    </>
  );
}

function ProblemNotice({
  problem,
  onRetry,
  onSkip,
  onLoadUpdated,
  onReload,
}: {
  problem: Problem;
  onRetry: (r: Rating | null) => void;
  onSkip: (reason: SkipReason) => void;
  onLoadUpdated: () => void;
  onReload: () => void;
}) {
  switch (problem.kind) {
    case 'save-error':
      return (
        <Notice tone="error" title={problem.rating === null ? 'That quick check wasn’t saved' : 'That rating wasn’t saved'}>
          <p>
            {problem.message}{' '}
            {problem.rating === null
              ? 'Nothing changed. Try again.'
              : 'Your answer is still here and nothing changed. Try again, or choose a different rating.'}
          </p>
          <button type="button" className="button button--secondary" onClick={() => onRetry(problem.rating)}>
            {problem.rating === null ? 'Retry' : `Retry “${RATING_LABELS[problem.rating]}”`}
          </button>
        </Notice>
      );
    case 'reveal-error':
      return (
        <Notice tone="error">
          <p>{problem.message}</p>
        </Notice>
      );
    case 'edited':
      return (
        <Notice tone="warn" title="This card was edited">
          <p>
            The card changed after you started this attempt, so nothing was saved. Your answer is kept for a fresh attempt on the
            updated card.
          </p>
          <button type="button" className="button button--secondary" onClick={onLoadUpdated}>
            Load the updated card
          </button>
        </Notice>
      );
    case 'reviewed-elsewhere':
      return (
        <Notice tone="warn" title="Already reviewed elsewhere">
          <p>This card’s schedule changed in another tab or window, so this result wasn’t saved.</p>
          <button type="button" className="button button--secondary" onClick={() => onSkip('reviewed-elsewhere')}>
            Continue to the next card
          </button>
        </Notice>
      );
    case 'paused':
    case 'deleted':
      return (
        <Notice tone="warn" title={`This card was ${problem.kind}`}>
          <p>It was {problem.kind} after you started, so this result wasn’t saved.</p>
          <button type="button" className="button button--secondary" onClick={() => onSkip(problem.kind)}>
            Continue to the next card
          </button>
        </Notice>
      );
    case 'session-changed':
      return (
        <Notice tone="warn" title="This session changed in another tab">
          <p>Nothing was saved from this screen. Reload to continue from where the session is now.</p>
          <button type="button" className="button button--secondary" onClick={onReload}>
            Reload session
          </button>
        </Notice>
      );
  }
}
