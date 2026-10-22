// Full backup format (recall-backup v2). Unlike the content export, a backup
// carries schedules, review history, sessions, reflections, rubrics,
// assessments, and preferences. It never contains secrets or runtime caches.
//
// Version history: v1 had no quick checks; v2 adds card options, the
// quick-check counter, review and session modes, and recall-sm2-v2. Version 1
// backups are upgraded on restore (see src/domain/upgrade.ts).

import { BACKUP_MAX_BYTES, LIMITS, MAX_DISTRACTORS } from '../domain/limits';
import { QUICK_CHECK_LIMIT } from '../domain/scheduler';
import { isValidTimeZone } from '../domain/time';
import {
  CARD_KINDS,
  CONFIDENCE_LEVELS,
  PRACTICE_MODES,
  SCHEDULER_VERSION,
  SESSION_SIZES,
  SKIP_REASONS,
  type Assessment,
  type Card,
  type Preferences,
  type Reflection,
  type Review,
  type Rubric,
  type Schedule,
  type Session,
} from '../domain/types';
import { upgradeRecord } from '../domain/upgrade';

export const BACKUP_FORMAT = 'recall-backup';
export const BACKUP_FORMAT_VERSION = 2;

export interface WorkspaceData {
  cards: Card[];
  schedules: Schedule[];
  reviews: Review[];
  sessions: Session[];
  reflections: Reflection[];
  rubrics: Rubric[];
  assessments: Assessment[];
  preferences: Preferences | null;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  exportedAt: string;
  schedulerVersion: string;
  data: WorkspaceData;
}

export interface WorkspaceCounts {
  cards: number;
  deletedCards: number;
  schedules: number;
  reviews: number;
  sessions: number;
  reflections: number;
  rubrics: number;
  assessments: number;
}

export function countWorkspace(data: WorkspaceData): WorkspaceCounts {
  return {
    cards: data.cards.filter((c) => c.deletedAt === null).length,
    deletedCards: data.cards.filter((c) => c.deletedAt !== null).length,
    schedules: data.schedules.length,
    reviews: data.reviews.length,
    sessions: data.sessions.length,
    reflections: data.reflections.length,
    rubrics: data.rubrics.length,
    assessments: data.assessments.length,
  };
}

export function buildBackup(data: WorkspaceData, now: number): BackupFile {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date(now).toISOString(),
    schedulerVersion: SCHEDULER_VERSION,
    data,
  };
}

export type BackupValidation =
  { ok: true; data: WorkspaceData; counts: WorkspaceCounts; exportedAt: string | null } | { ok: false; errors: string[] };

export function checkBackupSize(bytes: number): string | null {
  if (bytes <= BACKUP_MAX_BYTES) return null;
  return `This file is ${(bytes / 1024 / 1024).toFixed(1)} MB. Backups up to 50 MB are supported. Nothing was changed.`;
}

export function parseBackupText(text: string): BackupValidation {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return { ok: false, errors: [`This file isn't valid JSON (${err instanceof Error ? err.message : String(err)}).`] };
  }
  return validateBackup(value);
}

// ---------------------------------------------------------------------------
// Validation helpers

const MAX_ERRORS = 25;

