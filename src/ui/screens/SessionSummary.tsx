import { useEffect, useMemo, useState } from 'react';
import { useFlash } from '../../app/flash';
import { href } from '../../app/router';
import { useWorkspace } from '../../app/workspace';
import { charCount, LIMITS } from '../../domain/limits';
import { DAY_MS, formatInterval } from '../../domain/scheduler';
import { summarizeToday } from '../../domain/stats';
import { formatDateTime } from '../../domain/time';
import {
  RATING_LABELS,
  RATINGS,
  type QuickCheckReview,
  type RecallReview,
  type Session,
  type SkipReason,
} from '../../domain/types';
import { CharCount, Notice, PageHeader } from '../components/common';

const SKIP_TEXT: Record<SkipReason, string> = {
  deleted: 'deleted',
  paused: 'paused',
  'not-due': 'no longer due',
  'reviewed-elsewhere': 'reviewed elsewhere',
  'recall-only': 'now needs a full recall',
};

export function SessionSummary({ sessionId }: { sessionId: string }) {
  const ws = useWorkspace();
  const { show } = useFlash();
  const tz = ws.preferences.timezone;
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [reflection, setReflection] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void ws.repo.getSession(sessionId).then((s) => {
      if (live) setSession(s);
    });
    return () => {
      live = false;
    };
  }, [ws.repo, sessionId, ws.reviews.length]);

  const reviews = useMemo(() => ws.reviews.filter((r) => r.sessionId === sessionId), [ws.reviews, sessionId]);
  const saved = ws.reflections.filter((r) => r.sessionId === sessionId);
  const today = useMemo(
    () => summarizeToday(ws.activeCards, ws.schedules, ws.reviews, ws.now, tz),
    [ws.activeCards, ws.schedules, ws.reviews, ws.now, tz],
  );

  if (session === undefined) {
    return (
      <div className="screen">
        <PageHeader title="Session" />
        <p className="muted" role="status">
          Loading…
        </p>
      </div>
    );
  }
  if (session === null) {
    return (
      <div className="screen">
        <PageHeader title="Session not found" />
        <p>
          <a href={href('')}>Back to Today</a>
        </p>
      </div>
    );
  }
  if (session.status === 'active') {
    return (
      <div className="screen">
        <PageHeader title="Session in progress" />
        <p>
          <a className="button button--primary" href={href('practice')}>
            Resume session
          </a>
        </p>
      </div>
    );
  }

  const quick = session.mode === 'quick-check';
  const recallReviews = reviews.filter((r): r is RecallReview => r.mode === 'recall');
  const quickChecks = reviews.filter((r): r is QuickCheckReview => r.mode === 'quick-check');
  const counts = Object.fromEntries(RATINGS.map((r) => [r, recallReviews.filter((x) => x.rating === r).length])) as Record<
    number,
    number
  >;
  const correctCount = quickChecks.filter((r) => r.quickCheck.correct).length;
  const skipped = session.results.filter((r) => r.outcome === 'skipped');
  // Rated Again, or missed in a quick check: both come back in 10 minutes.
  const again = reviews.filter((r) => (r.mode === 'recall' ? r.rating === 1 : !r.quickCheck.correct));
  // A full-recall session can hold quick checks: cards the learner switched to their options.
  const againLabel = quick ? 'missed' : again.some((r) => r.mode === 'quick-check') ? 'rated Again or missed' : 'rated Again';
  const remaining = session.queue.length - session.results.length;
  const ended = session.status === 'ended';

  async function saveReflection() {
    setSaving(true);
    setError(null);
    try {
      await ws.repo.addReflection(reflection, sessionId, Date.now());
      setReflection('');
      await ws.refresh();
      show('Reflection saved. You’ll find it under Progress.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="screen summary">
      <PageHeader
        title={ended ? 'Session ended' : 'Session complete'}
        kicker={session.endedAt ? formatDateTime(session.endedAt, tz) : undefined}
      />

      <section className="panel" aria-labelledby="summary-title">
        <h2 id="summary-title" className="due-figure">
          <span className="due-figure__number">{reviews.length}</span>
          <span className="due-figure__label">
            {quick
              ? reviews.length === 1
                ? 'card quick-checked'
                : 'cards quick-checked'
              : reviews.length === 1
                ? 'card reviewed'
                : 'cards reviewed'}
            {session.topics ? ` · ${session.topics.join(', ')}` : ''}
          </span>
        </h2>
        {ended && remaining > 0 ? (
          <p className="muted">
            Ended with {remaining} card{remaining === 1 ? '' : 's'} not reached; {remaining === 1 ? 'it stays' : 'they stay'} due.
          </p>
        ) : null}

        {quick && quickChecks.length > 0 ? (
          <>
            <table className="table rating-summary">
              <caption className="visually-hidden">Your quick-check results this session</caption>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    Correct
                  </th>
                  <th scope="col" className="num">
                    Missed
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="num">{correctCount}</td>
                  <td className="num">{quickChecks.length - correctCount}</td>
                </tr>
              </tbody>
            </table>
            <p className="muted">
              Quick checks test recognition, not recall. Correct picks bring cards back in a day or two without lengthening their
              intervals.
            </p>
          </>
        ) : null}
        {!quick && recallReviews.length > 0 ? (
          <table className="table rating-summary">
            <caption className="visually-hidden">Your self-ratings this session</caption>
            <thead>
              <tr>
                {RATINGS.map((r) => (
                  <th key={r} scope="col" className="num">
                    {RATING_LABELS[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {RATINGS.map((r) => (
                  <td key={r} className="num">
                    {counts[r]}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        ) : null}
        {!quick && quickChecks.length > 0 ? (
          <p className="muted">
            {quickChecks.length === 1
              ? '1 card was switched to its options and saved as a quick check'
              : `${quickChecks.length} cards were switched to their options and saved as quick checks`}
            : {correctCount} correct, {quickChecks.length - correctCount} missed. Quick checks test recognition, not recall, and
            never lengthen an interval.
          </p>
        ) : null}

        {again.length > 0 ? (
          <p>
            {again.length} card{again.length === 1 ? '' : 's'} {againLabel} will be due in{' '}
            {formatInterval((again[0]!.after.dueAt - again[0]!.committedAt) / DAY_MS)}
            {again.length === 1 ? ` (${formatDateTime(again[0]!.after.dueAt, tz)})` : ''}. They’ll appear in your next session,
            not this one.
          </p>
        ) : null}
        {skipped.length > 0 ? (
          <p className="muted">
            Skipped {skipped.length} card{skipped.length === 1 ? '' : 's'} that changed during the session (
            {[...new Set(skipped.map((s) => SKIP_TEXT[s.reason ?? 'not-due']))].join(', ')}).
          </p>
        ) : null}
        <div className="button-row">
          <a className="button button--primary" href={href('')}>
            Back to Today
          </a>
          {today.dueCount > 0 ? (
            <span className="muted">
              {today.dueCount} more card{today.dueCount === 1 ? ' is' : 's are'} due.
            </span>
          ) : null}
        </div>
      </section>

      <section className="section reflection" aria-labelledby="reflect-title">
        <h2 id="reflect-title" className="section__title">
          Reflect <span className="muted">(optional)</span>
        </h2>
        {saved.map((r) => (
          <blockquote key={r.id} className="reflection__saved">
            <p>{r.body}</p>
          </blockquote>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveReflection();
          }}
        >
          <div className={`field${error ? ' has-error' : ''}`}>
            <div className="field__label-row">
              <label htmlFor="reflection" className="field__label">
                {saved.length ? 'Add another note' : 'What will you take from this session?'}
              </label>
              <CharCount count={charCount(reflection)} limit={LIMITS.reflection} />
            </div>
            <p id="reflection-hint" className="field__hint">
              Which idea felt shaky? What connects to something you already know? A card that needs rewording?
            </p>
            <textarea
              id="reflection"
              rows={4}
              value={reflection}
              onChange={(e) => setReflection(e.target.value)}
              aria-describedby={error ? 'reflection-hint reflection-error' : 'reflection-hint'}
              aria-invalid={error ? true : undefined}
            />
            {error ? (
              <p id="reflection-error" className="field__error">
                {error}
              </p>
            ) : null}
          </div>
          <button type="submit" className="button button--secondary" disabled={saving || reflection.trim() === ''}>
            Save reflection
          </button>
        </form>
      </section>
      {reviews.length === 0 && !ended ? (
        <Notice tone="info">
          <p>No cards were reviewed in this session.</p>
        </Notice>
      ) : null}
    </div>
  );
}
