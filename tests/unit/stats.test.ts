import { describe, expect, it } from 'vitest';
import { initialSchedule } from '../../src/domain/scheduler';
import { nextDueFor, percent, summarizeProgress, summarizeToday } from '../../src/domain/stats';
import type { Card, Confidence, Rating, Review, Schedule } from '../../src/domain/types';

const NOW = Date.UTC(2026, 9, 12, 18, 0); // Oct 12, 14:00 in New York
const DAY = 86_400_000;
const NY = 'America/New_York';

function card(id: string, topic: string, deleted = false): Card {
  return {
    id,
    topic,
    question: id,
    answer: 'a',
    kind: 'recall',
    source: null,
    contentVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: deleted ? 1 : null,
  };
}

function review(i: number, committedAt: number, rating: Rating, confidence: Confidence | null = null): Review {
  const snap = { dueAt: 0, intervalDays: 0, ease: 2.5, reviewCount: 0, lapseCount: 0, stateVersion: 0 };
  return {
    id: `r${i}`,
    cardId: 'a',
    cardVersion: 1,
    sessionId: null,
    response: '',
    confidence,
    rating,
    before: snap,
    after: snap,
    schedulerVersion: 'recall-sm2-v1',
    startedAt: committedAt,
    revealedAt: committedAt,
    committedAt,
    snapshot: { topic: 'T', question: 'q', answer: 'a', kind: 'recall', source: null },
  };
}

describe('summarizeToday', () => {
  const cards = [card('a', 'SQL'), card('b', 'SQL'), card('c', 'Python'), card('d', 'Python'), card('gone', 'SQL', true)];
  const schedules = new Map<string, Schedule>([
    ['a', { ...initialSchedule('a', NOW - DAY) }], // new, due
    ['b', { ...initialSchedule('b', 0), reviewCount: 2, intervalDays: 3, dueAt: NOW - 1 }], // established, due
    ['c', { ...initialSchedule('c', 0), reviewCount: 1, intervalDays: 1, dueAt: NOW + 2 * 3_600_000 }], // future
    ['d', { ...initialSchedule('d', 0), paused: true }], // paused
    ['gone', { ...initialSchedule('gone', 0) }],
  ]);

  it('counts due, new, paused, and collection size from active cards only', () => {
    const reviews = [review(1, NOW - 3_600_000, 3), review(2, NOW - DAY, 3)];
    const s = summarizeToday(cards, schedules, reviews, NOW, NY);
    expect(s).toMatchObject({
      dueCount: 2,
      dueEstablished: 1,
      dueNew: 1,
      collectionSize: 4,
      pausedCount: 1,
      reviewsToday: 1,
      streak: 2,
    });
    expect(s.nextDueAt).toBe(NOW + 2 * 3_600_000);
    expect(s.topics).toEqual([
      { topic: 'Python', cards: 2, due: 0, newCards: 0, paused: 1 },
      { topic: 'SQL', cards: 2, due: 2, newCards: 1, paused: 0 },
    ]);
  });

  it('finds the next due time for a topic, ignoring paused and deleted cards', () => {
    expect(nextDueFor(cards, schedules, NOW, 'Python')).toBe(NOW + 2 * 3_600_000);
    expect(nextDueFor(cards, schedules, NOW, 'SQL')).toBeNull();
  });
});

describe('AC17: summarizeProgress', () => {
  it('derives every count and denominator from stored review events', () => {
    const reviews = [
      review(1, NOW - 60_000, 4, 'confident'),
      review(2, NOW - 120_000, 1, 'confident'),
      review(3, NOW - DAY, 3, 'unsure'),
      review(4, NOW - 3 * DAY, 2),
      review(5, NOW - 30 * DAY, 3, 'somewhat'), // outside the 14-day window, still in lifetime totals
    ];
    const cards = [card('a', 'SQL'), card('b', 'SQL'), card('gone', 'SQL', true)];
    const schedules = new Map<string, Schedule>([
      ['a', { ...initialSchedule('a', 0), intervalDays: 25 }],
      ['b', { ...initialSchedule('b', 0), intervalDays: 3 }],
      ['gone', { ...initialSchedule('gone', 0), intervalDays: 100 }],
    ]);
    const p = summarizeProgress(cards, schedules, reviews, NOW, NY, 14);

    expect(p.totalReviews).toBe(5);
    expect(p.reviewsToday).toBe(2);
    expect(p.reviewsInWindow).toBe(4);
    expect(p.activity).toHaveLength(14);
    expect(p.activity.at(-1)).toEqual({ day: '2026-10-12', count: 2 });
    expect(p.activity.reduce((n, d) => n + d.count, 0)).toBe(p.reviewsInWindow);
    expect(p.ratingCounts).toEqual({ 1: 1, 2: 1, 3: 2, 4: 1 });
    expect(p.goodOrEasy).toEqual({ count: 3, total: 5 });
    expect(p.longIntervals).toEqual({ count: 1, total: 2 }); // deleted cards excluded
    expect(p.calibration.confident).toEqual({ count: 1, total: 2 });
    expect(p.calibration.unsure).toEqual({ count: 1, total: 1 });
    expect(p.withoutConfidence).toBe(1);
    expect(p.streak).toBe(2);
  });

  it('shows no percentage without a denominator', () => {
    expect(percent({ count: 0, total: 0 })).toBe('—');
    expect(percent({ count: 1, total: 3 })).toBe('33%');
  });
});
