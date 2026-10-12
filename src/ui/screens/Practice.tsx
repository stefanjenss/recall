import { useCallback, useEffect, useRef, useState } from 'react';
import { href, navigate } from '../../app/router';
import { useWorkspace } from '../../app/workspace';
import { charCount, LIMITS, overLimitMessage } from '../../domain/limits';
import { formatInterval, previewRatings } from '../../domain/scheduler';
import {
  CONFIDENCE_LABELS,
  CONFIDENCE_LEVELS,
  KIND_LABELS,
  RATING_DESCRIPTIONS,
  RATING_LABELS,
  RATINGS,
  type Confidence,
  type Rating,
  type SkipReason,
} from '../../domain/types';
import type { PracticeState } from '../../storage/repository';
import { CharCount, ConfirmDialog, Markdown, Notice, Segmented, SourceLine } from '../components/common';

type Phase = 'loading' | 'none' | 'answering' | 'revealing' | 'revealed' | 'saving';

type Problem =
  | { kind: 'save-error'; message: string; rating: Rating }
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

export function Practice() {
  const ws = useWorkspace();
  const { repo } = ws;
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
    } catch (err) {
      setPhase('none');
      setProblem({ kind: 'reveal-error', message: message(err) });
    }
  }, [repo, apply]);

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

  const rate = useCallback(
    async (rating: Rating) => {
      if (!session || !attempt) return;
      if (phase !== 'revealed') return;
      if (problem && problem.kind !== 'save-error') return;
      setPhase('saving');
      setProblem(null);
      try {
        const result = await repo.commitReview(session.id, attempt.id, rating, Date.now());
        if (result.status === 'committed' || result.status === 'duplicate') {
          const r = result.review;
          setAnnouncement(
            `${result.status === 'duplicate' ? 'Already saved' : 'Saved'}: ${RATING_LABELS[r.rating]}. Due again in ${formatInterval(r.after.intervalDays)}.`,
          );
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
    const remote = ws.activeSession;
    // A remote index at or behind ours is just this tab's own write not yet reflected in the workspace.
    if (remote && remote.id === session.id && remote.index <= session.index) return;
    setProblem((p) => p ?? { kind: 'session-changed' });
  }, [ws.status, ws.activeSession, session, phase]);

  // ---- Keyboard: Space reveals, 1–4 rate. Never while typing, in a dialog, or saving. ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.key === ' ' && phase === 'answering' && !spaceIsTaken(e.target)) {
        e.preventDefault();
        void reveal();
      } else if (/^[1-4]$/.test(e.key) && phase === 'revealed' && !digitsAreTyped(e.target)) {
        e.preventDefault();
        void rate(Number(e.key) as Rating);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, reveal, rate]);

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

        {!revealed ? (
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
            {problem ? (
              <ProblemNotice problem={problem} onRetry={rate} onSkip={skipCard} onLoadUpdated={loadUpdated} onReload={load} />
            ) : null}
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

            {problem ? (
              <ProblemNotice problem={problem} onRetry={rate} onSkip={skipCard} onLoadUpdated={loadUpdated} onReload={load} />
            ) : null}

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
                      onClick={() => void rate(r)}
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

function ProblemNotice({
  problem,
  onRetry,
  onSkip,
  onLoadUpdated,
  onReload,
}: {
  problem: Problem;
  onRetry: (r: Rating) => void;
  onSkip: (reason: SkipReason) => void;
  onLoadUpdated: () => void;
  onReload: () => void;
}) {
  switch (problem.kind) {
    case 'save-error':
      return (
        <Notice tone="error" title="That rating wasn’t saved">
          <p>{problem.message} Your answer is still here and nothing changed. Try again, or choose a different rating.</p>
          <button type="button" className="button button--secondary" onClick={() => onRetry(problem.rating)}>
            Retry “{RATING_LABELS[problem.rating]}”
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
          <p>This card’s schedule changed in another tab or window, so this rating wasn’t saved.</p>
          <button type="button" className="button button--secondary" onClick={() => onSkip('reviewed-elsewhere')}>
            Continue to the next card
          </button>
        </Notice>
      );
    case 'paused':
    case 'deleted':
      return (
        <Notice tone="warn" title={`This card was ${problem.kind}`}>
          <p>It was {problem.kind} after you started, so this rating wasn’t saved.</p>
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
