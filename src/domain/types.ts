// Core domain types. Timestamps are UTC milliseconds; intervals are days.

export type CardKind = 'recall' | 'apply' | 'compare' | 'explain';
export const CARD_KINDS: readonly CardKind[] = ['recall', 'apply', 'compare', 'explain'];

export type Rating = 1 | 2 | 3 | 4;
export const RATINGS: readonly Rating[] = [1, 2, 3, 4];

export type Confidence = 'unsure' | 'somewhat' | 'confident';
export const CONFIDENCE_LEVELS: readonly Confidence[] = ['unsure', 'somewhat', 'confident'];

/** v2 keeps every v1 rating rule and adds the quick-check rule (docs/PRD.md section 8). */
export const SCHEDULER_VERSION = 'recall-sm2-v2';
export type SchedulerVersion = typeof SCHEDULER_VERSION;

/** Full recall: answer from memory and self-rate. Quick check: pick from multiple-choice options. */
export type PracticeMode = 'recall' | 'quick-check';
export const PRACTICE_MODES: readonly PracticeMode[] = ['recall', 'quick-check'];

/**
 * Optional multiple-choice options for quick checks. The reference answer
 * stays the full explanation; `correct` is its short multiple-choice form.
 */
export interface CardChoices {
  correct: string;
  /** One to three wrong options. */
  distractors: string[];
}

export interface Card {
  id: string;
  topic: string;
  question: string;
  answer: string;
  kind: CardKind;
  source: string | null;
  choices: CardChoices | null;
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
  choices: CardChoices | null;
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
  /** Quick checks since the last full-recall review. At the limit, only full recall is allowed. */
  quickChecksSinceRecall: number;
}

export interface ScheduleSnapshot {
  dueAt: number;
  intervalDays: number;
  ease: number;
  reviewCount: number;
  lapseCount: number;
  stateVersion: number;
}

export interface QuickCheckResult {
  /** The options in the order they were shown. */
  options: string[];
  /** Index into `options` of the learner's pick. */
  picked: number;
  correct: boolean;
}

interface ReviewBase {
  /** Equal to the attempt ID; doubles as the idempotency key. */
  id: string;
  cardId: string;
  cardVersion: number;
  sessionId: string | null;
  response: string;
  confidence: Confidence | null;
  before: ScheduleSnapshot;
  after: ScheduleSnapshot;
  /** The scheduler that computed `after`. Reviews from before quick checks keep "recall-sm2-v1". */
  schedulerVersion: string;
  startedAt: number;
  revealedAt: number | null;
  committedAt: number;
  /** Content as it was answered, so history survives edits and deletion. */
  snapshot: CardContent;
}

export interface RecallReview extends ReviewBase {
  mode: 'recall';
  /** Self-reported. */
  rating: Rating;
  quickCheck: null;
}

/** A multiple-choice check: graded by the pick, with no self-rating. */
export interface QuickCheckReview extends ReviewBase {
  mode: 'quick-check';
  rating: null;
  quickCheck: QuickCheckResult;
}

export type Review = RecallReview | QuickCheckReview;

export interface Attempt {
  id: string;
  cardId: string;
  cardVersion: number;
  expectedStateVersion: number;
  response: string;
  confidence: Confidence | null;
  /** For a quick check, true once an option is picked. */
  revealed: boolean;
  startedAt: number;
  revealedAt: number | null;
  /** Quick check only: the options in display order (shuffled once, so a reload keeps the order). */
  options: string[] | null;
  /** Quick check only: index into `options` of the pick. */
  picked: number | null;
}

/** `recall-only`: a quick-check session card that lost its options or reached the quick-check limit. */
export type SkipReason = 'deleted' | 'paused' | 'not-due' | 'reviewed-elsewhere' | 'recall-only';
export const SKIP_REASONS: readonly SkipReason[] = ['deleted', 'paused', 'not-due', 'reviewed-elsewhere', 'recall-only'];

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
  mode: PracticeMode;
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

export const MODE_LABELS: Record<PracticeMode, string> = {
  recall: 'Full recall',
  'quick-check': 'Quick check',
};

export const MODE_DESCRIPTIONS: Record<PracticeMode, string> = {
  recall: 'Answer from memory, then rate yourself',
  'quick-check': 'Multiple choice · recognition, not recall',
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  unsure: 'Unsure',
  somewhat: 'Somewhat',
  confident: 'Confident',
};
