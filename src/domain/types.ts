// Core domain types. Timestamps are UTC milliseconds; intervals are days.

export type CardKind = 'recall' | 'apply' | 'compare' | 'explain';
export const CARD_KINDS: readonly CardKind[] = ['recall', 'apply', 'compare', 'explain'];

export type Rating = 1 | 2 | 3 | 4;
export const RATINGS: readonly Rating[] = [1, 2, 3, 4];

export type Confidence = 'unsure' | 'somewhat' | 'confident';
export const CONFIDENCE_LEVELS: readonly Confidence[] = ['unsure', 'somewhat', 'confident'];

export const SCHEDULER_VERSION = 'recall-sm2-v1';
export type SchedulerVersion = typeof SCHEDULER_VERSION;

export interface Card {
  id: string;
  topic: string;
  question: string;
  answer: string;
  kind: CardKind;
  source: string | null;
  /** Incremented on every content edit so attempts keep the version they answered. */
  contentVersion: number;
  createdAt: number;
  updatedAt: number;
  /** Soft delete. Deleted cards never enter practice; review history keeps its snapshots. */
  deletedAt: number | null;
}

/** The fields a learner authors. */
export interface CardContent {
  topic: string;
  question: string;
  answer: string;
  kind: CardKind;
  source: string | null;
}

export interface Schedule {
  cardId: string;
  dueAt: number;
  intervalDays: number;
  ease: number;
  reviewCount: number;
  lapseCount: number;
  paused: boolean;
  schedulerVersion: SchedulerVersion;
  /** Optimistic-concurrency token. Incremented on every schedule change. */
  stateVersion: number;
  lastReviewedAt: number | null;
}

export interface ScheduleSnapshot {
  dueAt: number;
  intervalDays: number;
  ease: number;
  reviewCount: number;
  lapseCount: number;
  stateVersion: number;
}

export interface Review {
  /** Equal to the attempt ID; doubles as the idempotency key. */
  id: string;
  cardId: string;
  cardVersion: number;
  sessionId: string | null;
  response: string;
  confidence: Confidence | null;
  rating: Rating;
  before: ScheduleSnapshot;
  after: ScheduleSnapshot;
  schedulerVersion: SchedulerVersion;
  startedAt: number;
  revealedAt: number | null;
  committedAt: number;
  /** Content as it was answered, so history survives edits and deletion. */
  snapshot: CardContent;
}

export interface Attempt {
  id: string;
  cardId: string;
  cardVersion: number;
  expectedStateVersion: number;
  response: string;
  confidence: Confidence | null;
  revealed: boolean;
  startedAt: number;
  revealedAt: number | null;
}

export type SkipReason = 'deleted' | 'paused' | 'not-due' | 'reviewed-elsewhere';

export interface SessionResult {
  cardId: string;
  outcome: 'reviewed' | 'skipped';
  reviewId: string | null;
  rating: Rating | null;
  reason: SkipReason | null;
  at: number;
}

export type SessionStatus = 'active' | 'completed' | 'ended';

export interface Session {
  id: string;
  /** null means all topics. */
  topics: string[] | null;
  size: number;
  /** Captured at start; never reordered while the learner is answering. */
  queue: string[];
  index: number;
  status: SessionStatus;
  startedAt: number;
  endedAt: number | null;
  attempt: Attempt | null;
  results: SessionResult[];
}

export interface Reflection {
  id: string;
  sessionId: string | null;
  body: string;
  createdAt: number;
}

export type ReadingSize = 'standard' | 'large' | 'larger';
export type SessionSize = 5 | 10 | 20;
export const SESSION_SIZES: readonly SessionSize[] = [5, 10, 20];
export type AiMode = 'disabled';

export interface Preferences {
  schemaVersion: 1;
  timezone: string;
  readingSize: ReadingSize;
  sessionSize: SessionSize;
  aiMode: AiMode;
}

// Reserved for P1 grading. Stores exist and are carried in backups so the
// format does not need to change when grading arrives.
export interface RubricCriterion {
  id: string;
  description: string;
  weight: number;
  requiredConcepts: string[];
  acceptableAlternatives: string[];
}

export interface Rubric {
  id: string;
  cardId: string;
  version: number;
  criteria: RubricCriterion[];
  criticalMisconceptions: string[];
  reviewed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Assessment {
  id: string;
  attemptId: string;
  cardId: string;
  cardVersion: number;
  rubricVersion: number;
  createdAt: number;
  [key: string]: unknown;
}

export const KIND_LABELS: Record<CardKind, string> = {
  recall: 'Recall',
  apply: 'Apply',
  compare: 'Compare',
  explain: 'Explain',
};

export const KIND_DESCRIPTIONS: Record<CardKind, string> = {
  recall: 'Retrieve a fact, definition, or rule',
  apply: 'Use an idea in a concrete scenario',
  compare: 'Distinguish related ideas or approaches',
  explain: 'Say why or how something works',
};

export const RATING_LABELS: Record<Rating, string> = {
  1: 'Again',
  2: 'Hard',
  3: 'Good',
  4: 'Easy',
};

export const RATING_DESCRIPTIONS: Record<Rating, string> = {
  1: 'Missed it',
  2: 'Partly, with effort',
  3: 'Recalled it',
  4: 'Instantly',
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  unsure: 'Unsure',
  somewhat: 'Somewhat',
  confident: 'Confident',
};
