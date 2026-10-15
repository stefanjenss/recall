// recall-sm2-v2: an app-specific SM-2-inspired heuristic. It is not Anki's
// algorithm and not FSRS. The rules are specified in docs/PRD.md section 8.
// v2 keeps every v1 rating rule unchanged and adds the quick-check rule.
//
// Everything here is pure: callers supply the current time.

import { SCHEDULER_VERSION, type Rating, type Schedule, type ScheduleSnapshot } from './types';

export const DAY_MS = 86_400_000;
export const AGAIN_INTERVAL_DAYS = 10 / 1440;
export const MAX_INTERVAL_DAYS = 3650;
export const INITIAL_EASE = 2.5;
export const MIN_EASE = 1.3;
export const MAX_EASE = 3.5;
/** Consecutive quick checks allowed before a card needs a full recall again. */
export const QUICK_CHECK_LIMIT = 2;
/** A correct quick check brings a card back in at most this many days. */
export const QUICK_CHECK_MAX_DAYS = 2;

export interface SchedulingState {
  intervalDays: number;
  ease: number;
  reviewCount: number;
  lapseCount: number;
}

/** Ease is kept to two decimals so repeated adjustments don't accumulate float drift. */
function roundEase(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Compute the next interval and ease using the previous values (before counts increment). */
export function nextSchedulingState(prev: SchedulingState, rating: Rating): SchedulingState {
  const I = prev.intervalDays;
  const E = prev.ease;
  const R = prev.reviewCount;
  const fresh = R === 0 || I < 1;

  let interval: number;
  let ease: number;
  switch (rating) {
    case 1:
      interval = AGAIN_INTERVAL_DAYS;
      ease = Math.max(MIN_EASE, E - 0.2);
      break;
    case 2:
      interval = fresh ? 1 : Math.max(1, Math.round(I * 1.2));
      ease = Math.max(MIN_EASE, E - 0.15);
      break;
    case 3:
      interval = fresh ? 1 : Math.max(I + 1, Math.round(I * E));
      ease = E;
      break;
    case 4:
      interval = fresh ? 4 : Math.max(I + 1, Math.round(I * E * 1.3));
      ease = Math.min(MAX_EASE, E + 0.15);
      break;
  }

  return {
    intervalDays: Math.min(MAX_INTERVAL_DAYS, interval),
    ease: roundEase(ease),
    reviewCount: R + 1,
    lapseCount: prev.lapseCount + (rating === 1 ? 1 : 0),
  };
}

export function dueAtFor(intervalDays: number, now: number): number {
  return now + Math.round(intervalDays * DAY_MS);
}

/** Apply a committed rating at `now`. The due time is computed from commit time. */
export function applyRating(schedule: Schedule, rating: Rating, now: number): Schedule {
  const next = nextSchedulingState(schedule, rating);
  return {
    ...schedule,
    ...next,
    dueAt: dueAtFor(next.intervalDays, now),
    schedulerVersion: SCHEDULER_VERSION,
    stateVersion: schedule.stateVersion + 1,
    lastReviewedAt: now,
    quickChecksSinceRecall: 0,
  };
}

/** Days until a card returns after a correct quick check: 1, or 2 once its interval is at least 2 days. */
export function quickCheckDelayDays(intervalDays: number): number {
  return Math.min(QUICK_CHECK_MAX_DAYS, Math.max(1, Math.floor(intervalDays)));
}

/**
 * Apply a quick check (multiple choice) at `now`. Recognizing the answer is
 * weaker evidence than recalling it, so a correct pick never grows the
 * interval, changes ease, or counts as a review: it only brings the card back
 * in 1–2 days. A wrong pick is a real miss and is applied exactly as Again.
 */
export function applyQuickCheck(schedule: Schedule, correct: boolean, now: number): Schedule {
  const quickChecksSinceRecall = schedule.quickChecksSinceRecall + 1;
  if (!correct) return { ...applyRating(schedule, 1, now), quickChecksSinceRecall };
  return {
    ...schedule,
    dueAt: dueAtFor(quickCheckDelayDays(schedule.intervalDays), now),
    schedulerVersion: SCHEDULER_VERSION,
    stateVersion: schedule.stateVersion + 1,
    lastReviewedAt: now,
    quickChecksSinceRecall,
  };
}

/** Days until the card is due after a quick check, from the same function used when committing. */
export function previewQuickCheck(schedule: Schedule, correct: boolean, now: number): number {
  return (applyQuickCheck(schedule, correct, now).dueAt - now) / DAY_MS;
}

export interface IntervalPreview {
  rating: Rating;
  intervalDays: number;
  dueAt: number;
}

/** Previews come from the same function used when committing. */
export function previewRatings(schedule: Schedule, now: number): IntervalPreview[] {
  return ([1, 2, 3, 4] as const).map((rating) => {
    const next = applyRating(schedule, rating, now);
    return { rating, intervalDays: next.intervalDays, dueAt: next.dueAt };
  });
}

export function initialSchedule(cardId: string, now: number): Schedule {
  return {
    cardId,
    dueAt: now,
    intervalDays: 0,
    ease: INITIAL_EASE,
    reviewCount: 0,
    lapseCount: 0,
    paused: false,
    schedulerVersion: SCHEDULER_VERSION,
    stateVersion: 0,
    lastReviewedAt: null,
    quickChecksSinceRecall: 0,
  };
}

export function snapshotOf(schedule: Schedule): ScheduleSnapshot {
  return {
    dueAt: schedule.dueAt,
    intervalDays: schedule.intervalDays,
    ease: schedule.ease,
    reviewCount: schedule.reviewCount,
    lapseCount: schedule.lapseCount,
    stateVersion: schedule.stateVersion,
  };
}

/** Human-readable interval, e.g. "10 min", "1 day", "25 days", "3.4 months". */
export function formatInterval(days: number): string {
  const minutes = Math.round(days * 1440);
  if (minutes < 60) return `${minutes} min`;
  if (days < 1) {
    const hours = Math.round(minutes / 60);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const d = Math.round(days);
  if (d < 60) return `${d} ${d === 1 ? 'day' : 'days'}`;
  if (d < 365) return `${(d / 30.44).toFixed(1)} months`;
  return `${(d / 365.25).toFixed(1)} years`;
}
