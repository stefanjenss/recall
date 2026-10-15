// Progress metrics derived only from committed, stored review events.

import { canQuickCheck } from './choices';
import { isActive, isDue, isNew } from './queue';
import { currentStreak, dayKey, lastNDays } from './time';
import type { Card, Confidence, Rating, Review, Schedule } from './types';

export const LONG_INTERVAL_DAYS = 21;

export interface TopicSummary {
  topic: string;
  cards: number;
  due: number;
  /** Due cards that can be quick-checked now. */
  quickCheckDue: number;
  newCards: number;
  paused: number;
}

export interface TodaySummary {
  dueCount: number;
  dueEstablished: number;
  dueNew: number;
  /** Due cards a quick check can take: they have options and are under the quick-check limit. */
  dueQuickCheck: number;
  /** Due cards with options that need a full recall first (quick-check limit reached). */
  dueRecallOnly: number;
  /** Due cards without options. */
  dueNoOptions: number;
  reviewsToday: number;
  streak: number;
  collectionSize: number;
  pausedCount: number;
  nextDueAt: number | null;
  topics: TopicSummary[];
}

export function summarizeToday(
  cards: Card[],
  schedules: Map<string, Schedule>,
  reviews: Review[],
  now: number,
  timeZone: string,
): TodaySummary {
  const today = dayKey(now, timeZone);
  const topics = new Map<string, TopicSummary>();
  let dueCount = 0;
  let dueEstablished = 0;
  let dueNew = 0;
  let dueQuickCheck = 0;
  let dueRecallOnly = 0;
  let dueNoOptions = 0;
  let collectionSize = 0;
  let pausedCount = 0;
  let nextDueAt: number | null = null;

  for (const card of cards) {
    if (!isActive(card)) continue;
    const schedule = schedules.get(card.id);
    if (!schedule) continue;
    collectionSize += 1;
    let t = topics.get(card.topic);
    if (!t) {
      t = { topic: card.topic, cards: 0, due: 0, quickCheckDue: 0, newCards: 0, paused: 0 };
      topics.set(card.topic, t);
    }
    t.cards += 1;
    if (schedule.paused) {
      pausedCount += 1;
      t.paused += 1;
      continue;
    }
    if (isNew(schedule)) t.newCards += 1;
    if (isDue(card, schedule, now)) {
      dueCount += 1;
      t.due += 1;
      if (isNew(schedule)) dueNew += 1;
      else dueEstablished += 1;
      if (canQuickCheck(card, schedule)) {
        dueQuickCheck += 1;
        t.quickCheckDue += 1;
      } else if (card.choices) dueRecallOnly += 1;
      else dueNoOptions += 1;
    } else if (nextDueAt === null || schedule.dueAt < nextDueAt) {
      nextDueAt = schedule.dueAt;
    }
  }

  let reviewsToday = 0;
  for (const r of reviews) if (dayKey(r.committedAt, timeZone) === today) reviewsToday += 1;

  return {
    dueCount,
    dueEstablished,
    dueNew,
    dueQuickCheck,
    dueRecallOnly,
    dueNoOptions,
    reviewsToday,
    streak: currentStreak(
      reviews.map((r) => r.committedAt),
      now,
      timeZone,
    ),
    collectionSize,
    pausedCount,
    nextDueAt,
    topics: [...topics.values()].sort((a, b) => a.topic.localeCompare(b.topic)),
  };
}

/** Next due time among unpaused cards matching `topic` (or any topic). */
export function nextDueFor(cards: Card[], schedules: Map<string, Schedule>, now: number, topic: string | null): number | null {
  let next: number | null = null;
  for (const card of cards) {
    if (!isActive(card) || (topic !== null && card.topic !== topic)) continue;
    const s = schedules.get(card.id);
    if (!s || s.paused || s.dueAt <= now) continue;
    if (next === null || s.dueAt < next) next = s.dueAt;
  }
  return next;
}

export interface DayActivity {
  day: string;
  count: number;
}

export interface RatioStat {
  count: number;
  total: number;
}

export interface ProgressSummary {
  /** Every committed review: full recalls and quick checks. */
  totalReviews: number;
  /** Full-recall reviews, the only ones with a self-rating. */
  recallReviews: number;
  /** Quick checks answered correctly, out of all quick checks. */
  quickChecks: RatioStat;
  reviewsToday: number;
  reviewsInWindow: number;
  activity: DayActivity[];
  streak: number;
  ratingCounts: Record<Rating, number>;
  goodOrEasy: RatioStat;
  longIntervals: RatioStat;
  calibration: Record<Confidence, RatioStat>;
  withoutConfidence: number;
}

export function summarizeProgress(
  cards: Card[],
  schedules: Map<string, Schedule>,
  reviews: Review[],
  now: number,
  timeZone: string,
  windowDays = 14,
): ProgressSummary {
  const today = dayKey(now, timeZone);
  const days = lastNDays(today, windowDays);
  const counts = new Map(days.map((d) => [d, 0]));
  const ratingCounts: Record<Rating, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const calibration: Record<Confidence, RatioStat> = {
    unsure: { count: 0, total: 0 },
    somewhat: { count: 0, total: 0 },
    confident: { count: 0, total: 0 },
  };
  let withoutConfidence = 0;
  let reviewsToday = 0;
  let recallReviews = 0;
  const quickChecks: RatioStat = { count: 0, total: 0 };

  for (const r of reviews) {
    const key = dayKey(r.committedAt, timeZone);
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    if (key === today) reviewsToday += 1;
    if (r.mode === 'quick-check') {
      quickChecks.total += 1;
      if (r.quickCheck.correct) quickChecks.count += 1;
      continue;
    }
    recallReviews += 1;
    ratingCounts[r.rating] += 1;
    if (r.confidence) {
      const c = calibration[r.confidence];
      c.total += 1;
      if (r.rating >= 3) c.count += 1;
    } else {
      withoutConfidence += 1;
    }
  }

  let activeCards = 0;
  let longCount = 0;
  for (const card of cards) {
    if (!isActive(card)) continue;
    const s = schedules.get(card.id);
    if (!s) continue;
    activeCards += 1;
    if (s.intervalDays >= LONG_INTERVAL_DAYS) longCount += 1;
  }

  const activity = days.map((day) => ({ day, count: counts.get(day) ?? 0 }));
  return {
    totalReviews: reviews.length,
    recallReviews,
    quickChecks,
    reviewsToday,
    reviewsInWindow: activity.reduce((sum, d) => sum + d.count, 0),
    activity,
    streak: currentStreak(
      reviews.map((r) => r.committedAt),
      now,
      timeZone,
    ),
    ratingCounts,
    goodOrEasy: { count: ratingCounts[3] + ratingCounts[4], total: recallReviews },
    longIntervals: { count: longCount, total: activeCards },
    calibration,
    withoutConfidence,
  };
}

export function percent({ count, total }: RatioStat): string {
  if (total === 0) return '—';
  return `${Math.round((count / total) * 100)}%`;
}