class Errors {
  list: string[] = [];
  overflow = 0;
  add(msg: string) {
    if (this.list.length < MAX_ERRORS) this.list.push(msg);
    else this.overflow += 1;
  }
  result(): string[] {
    return this.overflow ? [...this.list, `…and ${this.overflow} more problems.`] : this.list;
  }
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

interface V {
  e: Errors;
  path: string;
  o: Obj;
}

function str(v: V, key: string, opts: { nullable?: boolean; max?: number; nonEmpty?: boolean } = {}) {
  const x = v.o[key];
  if (x === null && opts.nullable) return;
  if (typeof x !== 'string') return v.e.add(`${v.path}.${key} must be ${opts.nullable ? 'text or null' : 'text'}.`);
  if (opts.nonEmpty && x.trim() === '') v.e.add(`${v.path}.${key} must not be empty.`);
  if (opts.max !== undefined && [...x].length > opts.max) v.e.add(`${v.path}.${key} exceeds ${opts.max} characters.`);
}

function num(v: V, key: string, opts: { nullable?: boolean; int?: boolean; min?: number; max?: number } = {}) {
  const x = v.o[key];
  if (x === null && opts.nullable) return;
  if (typeof x !== 'number' || !Number.isFinite(x)) return v.e.add(`${v.path}.${key} must be a number.`);
  if (opts.int && !Number.isInteger(x)) v.e.add(`${v.path}.${key} must be a whole number.`);
  if (opts.min !== undefined && x < opts.min) v.e.add(`${v.path}.${key} must be at least ${opts.min}.`);
  if (opts.max !== undefined && x > opts.max) v.e.add(`${v.path}.${key} must be at most ${opts.max}.`);
}

function oneOf(v: V, key: string, allowed: readonly unknown[], opts: { nullable?: boolean } = {}) {
  const x = v.o[key];
  if (x === null && opts.nullable) return;
  if (!allowed.includes(x)) v.e.add(`${v.path}.${key} has unsupported value ${JSON.stringify(x)}.`);
}

function bool(v: V, key: string) {
  if (typeof v.o[key] !== 'boolean') v.e.add(`${v.path}.${key} must be true or false.`);
}

function strArray(v: V, key: string, opts: { nullable?: boolean } = {}) {
  const x = v.o[key];
  if (x === null && opts.nullable) return;
  if (!Array.isArray(x) || x.some((s) => typeof s !== 'string')) v.e.add(`${v.path}.${key} must be a list of text.`);
}

function sub(v: V, key: string, opts: { nullable?: boolean } = {}): V | null {
  const x = v.o[key];
  if (x === null && opts.nullable) return null;
  if (!isObj(x)) {
    v.e.add(`${v.path}.${key} must be an object.`);
    return null;
  }
  return { e: v.e, path: `${v.path}.${key}`, o: x };
}

function checkChoices(v: V) {
  const c = sub(v, 'choices', { nullable: true });
  if (!c) return;
  str(c, 'correct', { max: LIMITS.choice, nonEmpty: true });
  const d = c.o.distractors;
  if (
    !Array.isArray(d) ||
    d.length < 1 ||
    d.length > MAX_DISTRACTORS ||
    d.some((x) => typeof x !== 'string' || x.trim() === '' || [...x].length > LIMITS.choice)
  ) {
    c.e.add(`${c.path}.distractors must list 1–${MAX_DISTRACTORS} options of up to ${LIMITS.choice} characters each.`);
  }
}

function checkContent(v: V) {
  str(v, 'topic', { max: LIMITS.topic });
  str(v, 'question', { max: LIMITS.question, nonEmpty: true });
  str(v, 'answer', { max: LIMITS.answer, nonEmpty: true });
  oneOf(v, 'kind', CARD_KINDS);
  str(v, 'source', { nullable: true, max: LIMITS.source });
  checkChoices(v);
}

function checkCard(v: V) {
  str(v, 'id', { nonEmpty: true });
  checkContent(v);
  num(v, 'contentVersion', { int: true, min: 1 });
  num(v, 'createdAt');
  num(v, 'updatedAt');
  num(v, 'deletedAt', { nullable: true });
}

function checkSnapshot(v: V | null) {
  if (!v) return;
  num(v, 'dueAt');
  num(v, 'intervalDays', { min: 0, max: 3650 });
  num(v, 'ease', { min: 1.3, max: 3.5 });
  num(v, 'reviewCount', { int: true, min: 0 });
  num(v, 'lapseCount', { int: true, min: 0 });
  num(v, 'stateVersion', { int: true, min: 0 });
}

function checkSchedule(v: V) {
  str(v, 'cardId', { nonEmpty: true });
  checkSnapshot(v);
  bool(v, 'paused');
  if (v.o.schedulerVersion !== SCHEDULER_VERSION) {
    v.e.add(
      `${v.path}.schedulerVersion ${JSON.stringify(v.o.schedulerVersion)} isn't supported by this app (expects ${SCHEDULER_VERSION}).`,
    );
  }
  num(v, 'lastReviewedAt', { nullable: true });
  num(v, 'quickChecksSinceRecall', { int: true, min: 0, max: QUICK_CHECK_LIMIT });
}

function checkReview(v: V) {
  str(v, 'id', { nonEmpty: true });
  str(v, 'cardId', { nonEmpty: true });
  num(v, 'cardVersion', { int: true, min: 1 });
  str(v, 'sessionId', { nullable: true });
  str(v, 'response', { max: LIMITS.response });
  oneOf(v, 'confidence', CONFIDENCE_LEVELS, { nullable: true });
  oneOf(v, 'mode', PRACTICE_MODES);
  if (v.o.mode === 'quick-check') {
    oneOf(v, 'rating', [null]);
    const q = sub(v, 'quickCheck');
    if (q) {
      const options = q.o.options;
      if (!Array.isArray(options) || options.length < 2 || options.some((o) => typeof o !== 'string')) {
        q.e.add(`${q.path}.options must be a list of at least two options.`);
      } else {
        num(q, 'picked', { int: true, min: 0, max: options.length - 1 });
      }
      bool(q, 'correct');
    }
  } else {
    oneOf(v, 'rating', [1, 2, 3, 4]);
    oneOf(v, 'quickCheck', [null]);
  }
  checkSnapshot(sub(v, 'before'));
  checkSnapshot(sub(v, 'after'));
  str(v, 'schedulerVersion');
  num(v, 'startedAt');
  num(v, 'revealedAt', { nullable: true });
  num(v, 'committedAt');
  const snap = sub(v, 'snapshot');
  if (snap) checkContent(snap);
}

function checkSession(v: V) {
  str(v, 'id', { nonEmpty: true });
  oneOf(v, 'mode', PRACTICE_MODES);
  strArray(v, 'topics', { nullable: true });
  num(v, 'size', { int: true, min: 1 });
  strArray(v, 'queue');
  num(v, 'index', { int: true, min: 0 });
  oneOf(v, 'status', ['active', 'completed', 'ended']);
  num(v, 'startedAt');
  num(v, 'endedAt', { nullable: true });
  const a = sub(v, 'attempt', { nullable: true });
  if (a) {
    str(a, 'id', { nonEmpty: true });
    str(a, 'cardId', { nonEmpty: true });
    num(a, 'cardVersion', { int: true, min: 1 });
    num(a, 'expectedStateVersion', { int: true, min: 0 });
    str(a, 'response', { max: LIMITS.response });
    oneOf(a, 'confidence', CONFIDENCE_LEVELS, { nullable: true });
    bool(a, 'revealed');
    num(a, 'startedAt');
    num(a, 'revealedAt', { nullable: true });
    strArray(a, 'options', { nullable: true });
    num(a, 'picked', { nullable: true, int: true, min: 0 });
  }
  if (!Array.isArray(v.o.results)) v.e.add(`${v.path}.results must be a list.`);
  else
    v.o.results.forEach((r, i) => {
      if (!isObj(r)) return v.e.add(`${v.path}.results[${i}] must be an object.`);
      const rv = { e: v.e, path: `${v.path}.results[${i}]`, o: r };
      str(rv, 'cardId');
      oneOf(rv, 'outcome', ['reviewed', 'skipped']);
      str(rv, 'reviewId', { nullable: true });
      oneOf(rv, 'rating', [1, 2, 3, 4], { nullable: true });
      oneOf(rv, 'reason', SKIP_REASONS, { nullable: true });
      num(rv, 'at');
    });
}

function checkReflection(v: V) {
  str(v, 'id', { nonEmpty: true });
  str(v, 'sessionId', { nullable: true });
  str(v, 'body', { max: LIMITS.reflection, nonEmpty: true });
  num(v, 'createdAt');
}

function checkWithId(v: V) {
  str(v, 'id', { nonEmpty: true });
}

function checkPreferences(v: V) {
  oneOf(v, 'schemaVersion', [1]);
  if (typeof v.o.timezone !== 'string' || !isValidTimeZone(v.o.timezone)) {
    v.e.add(`${v.path}.timezone ${JSON.stringify(v.o.timezone)} is not a recognized IANA timezone.`);
  }
  oneOf(v, 'readingSize', ['standard', 'large', 'larger']);
  oneOf(v, 'sessionSize', SESSION_SIZES);
  oneOf(v, 'aiMode', ['disabled']);
}

const COLLECTIONS = ['cards', 'schedules', 'reviews', 'sessions', 'reflections', 'rubrics', 'assessments'] as const;
type CollectionName = (typeof COLLECTIONS)[number];

const CHECKERS: Record<CollectionName, (v: V) => void> = {
  cards: checkCard,
  schedules: checkSchedule,
  reviews: checkReview,
  sessions: checkSession,
  reflections: checkReflection,
  rubrics: checkWithId,
  assessments: checkWithId,
};

export type RecordKind = CollectionName | 'preferences';

/** Validate one record with the same rules a restore uses. Returns the problems found, or [] when valid. */
export function validateRecord(kind: RecordKind, value: unknown): string[] {
  if (!isObj(value)) return [`${kind} record must be an object.`];
  const e = new Errors();
  const v = { e, path: kind, o: value };
  if (kind === 'preferences') checkPreferences(v);
  else CHECKERS[kind](v);
  return e.result();
}

/** Bring version 1 data to the current shape. Malformed entries are left for validation to report. */
function upgradeV1Data(data: Obj): Obj {
  const next: Obj = { ...data };
  for (const name of COLLECTIONS) {
    const list = data[name];
    if (Array.isArray(list)) next[name] = list.map((item) => upgradeRecord(name, item));
  }
  return next;
}

/** Dry-run validation. Nothing is written until the learner confirms a valid result. */
export function validateBackup(value: unknown): BackupValidation {
  const e = new Errors();
  if (!isObj(value)) return { ok: false, errors: ['A backup must be a JSON object.'] };

  if (value.format !== BACKUP_FORMAT) {
    if (Array.isArray(value) || 'cards' in value) {
      return {
        ok: false,
        errors: ['This looks like a content-only export, not a full backup. Import it from Add knowledge → Import instead.'],
      };
    }
    return { ok: false, errors: [`Unrecognized file: expected "format": "${BACKUP_FORMAT}".`] };
  }
  const version = value.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, errors: ['The backup has a missing or malformed formatVersion.'] };
  }
  if (version > BACKUP_FORMAT_VERSION) {
    return {
      ok: false,
      errors: [
        `This backup uses format version ${version}, which is newer than this app supports (version ${BACKUP_FORMAT_VERSION}). Update Recall before restoring it. Nothing was changed.`,
      ],
    };
  }
  if (!isObj(value.data)) return { ok: false, errors: ['The backup has no "data" object.'] };
  const data = version < 2 ? upgradeV1Data(value.data) : value.data;

  for (const name of COLLECTIONS) {
    const list = data[name];
    if (!Array.isArray(list)) {
      e.add(`data.${name} must be a list.`);
      continue;
    }
    const ids = new Set<string>();
    const idKey = name === 'schedules' ? 'cardId' : 'id';
    list.forEach((item, i) => {
      const path = `${name}[${i}]`;
      if (!isObj(item)) return e.add(`${path} must be an object.`);
      CHECKERS[name]({ e, path, o: item });
      const id = item[idKey];
      if (typeof id === 'string') {
        if (ids.has(id)) e.add(`${path} repeats ${idKey} ${id}.`);
        ids.add(id);
      }
    });
  }

  if (data.preferences !== null && data.preferences !== undefined) {
    if (!isObj(data.preferences)) e.add('data.preferences must be an object or null.');
    else checkPreferences({ e, path: 'preferences', o: data.preferences });
  }

  if (e.list.length === 0) {
    // Relationships: every card has exactly one schedule and every schedule has a card.
    const cards = data.cards as Card[];
    const schedules = data.schedules as Schedule[];
    const cardIds = new Set(cards.map((c) => c.id));
    const scheduled = new Set(schedules.map((s) => s.cardId));
    for (const s of schedules) if (!cardIds.has(s.cardId)) e.add(`A schedule refers to missing card ${s.cardId}.`);
    for (const c of cards) if (!scheduled.has(c.id)) e.add(`Card ${c.id} has no schedule.`);
    const sessions = data.sessions as Session[];
    if (sessions.filter((s) => s.status === 'active').length > 1) e.add('The backup has more than one active session.');
  }

  if (e.list.length > 0) return { ok: false, errors: e.result() };

  const workspace: WorkspaceData = {
    cards: data.cards as Card[],
    schedules: data.schedules as Schedule[],
    reviews: data.reviews as Review[],
    sessions: data.sessions as Session[],
    reflections: data.reflections as Reflection[],
    rubrics: data.rubrics as Rubric[],
    assessments: data.assessments as Assessment[],
    preferences: (data.preferences as Preferences | null | undefined) ?? null,
  };
  return {
    ok: true,
    data: workspace,
    counts: countWorkspace(workspace),
    exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : null,
  };
}
