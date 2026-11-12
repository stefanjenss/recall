import { useCallback, useEffect, useRef, useState } from 'react';
import { AiClientError } from '../../ai/client';
import { externalGradingPrompt } from '../../ai/prompt';
import { useAi } from '../../app/ai';
import { href } from '../../app/router';
import { useWorkspace } from '../../app/workspace';
import { isGradable } from '../../domain/grading';
import {
  ASSESSMENT_LABEL_TEXT,
  RATING_LABELS,
  type Assessment,
  type AssessmentLabel,
  type Attempt,
  type Card,
  type CriterionResult,
  type Rubric,
} from '../../domain/types';
import { Notice } from './common';

const LABEL_MARK: Record<AssessmentLabel, string> = { correct: '✓', partial: '◐', incorrect: '✗', unable: '?' };
const RESULT_TEXT: Record<CriterionResult, string> = { met: 'Met', partial: 'Partly', missing: 'Missing' };
const RESULT_MARK: Record<CriterionResult, string> = { met: '✓', partial: '◐', missing: '–' };

/**
 * AI feedback on a revealed full-recall attempt, shown above the self-rating.
 * It never rates the card: it reports what it found and suggests a rating, and
 * the rating buttons below work whether or not it is used, succeeds, or fails.
 * Nothing is sent until the learner asks.
 */
