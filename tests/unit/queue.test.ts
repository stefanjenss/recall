import { describe, expect, it } from 'vitest';
import { buildQueue, ineligibility, type CardWithSchedule } from '../../src/domain/queue';
import { initialSchedule } from '../../src/domain/scheduler';
import type { Card } from '../../src/domain/types';

const NOW = Date.UTC(2026, 9, 12, 18, 0, 0);
const HOUR = 3_600_000;

function item(
  id: string,
  topic: string,
  opts: { dueAt?: number; reviewCount?: number; paused?: boolean; deleted?: boolean } = {},
): CardWithSchedule {
  const card: Card = {
    id,
    topic,
    question: `Q ${id}`,
    answer: `A ${id}`,
    kind: 'recall',
    source: null,
    contentVersion: 1,
    createdAt: NOW - 100 * HOUR,
    updatedAt: NOW - 100 * HOUR,
    deletedAt: opts.deleted ? NOW - HOUR : null,
  };
  const schedule = {
    ...initialSchedule(id, NOW),
    dueAt: opts.dueAt ?? NOW - HOUR,
    reviewCount: opts.reviewCount ?? 0,
    intervalDays: opts.reviewCount ? 3 : 0,
    paused: opts.paused ?? false,
  };
  return { card, schedule };
}

describe('buildQueue', () => {
  it('AC05: established due cards precede new cards; paused, deleted, and future cards are excluded', () => {
    const items = [
      item('new-a', 'SQL', { dueAt: NOW - 50 * HOUR }),
      item('est-1', 'SQL', { reviewCount: 2, dueAt: NOW - 2 * HOUR }),
      item('est-2', 'Python', { reviewCount: 3, dueAt: NOW - 3 * HOUR }),
      item('est-3', 'SQL', { reviewCount: 1, dueAt: NOW - 4 * HOUR }),
      item('paused', 'Python', { reviewCount: 2, paused: true }),
      item('deleted', 'Python', { reviewCount: 2, deleted: true }),
      item('future', 'Python', { reviewCount: 2, dueAt: NOW + HOUR }),
      item('new-b', 'Python', { dueAt: NOW - 40 * HOUR }),
    ];
    const queue = buildQueue(items, { now: NOW, size: 20, topics: null });
    expect(queue).toEqual(['est-3', 'est-2', 'est-1', 'new-b', 'new-a']);
    // New cards follow every established due card. Among new cards, new-b (Python) comes
    // before the older new-a because the preceding card was SQL.
  });

  it('alternates topics within a group when possible, otherwise keeps due order', () => {
    const items = [
      item('a1', 'A', { dueAt: NOW - 10 * HOUR }),
      item('a2', 'A', { dueAt: NOW - 9 * HOUR }),
      item('a3', 'A', { dueAt: NOW - 8 * HOUR }),
      item('b1', 'B', { dueAt: NOW - 1 * HOUR }),
    ];
    expect(buildQueue(items, { now: NOW, size: 20, topics: null })).toEqual(['a1', 'b1', 'a2', 'a3']);
  });

  it('a single-topic group is valid and stays in due order', () => {
    const items = [item('x2', 'A', { dueAt: NOW - 1 * HOUR }), item('x1', 'A', { dueAt: NOW - 2 * HOUR })];
    expect(buildQueue(items, { now: NOW, size: 20, topics: null })).toEqual(['x1', 'x2']);
  });

  it('breaks due-time ties by ID for a stable order', () => {
    const items = [item('b', 'T', { dueAt: NOW - HOUR }), item('a', 'T', { dueAt: NOW - HOUR })];
    expect(buildQueue(items, { now: NOW, size: 20, topics: null })).toEqual(['a', 'b']);
  });

  it('fills up to the session size, established first', () => {
    const items = [
      ...Array.from({ length: 4 }, (_, i) => item(`e${i}`, i % 2 ? 'A' : 'B', { reviewCount: 1, dueAt: NOW - (10 - i) * HOUR })),
      ...Array.from({ length: 4 }, (_, i) => item(`n${i}`, 'A', { dueAt: NOW - (20 - i) * HOUR })),
    ];
    const queue = buildQueue(items, { now: NOW, size: 5, topics: null });
    expect(queue).toHaveLength(5);
    expect(queue.slice(0, 4).every((id) => id.startsWith('e'))).toBe(true);
    expect(queue[4]).toBe('n0');
  });

  it('respects a topic filter', () => {
    const items = [item('s', 'SQL'), item('p', 'Python')];
    expect(buildQueue(items, { now: NOW, size: 20, topics: ['Python'] })).toEqual(['p']);
    expect(buildQueue(items, { now: NOW, size: 20, topics: ['Rust'] })).toEqual([]);
  });

  it('never repeats a card', () => {
    const items = Array.from({ length: 30 }, (_, i) => item(`c${i}`, `T${i % 3}`, { dueAt: NOW - i * HOUR }));
    const queue = buildQueue(items, { now: NOW, size: 20, topics: null });
    expect(new Set(queue).size).toBe(queue.length);
  });
});

describe('ineligibility', () => {
  it('reports why a queued card can no longer be practiced', () => {
    const ok = item('ok', 'A');
    expect(ineligibility(ok.card, ok.schedule, NOW)).toBeNull();
    const p = item('p', 'A', { paused: true });
    expect(ineligibility(p.card, p.schedule, NOW)).toBe('paused');
    const d = item('d', 'A', { deleted: true });
    expect(ineligibility(d.card, d.schedule, NOW)).toBe('deleted');
    const f = item('f', 'A', { dueAt: NOW + HOUR });
    expect(ineligibility(f.card, f.schedule, NOW)).toBe('not-due');
    expect(ineligibility(undefined, undefined, NOW)).toBe('deleted');
  });
});
