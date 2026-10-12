import { useDeferredValue, useMemo, useState } from 'react';
import { href, navigate } from '../../app/router';
import { useWorkspace } from '../../app/workspace';
import { isDue, isNew } from '../../domain/queue';
import { formatDateTime, formatRelative } from '../../domain/time';
import { KIND_LABELS, type Card, type Schedule } from '../../domain/types';
import { downloadContentExport } from '../backupActions';
import { PageHeader } from '../components/common';
import { plainExcerpt } from '../markdown';

export type StatusFilter = 'all' | 'due' | 'new' | 'paused';

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: 'All cards',
  due: 'Due now',
  new: 'New',
  paused: 'Paused',
};

const PAGE = 100;

export function cardStatus(card: Card, schedule: Schedule | undefined, now: number, timeZone: string): string {
  if (!schedule) return 'No schedule';
  if (schedule.paused) return 'Paused';
  if (isDue(card, schedule, now)) return isNew(schedule) ? 'New · due now' : 'Due now';
  return `Due ${formatRelative(schedule.dueAt, now)} · ${formatDateTime(schedule.dueAt, timeZone, { weekday: undefined, hour: undefined, minute: undefined })}`;
}

export function Collection({ params }: { params: URLSearchParams }) {
  const ws = useWorkspace();
  const tz = ws.preferences.timezone;
  const [query, setQuery] = useState(params.get('q') ?? '');
  const topic = params.get('topic') ?? '';
  const status = (params.get('status') as StatusFilter | null) ?? 'all';
  const [limit, setLimit] = useState(PAGE);
  const deferredQuery = useDeferredValue(query);

  const topics = useMemo(
    () => [...new Set(ws.activeCards.map((c) => c.topic))].sort((a, b) => a.localeCompare(b)),
    [ws.activeCards],
  );

  const index = useMemo(
    () => ws.activeCards.map((card) => ({ card, haystack: `${card.question}\n${card.answer}\n${card.topic}`.toLowerCase() })),
    [ws.activeCards],
  );

  const results = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return index
      .filter(({ card, haystack }) => {
        if (topic && card.topic !== topic) return false;
        const s = ws.schedules.get(card.id);
        if (status === 'due' && !(s && isDue(card, s, ws.now))) return false;
        if (status === 'new' && !(s && isNew(s) && !s.paused)) return false;
        if (status === 'paused' && !s?.paused) return false;
        return !q || haystack.includes(q);
      })
      .map(({ card }) => card)
      .sort((a, b) => a.topic.localeCompare(b.topic) || b.createdAt - a.createdAt);
  }, [index, deferredQuery, topic, status, ws.schedules, ws.now]);

  const setFilter = (key: 'topic' | 'status', value: string) => {
    setLimit(PAGE);
    const next: Record<string, string | null> = {
      q: query.trim() || null,
      topic: topic || null,
      status: status !== 'all' ? status : null,
    };
    next[key] = value && value !== 'all' ? value : null;
    navigate('collection', next, { replace: true });
  };

  const filtered = !!(deferredQuery.trim() || topic || status !== 'all');

  return (
    <div className="screen collection">
      <PageHeader title="Collection" kicker={`${ws.activeCards.length} card${ws.activeCards.length === 1 ? '' : 's'}`}>
        <a className="button button--primary" href={href('add')}>
          Add card
        </a>
        <a className="button button--secondary" href={href('add/import')}>
          Import
        </a>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => downloadContentExport(ws)}
          disabled={ws.activeCards.length === 0}
        >
          Export cards
        </button>
      </PageHeader>

      <form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
        <div className="field filters__search">
          <label htmlFor="search" className="field__label">
            Search
          </label>
          <input
            id="search"
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE);
            }}
            placeholder="Questions, answers, topics"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="filter-topic" className="field__label">
            Topic
          </label>
          <select id="filter-topic" value={topic} onChange={(e) => setFilter('topic', e.target.value)}>
            <option value="">All topics</option>
            {topics.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-status" className="field__label">
            Status
          </label>
          <select id="filter-status" value={status} onChange={(e) => setFilter('status', e.target.value)}>
            {(Object.keys(STATUS_LABELS) as StatusFilter[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </form>

      <p className="results-count" role="status">
        {filtered
          ? `${results.length} matching card${results.length === 1 ? '' : 's'}`
          : `${results.length} card${results.length === 1 ? '' : 's'}`}
      </p>

      {ws.activeCards.length === 0 ? (
        <div className="panel empty-state">
          <h2>No cards yet</h2>
          <p>
            <a href={href('add')}>Write a card</a>, <a href={href('add/import')}>import some</a>, or add the starter set from{' '}
            <a href={href('')}>Today</a>.
          </p>
        </div>
      ) : results.length === 0 ? (
        <div className="panel empty-state">
          <h2>No matching cards</h2>
          <p>Try a different search, or clear the filters.</p>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setQuery('');
              navigate('collection', {}, { replace: true });
            }}
          >
            Clear search and filters
          </button>
        </div>
      ) : (
        <>
          <ul className="card-list">
            {results.slice(0, limit).map((card) => (
              <li key={card.id}>
                <a className="card-row" href={href(`collection/${card.id}`)}>
                  <span className="card-row__question">{plainExcerpt(card.question, 200)}</span>
                  <span className="card-row__meta">
                    <span>{card.topic}</span>
                    <span aria-hidden="true">·</span>
                    <span>{KIND_LABELS[card.kind]}</span>
                    <span aria-hidden="true">·</span>
                    <span className={ws.schedules.get(card.id)?.paused ? 'tag tag--paused' : ''}>
                      {cardStatus(card, ws.schedules.get(card.id), ws.now, tz)}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
          {results.length > limit ? (
            <button type="button" className="button button--secondary" onClick={() => setLimit((l) => l + PAGE)}>
              Show {Math.min(PAGE, results.length - limit)} more
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
