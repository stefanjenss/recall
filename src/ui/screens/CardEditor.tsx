import { useEffect, useMemo, useState } from 'react';
import { useFlash } from '../../app/flash';
import { href, navigate } from '../../app/router';
import { useWorkspace } from '../../app/workspace';
import { validateCardInput } from '../../domain/limits';
import { formatInterval } from '../../domain/scheduler';
import { formatDateTime } from '../../domain/time';
import { CONFIDENCE_LABELS, RATING_LABELS, type Review } from '../../domain/types';
import { CardFields, formValuesFrom, type CardFormValues } from '../components/CardFields';
import { ConfirmDialog, Notice, PageHeader } from '../components/common';
import { cardStatus } from './Collection';

export function CardEditor({ cardId }: { cardId: string }) {
  const ws = useWorkspace();
  const { show } = useFlash();
  const tz = ws.preferences.timezone;
  const card = ws.cardsById.get(cardId);
  const schedule = ws.schedules.get(cardId);
  const [values, setValues] = useState<CardFormValues | null>(card ? formValuesFrom(card) : null);
  const [loadedVersion, setLoadedVersion] = useState(card?.contentVersion ?? 0);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'reset' | null>(null);
  const [history, setHistory] = useState<Review[]>([]);

  useEffect(() => {
    if (card && values === null) {
      setValues(formValuesFrom(card));
      setLoadedVersion(card.contentVersion);
    }
  }, [card, values]);

  useEffect(() => {
    void ws.repo.getCardReviews(cardId).then(setHistory);
  }, [ws.repo, cardId, ws.reviews.length]);

  const topics = useMemo(() => [...new Set(ws.activeCards.map((c) => c.topic))].sort(), [ws.activeCards]);

  if (ws.status === 'loading')
    return (
      <div className="screen">
        <p className="muted">Loading…</p>
      </div>
    );
  if (!card || card.deletedAt !== null || !values) {
    return (
      <div className="screen">
        <PageHeader title="Card not found" />
        <p>This card doesn’t exist or was deleted.</p>
        <p>
          <a href={href('collection')}>Back to the collection</a>
        </p>
      </div>
    );
  }

  const { value, errors } = validateCardInput(values);
  const dirty =
    value !== null &&
    (value.topic !== card.topic ||
      value.question !== card.question ||
      value.answer !== card.answer ||
      value.kind !== card.kind ||
      value.source !== card.source);
  const changedElsewhere = card.contentVersion !== loadedVersion;

  async function save() {
    setSubmitted(true);
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await ws.repo.updateCard(cardId, value, Date.now());
      setLoadedVersion(updated.contentVersion);
      setValues(formValuesFrom(updated));
      setSubmitted(false);
      await ws.refresh();
      show('Changes saved. The schedule is unchanged.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await ws.refresh();
      show(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  return (
    <div className="screen editor">
      <p className="back-link">
        <a href={href('collection')}>← Collection</a>
      </p>
      <PageHeader title="Edit card" kicker={`${card.topic} · version ${card.contentVersion}`} />

      {changedElsewhere ? (
        <Notice tone="warn" title="This card changed in another tab">
          <p>Saving will replace those changes with what’s in this form.</p>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setValues(formValuesFrom(card));
              setLoadedVersion(card.contentVersion);
            }}
          >
            Load the latest version
          </button>
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="error" onDismiss={() => setError(null)}>
          <p>{error}</p>
        </Notice>
      ) : null}

      <div className="editor__layout">
        <form
          className="editor__form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          noValidate
        >
          <CardFields
            values={values}
            onChange={setValues}
            errors={errors}
            topics={topics}
            showErrors={submitted || errors.some((e) => e.message.includes('limit'))}
          />
          <div className="button-row">
            <button type="submit" className="button button--primary" disabled={busy || !dirty}>
              Save changes
            </button>
            <button
              type="button"
              className="button button--quiet"
              disabled={busy || !dirty}
              onClick={() => setValues(formValuesFrom(card))}
            >
              Discard changes
            </button>
          </div>
          <p className="field__hint">Editing wording keeps the card’s schedule. Past reviews keep the version they answered.</p>
        </form>

        <aside className="editor__side" aria-labelledby="schedule-title">
          <h2 id="schedule-title" className="section__title">
            Schedule
          </h2>
          {schedule ? (
            <dl className="facts">
              <div>
                <dt>Status</dt>
                <dd>{cardStatus(card, schedule, ws.now, tz)}</dd>
              </div>
              <div>
                <dt>Due</dt>
                <dd>{formatDateTime(schedule.dueAt, tz, { year: 'numeric' })}</dd>
              </div>
              <div>
                <dt>Interval</dt>
                <dd>{schedule.reviewCount === 0 ? 'New' : formatInterval(schedule.intervalDays)}</dd>
              </div>
              <div>
                <dt>Ease</dt>
                <dd>{schedule.ease.toFixed(2)}</dd>
              </div>
              <div>
                <dt>Reviews</dt>
                <dd>{schedule.reviewCount}</dd>
              </div>
              <div>
                <dt>Lapses</dt>
                <dd>{schedule.lapseCount}</dd>
              </div>
              <div>
                <dt>Scheduler</dt>
                <dd>
                  <code>{schedule.schedulerVersion}</code>
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatDateTime(card.createdAt, tz, { year: 'numeric' })}</dd>
              </div>
            </dl>
          ) : null}
          <div className="stack">
            <button
              type="button"
              className="button button--secondary"
              disabled={busy || !schedule}
              onClick={() =>
                act(
                  () => ws.repo.setPaused(cardId, !schedule!.paused),
                  schedule!.paused
                    ? 'Card resumed. Its due time and history are unchanged.'
                    : 'Card paused. It won’t appear in practice.',
                )
              }
            >
              {schedule?.paused ? 'Resume card' : 'Pause card'}
            </button>
            <button type="button" className="button button--secondary" disabled={busy} onClick={() => setConfirm('reset')}>
              Reset learning progress
            </button>
            <button type="button" className="button button--danger-quiet" disabled={busy} onClick={() => setConfirm('delete')}>
              Delete card
            </button>
          </div>

          <h2 className="section__title">Review history</h2>
          {history.length === 0 ? (
            <p className="muted">Not reviewed yet.</p>
          ) : (
            <ol className="history">
              {history.slice(0, 20).map((r) => (
                <li key={r.id}>
                  <span>{formatDateTime(r.committedAt, tz, { year: 'numeric' })}</span>
                  <span>
                    <strong>{RATING_LABELS[r.rating]}</strong>
                    {r.confidence ? ` · felt ${CONFIDENCE_LABELS[r.confidence].toLowerCase()}` : ''}
                    {r.cardVersion !== card.contentVersion ? ` · v${r.cardVersion}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>

      <ConfirmDialog
        open={confirm === 'reset'}
        title="Reset learning progress?"
        confirmLabel="Reset progress"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => act(() => ws.repo.resetProgress(cardId, Date.now()), 'Progress reset. The card is new and due now.')}
      >
        <p>The card will start over as new and become due now. Its review history stays in Progress.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete this card?"
        confirmLabel="Delete card"
        tone="danger"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setBusy(true);
          await ws.repo.deleteCard(cardId, Date.now());
          await ws.refresh();
          setBusy(false);
          setConfirm(null);
          navigate('collection');
          show('Card deleted. Its past reviews still count in Progress.');
        }}
      >
        <p>
          “{card.question.slice(0, 120)}
          {card.question.length > 120 ? '…' : ''}” will be removed from your collection and from practice. Past reviews remain in
          your progress history. To erase everything, use Delete all data in Settings.
        </p>
      </ConfirmDialog>
    </div>
  );
}
