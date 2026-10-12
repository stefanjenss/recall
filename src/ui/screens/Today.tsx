import { useMemo, useState } from 'react';
import { href, navigate } from '../../app/router';
import { useFlash } from '../../app/flash';
import { useWorkspace } from '../../app/workspace';
import { STARTER_CARDS } from '../../content/starter';
import { nextDueFor, summarizeToday } from '../../domain/stats';
import { formatDateTime, formatRelative } from '../../domain/time';
import { SESSION_SIZES, type SessionSize } from '../../domain/types';
import { backupIsStale, downloadFullBackup } from '../backupActions';
import { Notice, PageHeader, Segmented, StatList } from '../components/common';
import { LEARNING_NOTES } from './Method';

const ALL = '__all__';

export function Today() {
  const ws = useWorkspace();
  const { show } = useFlash();
  const tz = ws.preferences.timezone;
  const [topic, setTopic] = useState<string>(ALL);
  const [size, setSize] = useState<SessionSize>(ws.preferences.sessionSize);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const summary = useMemo(
    () => summarizeToday(ws.activeCards, ws.schedules, ws.reviews, ws.now, tz),
    [ws.activeCards, ws.schedules, ws.reviews, ws.now, tz],
  );
  const selectedTopic = topic === ALL ? null : topic;
  const topicSummary = summary.topics.find((t) => t.topic === selectedTopic);
  const dueInSelection = selectedTopic ? (topicSummary?.due ?? 0) : summary.dueCount;
  const sessionCount = Math.min(dueInSelection, size);
  const dateLabel = new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(
    ws.now,
  );
  const note = LEARNING_NOTES[Math.floor(ws.now / 86_400_000) % LEARNING_NOTES.length]!;

  async function start(topics: string[] | null) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await ws.repo.startSession({ topics, size, now: Date.now() });
      if (result.status === 'started') {
        await ws.refresh();
        navigate('practice');
      } else if (result.status === 'active-exists') {
        await ws.refresh();
        setMessage('You already have a session in progress. Resume it or end it first.');
      } else {
        await ws.refresh();
        const next = nextDueFor(ws.activeCards, ws.schedules, Date.now(), topics?.[0] ?? null);
        setMessage(
          `No cards are due${topics ? ` in ${topics[0]}` : ''} right now.` +
            (next ? ` The next one is due ${formatRelative(next, Date.now())} (${formatDateTime(next, tz)}).` : ''),
        );
      }
    } catch (err) {
      setMessage(`Couldn't start a session: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function endActive() {
    if (!ws.activeSession) return;
    const id = ws.activeSession.id;
    await ws.repo.endSession(id, Date.now());
    await ws.refresh();
    navigate(`session/${id}`);
  }

  async function addStarter() {
    setBusy(true);
    try {
      const { added, skipped } = await ws.repo.addMissingCards(STARTER_CARDS, Date.now());
      await ws.refresh();
      show(
        added === 0
          ? 'The starter cards are already in your collection.'
          : `Added ${added} starter card${added === 1 ? '' : 's'}${skipped ? ` (${skipped} already there)` : ''}. They're due now.`,
        added === 0 ? 'info' : 'success',
      );
    } finally {
      setBusy(false);
    }
  }

  if (ws.status === 'loading') {
    return (
      <div className="screen">
        <PageHeader title="Today" />
        <p className="muted" role="status">
          Loading your collection…
        </p>
      </div>
    );
  }

  if (ws.status === 'error') {
    return (
      <div className="screen">
        <PageHeader title="Today" />
        <Notice tone="error" title="Recall couldn't open its local storage">
          <p>{ws.error}</p>
          <p>
            This can happen in private browsing or when site storage is blocked.{' '}
            <button type="button" className="button button--quiet" onClick={() => location.reload()}>
              Try again
            </button>
          </p>
        </Notice>
      </div>
    );
  }

  const session = ws.activeSession;
  const reviewedInSession = session?.results.filter((r) => r.outcome === 'reviewed').length ?? 0;

  return (
    <div className="screen today">
      <PageHeader title="Today" kicker={dateLabel} />

      {session ? (
        <section className="panel panel--accent resume" aria-labelledby="resume-title">
          <div>
            <h2 id="resume-title">Session in progress</h2>
            <p>
              {reviewedInSession} of {session.queue.length} cards reviewed
              {session.topics ? ` · ${session.topics.join(', ')}` : ''}. Nothing is rated until you choose.
            </p>
          </div>
          <div className="button-row">
            <a className="button button--primary" href={href('practice')}>
              Resume session
            </a>
            <button type="button" className="button button--secondary" onClick={endActive}>
              End session
            </button>
          </div>
        </section>
      ) : null}

      {ws.activeCards.length === 0 ? (
        <section className="panel empty-state" aria-labelledby="empty-title">
          <h2 id="empty-title">Your collection is empty</h2>
          <p>
            Start with six sample cards about learning science and data systems, write your own, or import cards an assistant
            prepared for you.
          </p>
          <div className="button-row">
            <button type="button" className="button button--primary" onClick={addStarter} disabled={busy}>
              Add six starter cards
            </button>
            <a className="button button--secondary" href={href('add')}>
              Write a card
            </a>
            <a className="button button--secondary" href={href('add/import')}>
              Import cards
            </a>
          </div>
        </section>
      ) : (
        <section className="panel review-panel" aria-labelledby="due-title">
          <div className="review-panel__count">
            {summary.dueCount > 0 ? (
              <>
                <h2 id="due-title" className="due-figure">
                  <span className="due-figure__number">{summary.dueCount}</span>
                  <span className="due-figure__label">{summary.dueCount === 1 ? 'card due' : 'cards due'}</span>
                </h2>
                <p className="muted">
                  {summary.dueEstablished} review{summary.dueEstablished === 1 ? '' : 's'} · {summary.dueNew} new
                </p>
              </>
            ) : (
              <>
                <h2 id="due-title" className="due-figure">
                  <span className="due-figure__label">You're caught up.</span>
                </h2>
                <p className="muted">
                  {summary.nextDueAt
                    ? `Next card due ${formatRelative(summary.nextDueAt, ws.now)} · ${formatDateTime(summary.nextDueAt, tz)}`
                    : summary.pausedCount > 0
                      ? 'Every remaining card is paused.'
                      : 'Nothing is scheduled.'}
                </p>
                <p>
                  <a href={href('add')}>Add knowledge</a> while you wait. Due times aren't moved forward to keep you busy—spacing
                  is the point.
                </p>
              </>
            )}
          </div>

          {summary.dueCount > 0 ? (
            <form
              className="review-panel__form"
              onSubmit={(e) => {
                e.preventDefault();
                void start(selectedTopic ? [selectedTopic] : null);
              }}
            >
              <Segmented
                legend="Session size"
                options={SESSION_SIZES.map((s) => ({ value: s, label: String(s) }))}
                value={size}
                onChange={(v) => v && setSize(v)}
                disabled={!!session}
              />
              <div className="field">
                <label className="field__label" htmlFor="topic-select">
                  Topics
                </label>
                <select id="topic-select" value={topic} onChange={(e) => setTopic(e.target.value)} disabled={!!session}>
                  <option value={ALL}>All topics, mixed ({summary.dueCount} due)</option>
                  {summary.topics.map((t) => (
                    <option key={t.topic} value={t.topic}>
                      {t.topic} ({t.due} due)
                    </option>
                  ))}
                </select>
              </div>
              {dueInSelection === 0 ? (
                <p className="field__hint" role="status">
                  No cards are due in {selectedTopic}.{' '}
                  {(() => {
                    const next = nextDueFor(ws.activeCards, ws.schedules, ws.now, selectedTopic);
                    return next ? `Its next card is due ${formatRelative(next, ws.now)}.` : '';
                  })()}{' '}
                  Choose “All topics” to practice what is due.
                </p>
              ) : null}
              <button
                type="submit"
                className="button button--primary button--large"
                disabled={busy || !!session || sessionCount === 0}
              >
                Start review{sessionCount > 0 ? ` · ${sessionCount} card${sessionCount === 1 ? '' : 's'}` : ''}
              </button>
            </form>
          ) : null}
        </section>
      )}

      {message ? (
        <Notice tone="info" onDismiss={() => setMessage(null)}>
          <p>{message}</p>
        </Notice>
      ) : null}

      {ws.activeCards.length > 0 ? (
        <StatList
          items={[
            { label: 'Reviewed today', value: summary.reviewsToday, note: summary.reviewsToday === 1 ? 'review' : 'reviews' },
            { label: 'Streak', value: summary.streak, note: summary.streak === 1 ? 'day' : 'days' },
            {
              label: 'Collection',
              value: summary.collectionSize,
              note: `card${summary.collectionSize === 1 ? '' : 's'}${summary.pausedCount ? ` · ${summary.pausedCount} paused` : ''}`,
            },
          ]}
        />
      ) : null}

      {backupIsStale(ws) ? (
        <Notice tone="warn" title="Back up your cards" live={false}>
          <p>
            Your collection lives only in this browser.{' '}
            {ws.lastBackupAt ? `Last backup ${formatDateTime(ws.lastBackupAt, tz)}.` : 'You haven’t made a backup yet.'}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="button button--secondary"
              onClick={async () => {
                await downloadFullBackup(ws);
                show('Backup downloaded. Keep the file somewhere safe.');
              }}
            >
              Download full backup
            </button>
            <a className="button button--quiet" href={href('settings')}>
              About backups
            </a>
          </div>
        </Notice>
      ) : null}

      {summary.topics.length > 0 ? (
        <section className="section" aria-labelledby="topics-title">
          <h2 id="topics-title" className="section__title">
            Topics
          </h2>
          <table className="table topic-table">
            <thead>
              <tr>
                <th scope="col">Topic</th>
                <th scope="col" className="num">
                  Cards
                </th>
                <th scope="col" className="num">
                  Due
                </th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.topics.map((t) => (
                <tr key={t.topic}>
                  <th scope="row">
                    <a href={href('collection', { topic: t.topic })}>{t.topic}</a>
                  </th>
                  <td className="num">{t.cards}</td>
                  <td className="num">{t.due}</td>
                  <td className="actions">
                    <button
                      type="button"
                      className="button button--quiet button--small"
                      disabled={t.due === 0 || busy || !!session}
                      onClick={() => void start([t.topic])}
                      aria-label={`Practice ${t.topic} (${t.due} due)`}
                    >
                      Practice
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <aside className="learning-note" aria-labelledby="note-title">
        <h2 id="note-title" className="eyebrow">
          From the method · {note.title}
        </h2>
        <p>{note.body}</p>
        <a href={href('method')}>Read about the method</a>
      </aside>
    </div>
  );
}
