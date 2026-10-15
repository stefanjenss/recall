// Upgrades records written before quick checks existed (storage schema 1,
// backup format 1, scheduler recall-sm2-v1) to the current shape. Used by the
// IndexedDB migration and when restoring an older backup. Pure and idempotent:
// fields that are already present are kept as they are.

import { SCHEDULER_VERSION } from './types';

export const LEGACY_SCHEDULER_VERSION = 'recall-sm2-v1';

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Cards (and review snapshots) gain `choices: null`: no multiple-choice options. */
export function upgradeCard(card: Rec): Rec {
  return card.choices === undefined ? { ...card, choices: null } : card;
}

/**
 * recall-sm2-v2 applies every v1 rating rule unchanged and only adds the
 * quick-check rule, so a v1 schedule is a valid v2 schedule with no quick
 * checks yet. Any other scheduler version is left alone for validation to reject.
 */
export function upgradeSchedule(schedule: Rec): Rec {
  return {
    ...schedule,
    schedulerVersion: schedule.schedulerVersion === LEGACY_SCHEDULER_VERSION ? SCHEDULER_VERSION : schedule.schedulerVersion,
    quickChecksSinceRecall: schedule.quickChecksSinceRecall ?? 0,
  };
}

/** Every earlier review was a full-recall review. Its recorded schedulerVersion stays as history. */
export function upgradeReview(review: Rec): Rec {
  return {
    ...review,
    mode: review.mode ?? 'recall',
    quickCheck: review.quickCheck ?? null,
    snapshot: isRec(review.snapshot) ? upgradeCard(review.snapshot) : review.snapshot,
  };
}

/** Every earlier session was a full-recall session. */
export function upgradeSession(session: Rec): Rec {
  const attempt = isRec(session.attempt)
    ? { ...session.attempt, options: session.attempt.options ?? null, picked: session.attempt.picked ?? null }
    : session.attempt;
  return { ...session, mode: session.mode ?? 'recall', attempt };
}
