// The only module that reads or writes IndexedDB. Every multi-record change
// runs in a single transaction, so a crash or closed tab leaves either the
// whole change or none of it.

import type { IDBPTransaction } from 'idb';
import type { WorkspaceData } from '../content/backup';
import { newId } from '../domain/ids';
import { duplicateKey, LIMITS, overLimitMessage, validateCardInput } from '../domain/limits';
import { buildQueue, ineligibility } from '../domain/queue';
import { applyRating, initialSchedule, snapshotOf } from '../domain/scheduler';
import { browserTimeZone, isValidTimeZone } from '../domain/time';
import type {
  Attempt,
  Card,
  CardContent,
  Confidence,
  Preferences,
  Rating,
  Reflection,
  Review,
  Schedule,
  Session,
  SkipReason,
} from '../domain/types';
import { ALL_STORES, DB_NAME, openRecallDb, type RecallDb, type RecallSchema, type StoreName } from './db';

export function defaultPreferences(): Preferences {
  return {
    schemaVersion: 1,
    timezone: browserTimeZone(),
    readingSize: 'standard',
    sessionSize: 20,
    aiMode: 'disabled',
  };
}

export class ValidationError extends Error {}

export interface WorkspaceSnapshot {
  cards: Card[];
  schedules: Schedule[];
  reviews: Review[];
  reflections: Reflection[];
  activeSession: Session | null;
  preferences: Preferences;
  lastBackupAt: number | null;
}

export interface PracticeState {
  session: Session;
  /** The card for the current attempt, read in the same transaction. */
  card: Card | null;
  schedule: Schedule | null;
}

export type StartResult =
  | { status: 'started'; state: PracticeState }
  | { status: 'active-exists'; session: Session }
  | { status: 'empty' };

export type CommitResult =
  | { status: 'committed' | 'duplicate'; review: Review; state: PracticeState }
  | { status: 'stale'; reason: 'session-changed' | 'reviewed-elsewhere' | 'edited'; state: PracticeState | null }
  | { status: 'ineligible'; reason: 'deleted' | 'paused'; state: PracticeState };

export type AddCardsResult =
  | { status: 'added'; cardIds: string[] }
  | { status: 'already-imported'; cardIds: string[] };

type Tx<S extends StoreName[], M extends IDBTransactionMode> = IDBPTransaction<RecallSchema, S, M>;

const SESSION_STORES: ['cards', 'schedules', 'sessions'] = ['cards', 'schedules', 'sessions'];
type SessionTx = Tx<typeof SESSION_STORES, 'readwrite'>;

export interface RepositoryOptions {
  onVersionChange?: () => void;
}

