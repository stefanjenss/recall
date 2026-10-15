import { describe, expect, it } from 'vitest';
import { buildQueue, ineligibility, type CardWithSchedule } from '../../src/domain/queue';
import { initialSchedule } from '../../src/domain/scheduler';
import { canQuickCheck, sameChoices, shuffledOptions } from '../../src/domain/choices';
import type { Card, CardChoices } from '../../src/domain/types';

const CHOICES: CardChoices = { correct: 'right', distractors: ['wrong 1', 'wrong 2', 'wrong 3'] };

const NOW = Date.UTC(2026, 9, 12, 18, 0, 0);
const HOUR = 3_600_000;

function item(
  id: string,
  topic: string,
  opts: {
    dueAt?: number;
    reviewCount?: number;
    paused?: boolean;
    deleted?: boolean;
    choices?: CardChoices | null;
    quickChecks?: number;
  } = {},
): CardWithSchedule {
  const card: Card = {
    id,
    topic,
    question: `Q ${id}`,
    answer: `A ${id}`,
    kind: 'recall',
    source: null,
    choices: opts.choices ?? null,
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
    quickChecksSinceRecall: opts.quickChecks ?? 0,
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

describe('quick-check eligibility', () => {
  it('a quick-check queue takes only due cards with options that are under the limit', () => {
    const items = [
      item('with-options', 'SQL', { choices: CHOICES }),
      item('no-options', 'SQL'),
      item('at-limit', 'SQL', { choices: CHOICES, quickChecks: 2 }),
      item('one-used', 'Python', { choices: CHOICES, quickChecks: 1 }),
      item('future', 'SQL', { choices: CHOICES, dueAt: NOW + HOUR }),
    ];
    expect(buildQueue(items, { now: NOW, size: 20, topics: null, mode: 'quick-check' }).sort()).toEqual([
      'one-used',
      'with-options',
    ]);
    expect(buildQueue(items, { now: NOW, size: 20, topics: null })).toHaveLength(4);
  });

  it('a card that loses its options or reaches the limit mid-session is recall-only', () => {
    const atLimit = item('a', 'SQL', { choices: CHOICES, quickChecks: 2 });
    expect(ineligibility(atLimit.card, atLimit.schedule, NOW, 'quick-check')).toBe('recall-only');
    expect(ineligibility(atLimit.card, atLimit.schedule, NOW, 'recall')).toBeNull();
    const plain = item('b', 'SQL');
    expect(ineligibility(plain.card, plain.schedule, NOW, 'quick-check')).toBe('recall-only');
    expect(canQuickCheck(item('c', 'SQL', { choices: CHOICES }).card, plain.schedule)).toBe(true);
  });
});

describe('options', () => {
  it('shuffles every option exactly once, driven by the supplied random function', () => {
    const seq = [0.9, 0.1, 0.5];
    let i = 0;
    const shuffled = shuffledOptions(CHOICES, () => seq[i++ % seq.length]!);
    expect([...shuffled].sort()).toEqual(['right', 'wrong 1', 'wrong 2', 'wrong 3']);
    expect(shuffledOptions(CHOICES, () => 0.999)).toEqual(['right', 'wrong 1', 'wrong 2', 'wrong 3']);
    expect(shuffledOptions(CHOICES, () => 0)).not.toEqual(['right', 'wrong 1', 'wrong 2', 'wrong 3']);
  });

  it('compares options by value and order', () => {
    expect(sameChoices(CHOICES, { ...CHOICES, distractors: [...CHOICES.distractors] })).toBe(true);
    expect(sameChoices(CHOICES, { ...CHOICES, distractors: ['wrong 2', 'wrong 1', 'wrong 3'] })).toBe(false);
    expect(sameChoices(CHOICES, null)).toBe(false);
    expect(sameChoices(null, null)).toBe(true);
  });
});