export function AiFeedback({
  sessionId,
  attempt,
  card,
  assessment,
  onAssessment,
  disabled,
}: {
  sessionId: string;
  attempt: Attempt;
  card: Card;
  assessment: Assessment | null;
  onAssessment: (assessment: Assessment | null) => void;
  /** The attempt is being saved or can no longer be rated. */
  disabled: boolean;
}) {
  const ws = useWorkspace();
  const ai = useAi();
  const { repo } = ws;
  const [rubric, setRubric] = useState<Rubric | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null);
  const current = useRef(attempt.id);
  current.current = attempt.id;

  // The rubric, and any assessment already stored for this attempt (after a reload, say).
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    setCopied(null);
    if (ai.mode === 'off') return;
    void repo.getGrading(card.id, attempt.id).then(
      (g) => {
        if (cancelled) return;
        setRubric(g.rubric);
        onAssessment(g.assessment);
        setLoaded(true);
      },
      () => {
        if (!cancelled) setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
    // Reload only for a new attempt or a mode change.
  }, [ai.mode, repo, card.id, attempt.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const typed = isGradable(attempt.response);
  const usable = rubric !== null && rubric.reviewed;
  // A rubric written after seeing your own answer would grade to fit it.
  const rubricIsNew = usable && rubric.updatedAt > attempt.startedAt;

  const grade = useCallback(async () => {
    if (!ai.evaluator || !rubric || busy) return;
    const attemptId = attempt.id;
    setBusy(true);
    setError(null);
    try {
      const result = await ai.evaluator.grade({ attempt, card, rubric }, Date.now());
      if (current.current !== attemptId) return;
      const saved = await repo.saveAssessment(sessionId, result, Date.now());
      if (current.current !== attemptId) return;
      if (saved.status === 'stale') {
        setError(
          saved.reason === 'rubric-changed'
            ? 'The rubric changed while this answer was being evaluated, so the result was discarded.'
            : 'This card or session changed while the answer was being evaluated, so the result was discarded.',
        );
        return;
      }
      onAssessment(saved.assessment);
      void ws.refresh();
    } catch (err) {
      if (current.current !== attemptId) return;
      setError(err instanceof AiClientError || err instanceof Error ? err.message : String(err));
    } finally {
      if (current.current === attemptId) setBusy(false);
    }
  }, [ai.evaluator, rubric, busy, attempt, card, repo, sessionId, onAssessment, ws]);

  if (ai.mode === 'off' || !loaded) return null;

  if (ai.mode === 'external') {
    if (!typed) return null;
    return (
      <section className="ai-feedback" aria-labelledby="ai-feedback-title">
        <h2 id="ai-feedback-title" className="eyebrow">
          Feedback from an assistant
        </h2>
        <p className="muted">
          Copies the question, the reference answer{usable ? ', the rubric,' : ''} and your answer as a prompt for an assistant
          you choose. Recall sends nothing itself and doesn’t record the reply.
        </p>
        <div className="button-row">
          <button
            type="button"
            className="button button--secondary"
            onClick={async () => {
              const prompt = externalGradingPrompt({
                question: card.question,
                referenceAnswer: card.answer,
                rubric: usable ? rubric : null,
                response: attempt.response,
              });
              try {
                await navigator.clipboard.writeText(prompt);
                setCopied('done');
              } catch {
                setCopied('failed');
              }
            }}
          >
            Copy grading prompt
          </button>
          <span className="muted" role="status">
            {copied === 'done' ? 'Copied.' : copied === 'failed' ? 'Couldn’t copy. Your browser blocked the clipboard.' : ''}
          </span>
        </div>
      </section>
    );
  }

  const heading = (
    <h2 id="ai-feedback-title" className="eyebrow">
      AI feedback <span className="ai-feedback__tag">experimental</span>
    </h2>
  );

  if (assessment) {
    return (
      <section className="ai-feedback" aria-labelledby="ai-feedback-title">
        {heading}
        <AssessmentView assessment={assessment} />
      </section>
    );
  }

  let unavailable: string | null = null;
  let editLink = false;
  if (!typed) unavailable = 'AI feedback needs a typed answer. Compare with the reference and rate your recall.';
  else if (!usable) {
    unavailable = 'This card has no rubric yet, so AI feedback isn’t available for it.';
    editLink = true;
  } else if (rubricIsNew) {
    unavailable = 'This card’s rubric was saved after you started this attempt. AI feedback is available from the next attempt.';
  } else if (ai.availability.state === 'no-sync') {
    unavailable = 'AI feedback runs through your sync server, and this device isn’t connected to one.';
  } else if (ai.availability.state === 'not-configured') {
    unavailable = 'Your sync server has no AI model set up.';
  } else if (ai.availability.state === 'unreachable') {
    unavailable = `AI feedback isn’t available right now. ${ai.availability.message}`;
  } else if (ai.availability.state === 'checking') {
    unavailable = 'Checking whether AI feedback is available…';
  }

  if (unavailable || !ai.evaluator) {
    return (
      <section className="ai-feedback" aria-labelledby="ai-feedback-title">
        {heading}
        <p className="muted">
          {unavailable ?? 'AI feedback isn’t available right now.'}{' '}
          {editLink ? <a href={href(`collection/${card.id}`)}>Add a rubric in the card editor</a> : null}
          {ai.availability.state === 'unreachable' ? (
            <button type="button" className="button button--quiet button--small" onClick={ai.recheck}>
              Check again
            </button>
          ) : null}
        </p>
      </section>
    );
  }

  return (
    <section className="ai-feedback" aria-labelledby="ai-feedback-title">
      {heading}
      {error ? (
        <Notice tone="error" title="No AI feedback this time">
          <p>{error} Nothing was changed. You can try again, or rate your recall below as usual.</p>
        </Notice>
      ) : null}
      <div className="button-row">
        <button type="button" className="button button--secondary" onClick={() => void grade()} disabled={busy || disabled}>
          {error ? 'Try AI feedback again' : 'Get AI feedback'}
        </button>
        {busy ? (
          <span className="muted" role="status">
            Asking {ai.evaluator.model}…
          </span>
        ) : null}
      </div>
      <p id="ai-feedback-sends" className="muted small">
        Sends this card’s question, reference answer, and rubric, and your answer above, through your sync server to{' '}
        {ai.evaluator.destination} ({ai.evaluator.model}). Nothing is sent until you choose this.
      </p>
    </section>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="ai-feedback__group">
      <h3>{title}</h3>
      <ul>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function AssessmentView({ assessment: a }: { assessment: Assessment }) {
  const descriptions = new Map(a.rubric.criteria.map((c) => [c.id, c.description]));
  return (
    <div className="ai-feedback__result">
      <p className={`ai-feedback__label ai-feedback__label--${a.label}`} role="status">
        <span aria-hidden="true">{LABEL_MARK[a.label]} </span>
        {ASSESSMENT_LABEL_TEXT[a.label]}
        {a.score !== null ? (
          <span className="ai-feedback__score"> · {Math.round(a.score * 100)}% of the rubric covered</span>
        ) : null}
      </p>
      {a.label === 'unable' ? (
        <p>
          {a.uncertaintyReason} No rating is suggested. Compare your answer with the reference and rate your recall; if the
          reference is unclear, consider revising the card.
        </p>
      ) : (
        <>
          <p className="ai-feedback__explanation">{a.explanation}</p>
          <List title="What you got right" items={a.correctAspects} />
          <List title="What was missing" items={a.missingAspects} />
          <List title="What was wrong" items={[...a.criticalMisconceptions, ...a.incorrectClaims]} />
          <details className="disclosure">
            <summary>Rubric, criterion by criterion</summary>
            <ul className="ai-feedback__criteria">
              {a.criteria.map((c) => (
                <li key={c.id}>
                  <span className={`ai-feedback__criterion ai-feedback__criterion--${c.result}`}>
                    <span aria-hidden="true">{RESULT_MARK[c.result]} </span>
                    {RESULT_TEXT[c.result]}
                  </span>{' '}
                  {descriptions.get(c.id) ?? c.id}
                  {c.evidence ? <span className="ai-feedback__evidence"> “{c.evidence}”</span> : null}
                </li>
              ))}
            </ul>
          </details>
          {a.suggestedRating !== null ? (
            <p>
              <strong>Suggested rating: {RATING_LABELS[a.suggestedRating]}.</strong>{' '}
              <span className="muted">It’s a suggestion. The rating you choose below is what schedules the card.</span>
            </p>
          ) : null}
        </>
      )}
      <p className="muted small">
        From {a.model}. A model’s reading of one answer, not a measure of what you know. It can be wrong.
      </p>
    </div>
  );
}