export function createRepository(name: string = DB_NAME, options: RepositoryOptions = {}) {
  let dbPromise: Promise<RecallDb> | null = null;
  const db = () => (dbPromise ??= openRecallDb(name, { onVersionChange: options.onVersionChange }));

  async function run<S extends StoreName[], M extends IDBTransactionMode, T>(
    stores: S,
    mode: M,
    fn: (tx: Tx<S, M>) => Promise<T>,
  ): Promise<T> {
    const d = await db();
    const tx = d.transaction(stores, mode);
    try {
      const result = await fn(tx);
      await tx.done;
      return result;
    } catch (err) {
      tx.done.catch(() => undefined);
      try {
        tx.abort();
      } catch {
        // already finished
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Workspace

  async function loadWorkspace(): Promise<WorkspaceSnapshot> {
    return run(['cards', 'schedules', 'reviews', 'reflections', 'sessions', 'meta'], 'readonly', async (tx) => {
      const [cards, schedules, reviews, reflections, active, prefs, lastBackup] = await Promise.all([
        tx.objectStore('cards').getAll(),
        tx.objectStore('schedules').getAll(),
        tx.objectStore('reviews').index('byCommittedAt').getAll(),
        tx.objectStore('reflections').index('byCreatedAt').getAll(),
        tx.objectStore('sessions').index('byStatus').getAll('active'),
        tx.objectStore('meta').get('preferences'),
        tx.objectStore('meta').get('lastBackupAt'),
      ]);
      return {
        cards,
        schedules,
        reviews,
        reflections,
        activeSession: active[0] ?? null,
        preferences: normalizePreferences(prefs?.value),
        lastBackupAt: typeof lastBackup?.value === 'number' ? lastBackup.value : null,
      };
    });
  }

  function normalizePreferences(value: unknown): Preferences {
    const base = defaultPreferences();
    if (!value || typeof value !== 'object') return base;
    const v = value as Partial<Preferences>;
    return {
      schemaVersion: 1,
      timezone: typeof v.timezone === 'string' && isValidTimeZone(v.timezone) ? v.timezone : base.timezone,
      readingSize: v.readingSize === 'large' || v.readingSize === 'larger' ? v.readingSize : 'standard',
      sessionSize: v.sessionSize === 5 || v.sessionSize === 10 ? v.sessionSize : 20,
      aiMode: 'disabled',
    };
  }

  async function savePreferences(prefs: Preferences): Promise<void> {
    await run(['meta'], 'readwrite', async (tx) => {
      await tx.objectStore('meta').put({ key: 'preferences', value: prefs });
    });
  }

  async function setLastBackupAt(ts: number): Promise<void> {
    await run(['meta'], 'readwrite', async (tx) => {
      await tx.objectStore('meta').put({ key: 'lastBackupAt', value: ts });
    });
  }

  // -------------------------------------------------------------------------
  // Cards

  function validated(content: CardContent): CardContent {
    const { value, errors } = validateCardInput(content);
    if (!value) throw new ValidationError(errors.map((e) => e.message).join(' '));
    return value;
  }

  function newCard(content: CardContent, now: number): Card {
    return { id: newId(), ...content, contentVersion: 1, createdAt: now, updatedAt: now, deletedAt: null };
  }

  /**
   * Add cards atomically. With a batchId, retrying the same request returns the
   * original result instead of adding the cards a second time.
   */
  async function addCards(contents: CardContent[], now: number, batchId?: string): Promise<AddCardsResult> {
    const clean = contents.map(validated);
    return run(['cards', 'schedules', 'importBatches'], 'readwrite', async (tx) => {
      if (batchId) {
        const prior = await tx.objectStore('importBatches').get(batchId);
        if (prior) return { status: 'already-imported', cardIds: prior.cardIds };
      }
      const cardIds: string[] = [];
      for (const content of clean) {
        const card = newCard(content, now);
        await tx.objectStore('cards').add(card);
        await tx.objectStore('schedules').add(initialSchedule(card.id, now));
        cardIds.push(card.id);
      }
      if (batchId) await tx.objectStore('importBatches').add({ id: batchId, committedAt: now, cardIds });
      return { status: 'added', cardIds };
    });
  }

  /** Add only cards whose question isn't already in the collection (used for the starter set). */
  async function addMissingCards(contents: CardContent[], now: number): Promise<{ added: number; skipped: number }> {
    const clean = contents.map(validated);
    return run(['cards', 'schedules'], 'readwrite', async (tx) => {
      const existing = await tx.objectStore('cards').getAll();
      const keys = new Set(existing.filter((c) => c.deletedAt === null).map((c) => duplicateKey(c.question)));
      let added = 0;
      for (const content of clean) {
        const k = duplicateKey(content.question);
        if (keys.has(k)) continue;
        keys.add(k);
        const card = newCard(content, now);
        await tx.objectStore('cards').add(card);
        await tx.objectStore('schedules').add(initialSchedule(card.id, now));
        added += 1;
      }
      return { added, skipped: clean.length - added };
    });
  }

  /** Content edits keep the schedule and bump contentVersion. */
  async function updateCard(cardId: string, content: CardContent, now: number): Promise<Card> {
    const clean = validated(content);
    return run(['cards'], 'readwrite', async (tx) => {
      const card = await tx.objectStore('cards').get(cardId);
      if (!card || card.deletedAt !== null) throw new ValidationError('This card no longer exists.');
      const changed =
        card.topic !== clean.topic ||
        card.question !== clean.question ||
        card.answer !== clean.answer ||
        card.kind !== clean.kind ||
        card.source !== clean.source;
      if (!changed) return card;
      const next: Card = { ...card, ...clean, contentVersion: card.contentVersion + 1, updatedAt: now };
      await tx.objectStore('cards').put(next);
      return next;
    });
  }

  async function mutateSchedule(cardId: string, fn: (s: Schedule) => Schedule): Promise<Schedule> {
    return run(['schedules'], 'readwrite', async (tx) => {
      const s = await tx.objectStore('schedules').get(cardId);
      if (!s) throw new ValidationError('This card has no schedule.');
      const next = { ...fn(s), stateVersion: s.stateVersion + 1 };
      await tx.objectStore('schedules').put(next);
      return next;
    });
  }

  /** Pausing excludes a card from practice; resuming keeps its due time and history. */
  function setPaused(cardId: string, paused: boolean): Promise<Schedule> {
    return mutateSchedule(cardId, (s) => ({ ...s, paused }));
  }

  /** Start the card over as new. Review history is kept. */
  function resetProgress(cardId: string, now: number): Promise<Schedule> {
    return mutateSchedule(cardId, (s) => ({ ...initialSchedule(cardId, now), paused: s.paused, stateVersion: s.stateVersion }));
  }

  async function deleteCard(cardId: string, now: number): Promise<void> {
    await run(['cards'], 'readwrite', async (tx) => {
      const card = await tx.objectStore('cards').get(cardId);
      if (!card || card.deletedAt !== null) return;
      await tx.objectStore('cards').put({ ...card, deletedAt: now, updatedAt: now });
    });
  }

  async function getCardReviews(cardId: string): Promise<Review[]> {
    const d = await db();
    const list = await d.getAllFromIndex('reviews', 'byCard', cardId);
    return list.sort((a, b) => b.committedAt - a.committedAt);
  }

  // -------------------------------------------------------------------------
  // Sessions

  async function loadState(tx: SessionTx, session: Session): Promise<PracticeState> {
    if (!session.attempt) return { session, card: null, schedule: null };
    const [card, schedule] = await Promise.all([
      tx.objectStore('cards').get(session.attempt.cardId),
      tx.objectStore('schedules').get(session.attempt.cardId),
    ]);
    return { session, card: card ?? null, schedule: schedule ?? null };
  }

  function skip(session: Session, cardId: string, reason: SkipReason, now: number) {
    session.results.push({ cardId, outcome: 'skipped', reviewId: null, rating: null, reason, at: now });
    session.index += 1;
    session.attempt = null;
  }

  /**
   * Move to the next practicable card, skipping (and recording) queued cards
   * that were paused, deleted, or reviewed elsewhere since the session began.
   */
  async function advance(tx: SessionTx, session: Session, now: number): Promise<PracticeState> {
    while (session.index < session.queue.length) {
      const cardId = session.queue[session.index]!;
      const [card, schedule] = await Promise.all([
        tx.objectStore('cards').get(cardId),
        tx.objectStore('schedules').get(cardId),
      ]);
      const reason = ineligibility(card, schedule, now);
      if (reason || !card || !schedule) {
        skip(session, cardId, reason ?? 'deleted', now);
        continue;
      }
      session.attempt = {
        id: newId(),
        cardId,
        cardVersion: card.contentVersion,
        expectedStateVersion: schedule.stateVersion,
        response: '',
        confidence: null,
        revealed: false,
        startedAt: now,
        revealedAt: null,
      };
      return { session, card, schedule };
    }
    session.status = 'completed';
    session.endedAt = now;
    session.attempt = null;
    return { session, card: null, schedule: null };
  }

  async function getActiveSession(): Promise<Session | null> {
    const d = await db();
    const list = await d.getAllFromIndex('sessions', 'byStatus', 'active');
    return list[0] ?? null;
  }

  async function getSession(id: string): Promise<Session | null> {
    const d = await db();
    return (await d.get('sessions', id)) ?? null;
  }

  async function startSession(opts: { topics: string[] | null; size: number; now: number }): Promise<StartResult> {
    return run(SESSION_STORES, 'readwrite', async (tx) => {
      const active = await tx.objectStore('sessions').index('byStatus').getAll('active');
      if (active[0]) return { status: 'active-exists', session: active[0] };
      const [cards, schedules] = await Promise.all([
        tx.objectStore('cards').getAll(),
        tx.objectStore('schedules').getAll(),
      ]);
      const byId = new Map(schedules.map((s) => [s.cardId, s]));
      const items = cards.flatMap((card) => {
        const schedule = byId.get(card.id);
        return schedule ? [{ card, schedule }] : [];
      });
      const queue = buildQueue(items, { now: opts.now, size: opts.size, topics: opts.topics });
      if (queue.length === 0) return { status: 'empty' };
      const session: Session = {
        id: newId(),
        topics: opts.topics,
        size: opts.size,
        queue,
        index: 0,
        status: 'active',
        startedAt: opts.now,
        endedAt: null,
        attempt: null,
        results: [],
      };
      const state = await advance(tx, session, opts.now);
      await tx.objectStore('sessions').add(session);
      return { status: 'started', state };
    });
  }

  /** Return the current attempt, creating one if the session has none yet. */
  async function ensureAttempt(sessionId: string, now: number): Promise<PracticeState | null> {
    return run(SESSION_STORES, 'readwrite', async (tx) => {
      const session = await tx.objectStore('sessions').get(sessionId);
      if (!session) return null;
      if (session.status !== 'active') return { session, card: null, schedule: null };
      if (session.attempt && session.attempt.cardId === session.queue[session.index]) {
        return loadState(tx, session);
      }
      const state = await advance(tx, session, now);
      await tx.objectStore('sessions').put(session);
      return state;
    });
  }

  function matchAttempt(session: Session | undefined, attemptId: string): Attempt | null {
    if (!session || session.status !== 'active' || session.attempt?.id !== attemptId) return null;
    return session.attempt;
  }

  /** Persist the in-progress answer. Ignored once the attempt is revealed or replaced. */
  async function saveDraft(
    sessionId: string,
    attemptId: string,
    draft: { response: string; confidence: Confidence | null },
  ): Promise<boolean> {
    return run(['sessions'], 'readwrite', async (tx) => {
      const session = await tx.objectStore('sessions').get(sessionId);
      const attempt = matchAttempt(session, attemptId);
      if (!session || !attempt || attempt.revealed) return false;
      session.attempt = { ...attempt, response: draft.response, confidence: draft.confidence };
      await tx.objectStore('sessions').put(session);
      return true;
    });
  }

  /** Freeze the response and confidence for this attempt and reveal the answer. */
  async function reveal(
    sessionId: string,
    attemptId: string,
    draft: { response: string; confidence: Confidence | null },
    now: number,
  ): Promise<PracticeState | null> {
    const tooLong = overLimitMessage('Your answer', draft.response, LIMITS.response);
    if (tooLong) throw new ValidationError(tooLong);
    return run(SESSION_STORES, 'readwrite', async (tx) => {
      const session = await tx.objectStore('sessions').get(sessionId);
      const attempt = matchAttempt(session, attemptId);
      if (!session || !attempt) return session ? loadState(tx, session) : null;
      if (!attempt.revealed) {
        session.attempt = { ...attempt, response: draft.response, confidence: draft.confidence, revealed: true, revealedAt: now };
        await tx.objectStore('sessions').put(session);
      }
      return loadState(tx, session);
    });
  }

  /**
   * Commit a rating: insert the review, advance the schedule, and move the
   * session forward in one transaction. The attempt ID is the idempotency key,
   * and the schedule's stateVersion guards against concurrent reviews.
   */
  async function commitReview(sessionId: string, attemptId: string, rating: Rating, now: number): Promise<CommitResult> {
    return run(['cards', 'schedules', 'sessions', 'reviews'], 'readwrite', async (tx) => {
      const sessionTx = tx as unknown as SessionTx;
      const existing = await tx.objectStore('reviews').get(attemptId);
      const session = await tx.objectStore('sessions').get(sessionId);
      if (existing) {
        return { status: 'duplicate', review: existing, state: session ? await loadState(sessionTx, session) : emptyState(existing) };
      }
      const attempt = matchAttempt(session, attemptId);
      if (!session || !attempt) {
        return { status: 'stale', reason: 'session-changed', state: session ? await loadState(sessionTx, session) : null };
      }
      if (!attempt.revealed) throw new ValidationError('Reveal the answer before rating.');

      const [card, schedule] = await Promise.all([
        tx.objectStore('cards').get(attempt.cardId),
        tx.objectStore('schedules').get(attempt.cardId),
      ]);
      const state: PracticeState = { session, card: card ?? null, schedule: schedule ?? null };
      if (!card || !schedule || card.deletedAt !== null) return { status: 'ineligible', reason: 'deleted', state };
      if (schedule.paused) return { status: 'ineligible', reason: 'paused', state };
      if (schedule.stateVersion !== attempt.expectedStateVersion) return { status: 'stale', reason: 'reviewed-elsewhere', state };
      if (card.contentVersion !== attempt.cardVersion) return { status: 'stale', reason: 'edited', state };

      const after = applyRating(schedule, rating, now);
      const review: Review = {
        id: attempt.id,
        cardId: card.id,
        cardVersion: card.contentVersion,
        sessionId: session.id,
        response: attempt.response,
        confidence: attempt.confidence,
        rating,
        before: snapshotOf(schedule),
        after: snapshotOf(after),
        schedulerVersion: after.schedulerVersion,
        startedAt: attempt.startedAt,
        revealedAt: attempt.revealedAt,
        committedAt: now,
        snapshot: { topic: card.topic, question: card.question, answer: card.answer, kind: card.kind, source: card.source },
      };
      // `add` (not `put`) so a second insert with the same key fails the whole transaction.
      await tx.objectStore('reviews').add(review);
      await tx.objectStore('schedules').put(after);
      session.results.push({ cardId: card.id, outcome: 'reviewed', reviewId: review.id, rating, reason: null, at: now });
      session.index += 1;
      session.attempt = null;
      const next = await advance(sessionTx, session, now);
      await tx.objectStore('sessions').put(session);
      return { status: 'committed', review, state: next };
    });
  }

  function emptyState(review: Review): PracticeState {
    return {
      session: {
        id: review.sessionId ?? '',
        topics: null,
        size: 0,
        queue: [],
        index: 0,
        status: 'ended',
        startedAt: review.startedAt,
        endedAt: review.committedAt,
        attempt: null,
        results: [],
      },
      card: null,
      schedule: null,
    };
  }

  /** Skip the current card (it was paused, deleted, or reviewed elsewhere). */
  async function skipCurrent(sessionId: string, attemptId: string, reason: SkipReason, now: number): Promise<PracticeState | null> {
    return run(SESSION_STORES, 'readwrite', async (tx) => {
      const session = await tx.objectStore('sessions').get(sessionId);
      if (!session) return null;
      const attempt = matchAttempt(session, attemptId);
      if (!attempt) return loadState(tx, session);
      skip(session, attempt.cardId, reason, now);
      const state = await advance(tx, session, now);
      await tx.objectStore('sessions').put(session);
      return state;
    });
  }

  /** Start a fresh attempt on the updated card, keeping the learner's draft. */
  async function refreshAttempt(sessionId: string, attemptId: string, now: number): Promise<PracticeState | null> {
    return run(SESSION_STORES, 'readwrite', async (tx) => {
      const session = await tx.objectStore('sessions').get(sessionId);
      if (!session) return null;
      const attempt = matchAttempt(session, attemptId);
      if (!attempt) return loadState(tx, session);
      const [card, schedule] = await Promise.all([
        tx.objectStore('cards').get(attempt.cardId),
        tx.objectStore('schedules').get(attempt.cardId),
      ]);
      let reason = ineligibility(card, schedule, now);
      if (!reason && schedule && schedule.stateVersion !== attempt.expectedStateVersion) reason = 'reviewed-elsewhere';
      if (reason || !card || !schedule) {
        skip(session, attempt.cardId, reason ?? 'deleted', now);
        const state = await advance(tx, session, now);
        await tx.objectStore('sessions').put(session);
        return state;
      }
      session.attempt = {
        id: newId(),
        cardId: card.id,
        cardVersion: card.contentVersion,
        expectedStateVersion: schedule.stateVersion,
        response: attempt.response,
        confidence: attempt.confidence,
        revealed: false,
        startedAt: now,
        revealedAt: null,
      };
      await tx.objectStore('sessions').put(session);
      return { session, card, schedule };
    });
  }

  /** End early. Nothing is rated on the learner's behalf. */
  async function endSession(sessionId: string, now: number): Promise<Session | null> {
    return run(['sessions'], 'readwrite', async (tx) => {
      const session = await tx.objectStore('sessions').get(sessionId);
      if (!session) return null;
      if (session.status === 'active') {
        session.status = 'ended';
        session.endedAt = now;
        session.attempt = null;
        await tx.objectStore('sessions').put(session);
      }
      return session;
    });
  }

  // -------------------------------------------------------------------------
  // Reflections

  async function addReflection(body: string, sessionId: string | null, now: number): Promise<Reflection> {
    if (body.trim() === '') throw new ValidationError('Write something before saving the reflection.');
    const tooLong = overLimitMessage('Reflection', body, LIMITS.reflection);
    if (tooLong) throw new ValidationError(tooLong);
    const reflection: Reflection = { id: newId(), sessionId, body, createdAt: now };
    await run(['reflections'], 'readwrite', async (tx) => {
      await tx.objectStore('reflections').add(reflection);
    });
    return reflection;
  }

  // -------------------------------------------------------------------------
  // Backups and deletion

  const DATA_STORES: ['cards', 'schedules', 'reviews', 'sessions', 'reflections', 'rubrics', 'assessments', 'meta'] = [
    'cards',
    'schedules',
    'reviews',
    'sessions',
    'reflections',
    'rubrics',
    'assessments',
    'meta',
  ];

  async function exportWorkspace(): Promise<WorkspaceData> {
    return run(DATA_STORES, 'readonly', async (tx) => {
      const [cards, schedules, reviews, sessions, reflections, rubrics, assessments, prefs] = await Promise.all([
        tx.objectStore('cards').getAll(),
        tx.objectStore('schedules').getAll(),
        tx.objectStore('reviews').getAll(),
        tx.objectStore('sessions').getAll(),
        tx.objectStore('reflections').getAll(),
        tx.objectStore('rubrics').getAll(),
        tx.objectStore('assessments').getAll(),
        tx.objectStore('meta').get('preferences'),
      ]);
      return {
        cards,
        schedules,
        reviews,
        sessions,
        reflections,
        rubrics,
        assessments,
        preferences: prefs ? normalizePreferences(prefs.value) : null,
      };
    });
  }

  /** Replace everything with validated backup data, atomically. */
  async function replaceWorkspace(data: WorkspaceData): Promise<void> {
    await run(ALL_STORES, 'readwrite', async (tx) => {
      const lastBackup = await tx.objectStore('meta').get('lastBackupAt');
      await Promise.all(ALL_STORES.map((s) => tx.objectStore(s).clear()));
      for (const c of data.cards) await tx.objectStore('cards').add(c);
      for (const s of data.schedules) await tx.objectStore('schedules').add(s);
      for (const r of data.reviews) await tx.objectStore('reviews').add(r);
      for (const s of data.sessions) await tx.objectStore('sessions').add(s);
      for (const r of data.reflections) await tx.objectStore('reflections').add(r);
      for (const r of data.rubrics) await tx.objectStore('rubrics').add(r);
      for (const a of data.assessments) await tx.objectStore('assessments').add(a);
      if (data.preferences) await tx.objectStore('meta').put({ key: 'preferences', value: data.preferences });
      if (lastBackup) await tx.objectStore('meta').put(lastBackup);
    });
  }

  async function deleteAllData(): Promise<void> {
    await run(ALL_STORES, 'readwrite', async (tx) => {
      await Promise.all(ALL_STORES.map((s) => tx.objectStore(s).clear()));
    });
  }

  async function close(): Promise<void> {
    if (dbPromise) (await dbPromise).close();
    dbPromise = null;
  }

  return {
    loadWorkspace,
    savePreferences,
    setLastBackupAt,
    addCards,
    addMissingCards,
    updateCard,
    setPaused,
    resetProgress,
    deleteCard,
    getCardReviews,
    getActiveSession,
    getSession,
    startSession,
    ensureAttempt,
    saveDraft,
    reveal,
    commitReview,
    skipCurrent,
    refreshAttempt,
    endSession,
    addReflection,
    exportWorkspace,
    replaceWorkspace,
    deleteAllData,
    close,
  };
}

export type Repository = ReturnType<typeof createRepository>;
