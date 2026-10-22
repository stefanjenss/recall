// The only module that reads or writes IndexedDB. Every multi-record change
// runs in a single transaction, so a crash or closed tab leaves either the
// whole change or none of it.

import type { IDBPTransaction } from 'idb';
import { validateRecord, type WorkspaceData } from '../content/backup';
import type { OptionsUpdate } from '../content/optionsImport';
import { sameChoices, shuffledOptions } from '../domain/choices';
import { newId } from '../domain/ids';
import { duplicateKey, LIMITS, overLimitMessage, validateCardInput } from '../domain/limits';
import { buildQueue, ineligibility } from '../domain/queue';
import { applyQuickCheck, applyRating, initialSchedule, snapshotOf } from '../domain/scheduler';
import { upgradeRecord } from '../domain/upgrade';
import { browserTimeZone, isValidTimeZone } from '../domain/time';
import type {
  Assessment,
  Attempt,
  Card,
  CardContent,
  Confidence,
  PracticeMode,
  Preferences,
  QuickCheckResult,
  Rating,
  Reflection,
  Review,
  Rubric,
  Schedule,
  Session,
  SkipReason,
} from '../domain/types';
import { compareHlc, hlcAt, isHlc, observeHlc, tickHlc } from '../sync/hlc';
import type { SyncErrorKind } from '../sync/client';
import { isSyncStore, keyOf, PREFERENCES_KEY, type SyncChange, type SyncRecord, type SyncStore } from '../sync/protocol';
import { ALL_STORES, DB_NAME, openRecallDb, type OutboxEntry, type RecallDb, type RecallSchema, type StoreName } from './db';

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

/** How to reach the sync server. Kept in this browser only; never in backups. */
export interface SyncConfig {
  /** Base URL of the server, ending in `/`. */
  url: string;
  key: string;
  deviceId: string;
  /** The server copy this device is synced with. */
  serverId: string;
  connectedAt: number;
}

export interface SyncState {
  /** Server sequence number this device has pulled up to. */
  cursor: number;
  lastSyncAt: number | null;
  lastError: { kind: SyncErrorKind; message: string; at: number } | null;
  /** Changes the server refused. They stay on this device but stop being sent. */
  rejected: { count: number; lastReason: string | null };
}

/** What screens need to show sync status. Leaves out the key. */
export interface SyncStatus {
  url: string;
  serverId: string;
  connectedAt: number;
  cursor: number;
  lastSyncAt: number | null;
  lastError: SyncState['lastError'];
  rejected: SyncState['rejected'];
  /** Local changes not yet acknowledged by the server. */
  pending: number;
}

interface SyncClock {
  hlc: string;
  deviceId: string;
}

/**
 * How a device joins a server:
 * - upload: queue every local record to send (the server is empty, or the learner chose to combine).
 * - download: clear this device's data and take the server's copy.
 */
export type SyncJoinMode = 'upload' | 'download';

export interface OutboxItem {
  entry: OutboxEntry;
  change: SyncChange;
}

export interface PracticeState {
  session: Session;
  /** The card for the current attempt, read in the same transaction. */
  card: Card | null;
  schedule: Schedule | null;
}

export type StartResult =
  { status: 'started'; state: PracticeState } | { status: 'active-exists'; session: Session } | { status: 'empty' };

export type CommitResult =
  | { status: 'committed' | 'duplicate'; review: Review; state: PracticeState }
  | { status: 'stale'; reason: 'session-changed' | 'reviewed-elsewhere' | 'edited'; state: PracticeState | null }
  | { status: 'ineligible'; reason: 'deleted' | 'paused'; state: PracticeState };

export type AddCardsResult = { status: 'added'; cardIds: string[] } | { status: 'already-imported'; cardIds: string[] };

/** Why an options update was left out at apply time: the card is gone, was edited since the preview, or already matches. */
export type OptionsSkipReason = 'deleted' | 'edited' | 'unchanged';

export type ApplyOptionsResult =
  | { status: 'applied'; cardIds: string[]; skipped: Array<{ cardId: string; reason: OptionsSkipReason }> }
  | { status: 'already-applied'; cardIds: string[] };

type Tx<S extends StoreName[], M extends IDBTransactionMode> = IDBPTransaction<RecallSchema, S, M>;

/** What a committed attempt records, by mode. */
type ReviewOutcome =
  { mode: 'recall'; rating: Rating; quickCheck: null } | { mode: 'quick-check'; rating: null; quickCheck: QuickCheckResult };

const SESSION_STORES: ['cards', 'schedules', 'sessions', 'meta', 'outbox'] = ['cards', 'schedules', 'sessions', 'meta', 'outbox'];
type SessionTx = Tx<typeof SESSION_STORES, 'readwrite'>;
type OutboxTx = Tx<['meta', 'outbox'], 'readwrite'>;

const SYNC_DATA_STORES: ['cards', 'schedules', 'reviews', 'sessions', 'reflections', 'rubrics', 'assessments'] = [
  'cards',
  'schedules',
  'reviews',
  'sessions',
  'reflections',
  'rubrics',
  'assessments',
];
type SyncDataStore = (typeof SYNC_DATA_STORES)[number];
const SYNC_TX_STORES: [...typeof SYNC_DATA_STORES, 'meta', 'outbox'] = [...SYNC_DATA_STORES, 'meta', 'outbox'];

/** The outbox key for a record. */
export const outboxId = (store: SyncStore, key: string) => `${store}/${key}`;

/** When a record last changed, as best it can tell. Used to stamp records a device uploads when it joins. */
function changedAt(store: SyncStore, value: unknown): number {
  const v = value as Record<string, unknown>;
  const pick = (...fields: string[]) => {
    for (const f of fields) if (typeof v[f] === 'number') return v[f] as number;
    return 0;
  };
  switch (store) {
    case 'cards':
    case 'rubrics':
      return pick('updatedAt', 'createdAt');
    case 'schedules':
      return pick('lastReviewedAt');
    case 'reviews':
      return pick('committedAt');
    case 'sessions':
      return pick('endedAt', 'startedAt');
    case 'reflections':
    case 'assessments':
      return pick('createdAt');
    case 'preferences':
      return 0;
  }
}

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

  /**
   * Queue records for sync, in the caller's transaction so the change and its
   * outbox entry commit together. Does nothing while sync is off.
   */
  async function markChanged<S extends StoreName[]>(
    anyTx: Tx<S, 'readwrite'>,
    changes: Array<[SyncStore, string]>,
    now: number,
  ): Promise<void> {
    if (changes.length === 0) return;
    // The transaction must include 'meta' and 'outbox'.
    const tx = anyTx as unknown as OutboxTx;
    const meta = tx.objectStore('meta');
    const clockRecord = await meta.get('syncClock');
    if (!clockRecord) return;
    const clock = clockRecord.value as SyncClock;
    let hlc = clock.hlc;
    for (const [store, key] of changes) {
      hlc = tickHlc(hlc, now, clock.deviceId);
      await tx.objectStore('outbox').put({ id: outboxId(store, key), store, key, hlc });
    }
    await meta.put({ key: 'syncClock', value: { ...clock, hlc } });
  }

  /** Session records sync once they finish; an active session stays on its device. */
  async function markSession(tx: SessionTx, session: Session, now: number): Promise<void> {
    if (session.status !== 'active') await markChanged(tx, [['sessions', session.id]], now);
  }

  // -------------------------------------------------------------------------
  // Workspace

  async function loadWorkspace(): Promise<WorkspaceSnapshot> {
    // Review history is read in its own transaction so a large history never
    // holds up session writes (which touch cards, schedules, and sessions).
    const [core, reviews] = await Promise.all([
      run(['cards', 'schedules', 'reflections', 'sessions', 'meta'], 'readonly', (tx) =>
        Promise.all([
          tx.objectStore('cards').getAll(),
          tx.objectStore('schedules').getAll(),
          tx.objectStore('reflections').index('byCreatedAt').getAll(),
          tx.objectStore('sessions').index('byStatus').getAll('active'),
          tx.objectStore('meta').get('preferences'),
          tx.objectStore('meta').get('lastBackupAt'),
        ]),
      ),
      run(['reviews'], 'readonly', (tx) => tx.objectStore('reviews').index('byCommittedAt').getAll()),
    ]);
    const [cards, schedules, reflections, active, prefs, lastBackup] = core;
    return {
      cards,
      schedules,
      reviews,
      reflections,
      activeSession: active[0] ?? null,
      preferences: normalizePreferences(prefs?.value),
      lastBackupAt: typeof lastBackup?.value === 'number' ? lastBackup.value : null,
    };
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

  async function savePreferences(prefs: Preferences, now: number): Promise<void> {
    await run(['meta', 'outbox'], 'readwrite', async (tx) => {
      await tx.objectStore('meta').put({ key: 'preferences', value: prefs });
      await markChanged(tx, [['preferences', PREFERENCES_KEY]], now);
    });
  }

  // -------------------------------------------------------------------------
  // Sync bookkeeping

  async function getSyncConfig(): Promise<SyncConfig | null> {
    const d = await db();
    const rec = await d.get('meta', 'syncConfig');
    return (rec?.value as SyncConfig | undefined) ?? null;
  }

  async function getSyncStatus(): Promise<SyncStatus | null> {
    return run(['meta', 'outbox'], 'readonly', async (tx) => {
      const [configRec, stateRec, pending] = await Promise.all([
        tx.objectStore('meta').get('syncConfig'),
        tx.objectStore('meta').get('syncState'),
        tx.objectStore('outbox').count(),
      ]);
      if (!configRec) return null;
      const config = configRec.value as SyncConfig;
      const state = (stateRec?.value as SyncState | undefined) ?? emptySyncState();
      return {
        url: config.url,
        serverId: config.serverId,
        connectedAt: config.connectedAt,
        cursor: state.cursor,
        lastSyncAt: state.lastSyncAt,
        lastError: state.lastError,
        rejected: state.rejected,
        pending,
      };
    });
  }

  function emptySyncState(): SyncState {
    return { cursor: 0, lastSyncAt: null, lastError: null, rejected: { count: 0, lastReason: null } };
  }

  /**
   * Connect this device to a sync server in one transaction. `upload` queues
   * every existing record, stamped with when it last changed so that a newer
   * copy already on the server wins. `download` clears this device's data so
   * the first pull fills it with the server's copy.
   */
  async function connectSync(config: SyncConfig, mode: SyncJoinMode, now: number): Promise<void> {
    await run(ALL_STORES, 'readwrite', async (tx) => {
      const { deviceId } = config;
      await tx.objectStore('outbox').clear();
      if (mode === 'download') {
        await Promise.all([
          ...SYNC_DATA_STORES.map((name) => tx.objectStore(name).clear()),
          tx.objectStore('importBatches').clear(),
          tx.objectStore('meta').delete('preferences'),
        ]);
      }
      await tx.objectStore('meta').put({ key: 'syncConfig', value: config });
      await tx.objectStore('meta').put({ key: 'syncState', value: emptySyncState() });
      const clock: SyncClock = { hlc: tickHlc(null, now, deviceId), deviceId };
      await tx.objectStore('meta').put({ key: 'syncClock', value: clock });
      if (mode !== 'upload') return;
      const queue = (store: SyncStore, key: string, value: unknown) =>
        tx.objectStore('outbox').put({ id: outboxId(store, key), store, key, hlc: hlcAt(changedAt(store, value), deviceId) });
      const lists = await Promise.all(SYNC_DATA_STORES.map((name) => tx.objectStore(name).getAll()));
      const writes: Array<Promise<unknown>> = [];
      SYNC_DATA_STORES.forEach((store, i) => {
        for (const value of lists[i]!) {
          if (store === 'sessions' && (value as Session).status === 'active') continue;
          const key = keyOf(store, value);
          if (key) writes.push(queue(store, key, value));
        }
      });
      const prefs = await tx.objectStore('meta').get('preferences');
      if (prefs) writes.push(queue('preferences', PREFERENCES_KEY, prefs.value));
      await Promise.all(writes);
    });
  }

  /** Stop syncing. This device's data stays; so does the server's copy. */
  async function disconnectSync(): Promise<void> {
    await run(['meta', 'outbox'], 'readwrite', async (tx) => {
      await Promise.all([
        tx.objectStore('meta').delete('syncConfig'),
        tx.objectStore('meta').delete('syncState'),
        tx.objectStore('meta').delete('syncClock'),
        tx.objectStore('outbox').clear(),
      ]);
    });
  }

  /**
   * The oldest-keyed local changes waiting to sync, with each record's current
   * value. Entries whose record is gone or can't sync are returned as `stale`
   * so the caller can acknowledge them away.
   */
  async function readOutbox(limit: number): Promise<{ items: OutboxItem[]; stale: OutboxEntry[] }> {
    return run(SYNC_TX_STORES, 'readonly', async (tx) => {
      const entries = await tx.objectStore('outbox').getAll(undefined, limit);
      const values = await Promise.all(
        entries.map(async (entry) => {
          if (entry.store === 'preferences') return (await tx.objectStore('meta').get('preferences'))?.value;
          return tx.objectStore(entry.store).get(entry.key);
        }),
      );
      const items: OutboxItem[] = [];
      const stale: OutboxEntry[] = [];
      entries.forEach((entry, i) => {
        const value = values[i];
        if (value === undefined || (entry.store === 'sessions' && (value as Session).status === 'active')) {
          stale.push(entry);
          return;
        }
        items.push({ entry, change: { store: entry.store, key: entry.key, hlc: entry.hlc, value } });
      });
      return { items, stale };
    });
  }

  /**
   * Record the outcome of a sync step in one transaction: drop acknowledged
   * outbox entries (unless the record changed again meanwhile), apply records
   * from the server (unless this device has a newer local change), advance the
   * clock and the pull cursor. Does nothing if this device has since
   * disconnected or switched servers.
   */
  async function applySyncBatch(batch: {
    serverId: string;
    acked?: Array<{ id: string; hlc: string }>;
    records?: SyncRecord[];
    cursor?: number;
    rejected?: { count: number; lastReason: string | null };
  }): Promise<{ applied: number; ignored: number; disconnected: boolean }> {
    return run(SYNC_TX_STORES, 'readwrite', async (tx) => {
      const meta = tx.objectStore('meta');
      const outbox = tx.objectStore('outbox');
      const [configRec, stateRec, clockRec] = await Promise.all([
        meta.get('syncConfig'),
        meta.get('syncState'),
        meta.get('syncClock'),
      ]);
      const config = configRec?.value as SyncConfig | undefined;
      if (!config || !clockRec || config.serverId !== batch.serverId) return { applied: 0, ignored: 0, disconnected: true };

      for (const { id, hlc } of batch.acked ?? []) {
        const entry = await outbox.get(id);
        if (entry && entry.hlc === hlc) await outbox.delete(id);
      }

      let applied = 0;
      let ignored = 0;
      let clock = (clockRec.value as SyncClock).hlc;
      for (const pulled of batch.records ?? []) {
        // A server that predates quick checks may still hold records in the older shape.
        const record = isSyncStore(pulled.store) ? { ...pulled, value: upgradeRecord(pulled.store, pulled.value) } : pulled;
        const store = record.store;
        if (
          !isSyncStore(store) ||
          validateRecord(store, record.value).length > 0 ||
          keyOf(store, record.value) !== record.key ||
          !isHlc(record.hlc)
        ) {
          ignored += 1;
          continue;
        }
        clock = observeHlc(clock, record.hlc);
        const id = outboxId(store, record.key);
        const pending = await outbox.get(id);
        if (pending && compareHlc(pending.hlc, record.hlc) > 0) continue;
        if (store === 'sessions') {
          const local = await tx.objectStore('sessions').get(record.key);
          if ((record.value as Session).status === 'active' || local?.status === 'active') {
            ignored += 1;
            continue;
          }
        }
        if (store === 'preferences') await meta.put({ key: 'preferences', value: record.value });
        else await putSynced(tx, store, record.value);
        if (pending) await outbox.delete(id);
        applied += 1;
      }

      const state = (stateRec?.value as SyncState | undefined) ?? emptySyncState();
      const next: SyncState = { ...state };
      if (batch.cursor !== undefined) next.cursor = Math.max(state.cursor, batch.cursor);
      if (batch.rejected && batch.rejected.count > 0) {
        next.rejected = {
          count: state.rejected.count + batch.rejected.count,
          lastReason: batch.rejected.lastReason ?? state.rejected.lastReason,
        };
      }
      await meta.put({ key: 'syncState', value: next });
      await meta.put({ key: 'syncClock', value: { ...(clockRec.value as SyncClock), hlc: clock } });
      return { applied, ignored, disconnected: false };
    });
  }

  function putSynced(tx: Tx<typeof SYNC_TX_STORES, 'readwrite'>, store: SyncDataStore, value: unknown) {
    switch (store) {
      case 'cards':
        return tx.objectStore('cards').put(value as Card);
      case 'schedules':
        return tx.objectStore('schedules').put(value as Schedule);
      case 'reviews':
        return tx.objectStore('reviews').put(value as Review);
      case 'sessions':
        return tx.objectStore('sessions').put(value as Session);
      case 'reflections':
        return tx.objectStore('reflections').put(value as Reflection);
      case 'rubrics':
        return tx.objectStore('rubrics').put(value as Rubric);
      case 'assessments':
        return tx.objectStore('assessments').put(value as Assessment);
    }
  }

  /** Note when sync last succeeded or why it failed, for the current server only. */
  async function recordSyncAttempt(
    serverId: string,
    outcome: { ok: true; at: number } | { ok: false; error: NonNullable<SyncState['lastError']> },
  ): Promise<void> {
    await run(['meta'], 'readwrite', async (tx) => {
      const meta = tx.objectStore('meta');
      const [configRec, stateRec] = await Promise.all([meta.get('syncConfig'), meta.get('syncState')]);
      const config = configRec?.value as SyncConfig | undefined;
      if (!config || config.serverId !== serverId) return;
      const state = (stateRec?.value as SyncState | undefined) ?? emptySyncState();
      const next: SyncState = outcome.ok
        ? { ...state, lastSyncAt: outcome.at, lastError: null }
        : { ...state, lastError: outcome.error };
      await meta.put({ key: 'syncState', value: next });
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
    return run(['cards', 'schedules', 'importBatches', 'meta', 'outbox'], 'readwrite', async (tx) => {
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
      await markChanged(tx, cardChanges(cardIds), now);
      return { status: 'added', cardIds };
    });
  }

  function cardChanges(cardIds: string[]): Array<[SyncStore, string]> {
    return cardIds.flatMap((id): Array<[SyncStore, string]> => [
      ['cards', id],
      ['schedules', id],
    ]);
  }

  /** Add only cards whose question isn't already in the collection (used for the starter set). */
  async function addMissingCards(contents: CardContent[], now: number): Promise<{ added: number; skipped: number }> {
    const clean = contents.map(validated);
    return run(['cards', 'schedules', 'meta', 'outbox'], 'readwrite', async (tx) => {
      const existing = await tx.objectStore('cards').getAll();
      const keys = new Set(existing.filter((c) => c.deletedAt === null).map((c) => duplicateKey(c.question)));
      const addedIds: string[] = [];
      for (const content of clean) {
        const k = duplicateKey(content.question);
        if (keys.has(k)) continue;
        keys.add(k);
        const card = newCard(content, now);
        await tx.objectStore('cards').add(card);
        await tx.objectStore('schedules').add(initialSchedule(card.id, now));
        addedIds.push(card.id);
      }
      await markChanged(tx, cardChanges(addedIds), now);
      return { added: addedIds.length, skipped: clean.length - addedIds.length };
    });
  }

  /** Content edits keep the schedule and bump contentVersion. */
  async function updateCard(cardId: string, content: CardContent, now: number): Promise<Card> {
    const clean = validated(content);
    return run(['cards', 'meta', 'outbox'], 'readwrite', async (tx) => {
      const card = await tx.objectStore('cards').get(cardId);
      if (!card || card.deletedAt !== null) throw new ValidationError('This card no longer exists.');
      const changed =
        card.topic !== clean.topic ||
        card.question !== clean.question ||
        card.answer !== clean.answer ||
        card.kind !== clean.kind ||
        card.source !== clean.source ||
        !sameChoices(card.choices, clean.choices);
      if (!changed) return card;
      const next: Card = { ...card, ...clean, contentVersion: card.contentVersion + 1, updatedAt: now };
      await tx.objectStore('cards').put(next);
      await markChanged(tx, [['cards', cardId]], now);
      return next;
    });
  }

  /**
   * Give existing cards multiple-choice options, atomically. Only `choices`
   * changes: it's a content edit, so `contentVersion` goes up (attempts on
   * those cards go stale) and schedules are untouched. A card deleted or
   * edited since the preview is skipped. With a batchId, retrying the same
   * request returns the original result instead of applying it again.
   */
  async function applyOptions(updates: OptionsUpdate[], now: number, batchId?: string): Promise<ApplyOptionsResult> {
    return run(['cards', 'importBatches', 'meta', 'outbox'], 'readwrite', async (tx) => {
      if (batchId) {
        const prior = await tx.objectStore('importBatches').get(batchId);
        if (prior) return { status: 'already-applied', cardIds: prior.cardIds };
      }
      const cards = tx.objectStore('cards');
      const cardIds: string[] = [];
      const skipped: Array<{ cardId: string; reason: OptionsSkipReason }> = [];
      for (const update of updates) {
        const card = await cards.get(update.cardId);
        if (!card || card.deletedAt !== null) {
          skipped.push({ cardId: update.cardId, reason: 'deleted' });
          continue;
        }
        if (card.contentVersion !== update.cardVersion) {
          skipped.push({ cardId: card.id, reason: 'edited' });
          continue;
        }
        const { topic, question, answer, kind, source } = card;
        const { value, errors } = validateCardInput({ topic, question, answer, kind, source, choices: update.choices });
        if (!value?.choices) throw new ValidationError(errors.map((e) => e.message).join(' ') || 'Options are required.');
        if (sameChoices(card.choices, value.choices)) {
          skipped.push({ cardId: card.id, reason: 'unchanged' });
          continue;
        }
        await cards.put({ ...card, choices: value.choices, contentVersion: card.contentVersion + 1, updatedAt: now });
        cardIds.push(card.id);
      }
      if (batchId) await tx.objectStore('importBatches').add({ id: batchId, committedAt: now, cardIds });
      await markChanged(
        tx,
        cardIds.map((id): [SyncStore, string] => ['cards', id]),
        now,
      );
      return { status: 'applied', cardIds, skipped };
    });
  }

  async function mutateSchedule(cardId: string, now: number, fn: (s: Schedule) => Schedule): Promise<Schedule> {
    return run(['schedules', 'meta', 'outbox'], 'readwrite', async (tx) => {
      const s = await tx.objectStore('schedules').get(cardId);
      if (!s) throw new ValidationError('This card has no schedule.');
      const next = { ...fn(s), stateVersion: s.stateVersion + 1 };
      await tx.objectStore('schedules').put(next);
      await markChanged(tx, [['schedules', cardId]], now);
      return next;
    });
  }

  /** Pausing excludes a card from practice; resuming keeps its due time and history. */
  function setPaused(cardId: string, paused: boolean, now: number): Promise<Schedule> {
    return mutateSchedule(cardId, now, (s) => ({ ...s, paused }));
  }

  /** Start the card over as new. Review history is kept. */
  function resetProgress(cardId: string, now: number): Promise<Schedule> {
    return mutateSchedule(cardId, now, (s) => ({
      ...initialSchedule(cardId, now),
      paused: s.paused,
      stateVersion: s.stateVersion,
    }));
  }

  async function deleteCard(cardId: string, now: number): Promise<void> {
    await run(['cards', 'meta', 'outbox'], 'readwrite', async (tx) => {
      const card = await tx.objectStore('cards').get(cardId);
      if (!card || card.deletedAt !== null) return;
      await tx.objectStore('cards').put({ ...card, deletedAt: now, updatedAt: now });
      await markChanged(tx, [['cards', cardId]], now);
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

  /** A fresh attempt. Quick-check options are shuffled once here, so a reload keeps their order. */
  function newAttempt(
    card: Card,
    schedule: Schedule,
    mode: PracticeMode,
    now: number,
    draft: { response: string; confidence: Confidence | null } = { response: '', confidence: null },
  ): Attempt {
    return {
      id: newId(),
      cardId: card.id,
      cardVersion: card.contentVersion,
      expectedStateVersion: schedule.stateVersion,
      response: draft.response,
      confidence: draft.confidence,
      revealed: false,
      startedAt: now,
      revealedAt: null,
      options: mode === 'quick-check' && card.choices ? shuffledOptions(card.choices, Math.random) : null,
      picked: null,
    };
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
      const [card, schedule] = await Promise.all([tx.objectStore('cards').get(cardId), tx.objectStore('schedules').get(cardId)]);
      const reason = ineligibility(card, schedule, now, session.mode);
      if (reason || !card || !schedule) {
        skip(session, cardId, reason ?? 'deleted', now);
        continue;
      }
      session.attempt = newAttempt(card, schedule, session.mode, now);
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

  async function startSession(opts: {
    topics: string[] | null;
    size: number;
    now: number;
    mode?: PracticeMode;
  }): Promise<StartResult> {
    const mode = opts.mode ?? 'recall';
    return run(SESSION_STORES, 'readwrite', async (tx) => {
      const active = await tx.objectStore('sessions').index('byStatus').getAll('active');
      if (active[0]) return { status: 'active-exists', session: active[0] };
      const [cards, schedules] = await Promise.all([tx.objectStore('cards').getAll(), tx.objectStore('schedules').getAll()]);
      const byId = new Map(schedules.map((s) => [s.cardId, s]));
      const items = cards.flatMap((card) => {
        const schedule = byId.get(card.id);
        return schedule ? [{ card, schedule }] : [];
      });
      const queue = buildQueue(items, { now: opts.now, size: opts.size, topics: opts.topics, mode });
      if (queue.length === 0) return { status: 'empty' };
      const session: Session = {
        id: newId(),
        mode,
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
      await markSession(tx, session, opts.now);
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
      await markSession(tx, session, now);
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
      if (attempt.options) throw new ValidationError('This is a quick check. Pick an option instead.');
      if (!attempt.revealed) {
        session.attempt = { ...attempt, response: draft.response, confidence: draft.confidence, revealed: true, revealedAt: now };
        await tx.objectStore('sessions').put(session);
      }
      return loadState(tx, session);
    });
  }

  /** Freeze a quick-check pick and show the result. The first pick for an attempt stands. */
  async function pickOption(sessionId: string, attemptId: string, picked: number, now: number): Promise<PracticeState | null> {
    return run(SESSION_STORES, 'readwrite', async (tx) => {
      const session = await tx.objectStore('sessions').get(sessionId);
      const attempt = matchAttempt(session, attemptId);
      if (!session || !attempt) return session ? loadState(tx, session) : null;
      if (!attempt.options) throw new ValidationError('This card is a full recall. Reveal the answer instead.');
      if (!Number.isInteger(picked) || picked < 0 || picked >= attempt.options.length) {
        throw new ValidationError('Choose one of the options.');
      }
      if (!attempt.revealed) {
        session.attempt = { ...attempt, picked, revealed: true, revealedAt: now };
        await tx.objectStore('sessions').put(session);
      }
      return loadState(tx, session);
    });
  }

  /** Commit a self-rating for a revealed full-recall attempt. */
  function commitReview(sessionId: string, attemptId: string, rating: Rating, now: number): Promise<CommitResult> {
    return commitAttempt(sessionId, attemptId, 'recall', now, (_attempt, _card, schedule) => ({
      after: applyRating(schedule, rating, now),
      outcome: { mode: 'recall', rating, quickCheck: null },
    }));
  }

  /** Commit a picked quick check. Whether the pick was correct is decided here, against the card. */
  function commitQuickCheck(sessionId: string, attemptId: string, now: number): Promise<CommitResult> {
    return commitAttempt(sessionId, attemptId, 'quick-check', now, (attempt, card, schedule) => {
      const options = attempt.options!;
      const picked = attempt.picked!;
      const correct = card.choices !== null && options[picked] === card.choices.correct;
      return {
        after: applyQuickCheck(schedule, correct, now),
        outcome: { mode: 'quick-check', rating: null, quickCheck: { options, picked, correct } },
      };
    });
  }

  /**
   * Commit an attempt: insert the review, advance the schedule, and move the
   * session forward in one transaction. The attempt ID is the idempotency key,
   * and the schedule's stateVersion guards against concurrent reviews.
   */
  async function commitAttempt(
    sessionId: string,
    attemptId: string,
    mode: PracticeMode,
    now: number,
    settle: (attempt: Attempt, card: Card, schedule: Schedule) => { after: Schedule; outcome: ReviewOutcome },
  ): Promise<CommitResult> {
    return run(['cards', 'schedules', 'sessions', 'reviews', 'meta', 'outbox'], 'readwrite', async (tx) => {
      const sessionTx = tx as unknown as SessionTx;
      const existing = await tx.objectStore('reviews').get(attemptId);
      const session = await tx.objectStore('sessions').get(sessionId);
      if (existing) {
        return {
          status: 'duplicate',
          review: existing,
          state: session ? await loadState(sessionTx, session) : emptyState(existing),
        };
      }
      const attempt = matchAttempt(session, attemptId);
      if (!session || !attempt) {
        return { status: 'stale', reason: 'session-changed', state: session ? await loadState(sessionTx, session) : null };
      }
      if ((attempt.options !== null) !== (mode === 'quick-check')) {
        throw new ValidationError(
          mode === 'recall' ? 'A quick check has no self-rating.' : 'This card is a full recall. Rate it instead.',
        );
      }
      if (!attempt.revealed || (mode === 'quick-check' && attempt.picked === null)) {
        throw new ValidationError(mode === 'recall' ? 'Reveal the answer before rating.' : 'Pick an option before continuing.');
      }

      const [card, schedule] = await Promise.all([
        tx.objectStore('cards').get(attempt.cardId),
        tx.objectStore('schedules').get(attempt.cardId),
      ]);
      const state: PracticeState = { session, card: card ?? null, schedule: schedule ?? null };
      if (!card || !schedule || card.deletedAt !== null) return { status: 'ineligible', reason: 'deleted', state };
      if (schedule.paused) return { status: 'ineligible', reason: 'paused', state };
      if (schedule.stateVersion !== attempt.expectedStateVersion) return { status: 'stale', reason: 'reviewed-elsewhere', state };
      if (card.contentVersion !== attempt.cardVersion) return { status: 'stale', reason: 'edited', state };

      const { after, outcome } = settle(attempt, card, schedule);
      const review: Review = {
        ...outcome,
        id: attempt.id,
        cardId: card.id,
        cardVersion: card.contentVersion,
        sessionId: session.id,
        response: attempt.response,
        confidence: attempt.confidence,
        before: snapshotOf(schedule),
        after: snapshotOf(after),
        schedulerVersion: after.schedulerVersion,
        startedAt: attempt.startedAt,
        revealedAt: attempt.revealedAt,
        committedAt: now,
        snapshot: {
          topic: card.topic,
          question: card.question,
          answer: card.answer,
          kind: card.kind,
          source: card.source,
          choices: card.choices,
        },
      };
      // `add` (not `put`) so a second insert with the same key fails the whole transaction.
      await tx.objectStore('reviews').add(review);
      await tx.objectStore('schedules').put(after);
      session.results.push({
        cardId: card.id,
        outcome: 'reviewed',
        reviewId: review.id,
        rating: review.rating,
        reason: null,
        at: now,
      });
      session.index += 1;
      session.attempt = null;
      const next = await advance(sessionTx, session, now);
      await tx.objectStore('sessions').put(session);
      await markChanged(
        tx,
        [
          ['reviews', review.id],
          ['schedules', card.id],
        ],
        now,
      );
      await markSession(sessionTx, session, now);
      return { status: 'committed', review, state: next };
    });
  }

  function emptyState(review: Review): PracticeState {
    return {
      session: {
        id: review.sessionId ?? '',
        mode: review.mode,
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
  async function skipCurrent(
    sessionId: string,
    attemptId: string,
    reason: SkipReason,
    now: number,
  ): Promise<PracticeState | null> {
    return run(SESSION_STORES, 'readwrite', async (tx) => {
      const session = await tx.objectStore('sessions').get(sessionId);
      if (!session) return null;
      const attempt = matchAttempt(session, attemptId);
      if (!attempt) return loadState(tx, session);
      skip(session, attempt.cardId, reason, now);
      const state = await advance(tx, session, now);
      await tx.objectStore('sessions').put(session);
      await markSession(tx, session, now);
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
      let reason = ineligibility(card, schedule, now, session.mode);
      if (!reason && schedule && schedule.stateVersion !== attempt.expectedStateVersion) reason = 'reviewed-elsewhere';
      if (reason || !card || !schedule) {
        skip(session, attempt.cardId, reason ?? 'deleted', now);
        const state = await advance(tx, session, now);
        await tx.objectStore('sessions').put(session);
        await markSession(tx, session, now);
        return state;
      }
      session.attempt = newAttempt(card, schedule, session.mode, now, attempt);
      await tx.objectStore('sessions').put(session);
      return { session, card, schedule };
    });
  }

  /** End early. Nothing is rated on the learner's behalf. */
  async function endSession(sessionId: string, now: number): Promise<Session | null> {
    return run(['sessions', 'meta', 'outbox'], 'readwrite', async (tx) => {
      const session = await tx.objectStore('sessions').get(sessionId);
      if (!session) return null;
      if (session.status === 'active') {
        session.status = 'ended';
        session.endedAt = now;
        session.attempt = null;
        await tx.objectStore('sessions').put(session);
        await markChanged(tx, [['sessions', session.id]], now);
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
    await run(['reflections', 'meta', 'outbox'], 'readwrite', async (tx) => {
      await tx.objectStore('reflections').add(reflection);
      await markChanged(tx, [['reflections', reflection.id]], now);
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
      // Queue every insert at once rather than awaiting each in turn: a single
      // failure still aborts the whole transaction, and large restores stay fast.
      await Promise.all([
        ...data.cards.map((c) => tx.objectStore('cards').add(c)),
        ...data.schedules.map((s) => tx.objectStore('schedules').add(s)),
        ...data.reviews.map((r) => tx.objectStore('reviews').add(r)),
        ...data.sessions.map((s) => tx.objectStore('sessions').add(s)),
        ...data.reflections.map((r) => tx.objectStore('reflections').add(r)),
        ...data.rubrics.map((r) => tx.objectStore('rubrics').add(r)),
        ...data.assessments.map((a) => tx.objectStore('assessments').add(a)),
      ]);
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
    getSyncConfig,
    getSyncStatus,
    connectSync,
    disconnectSync,
    readOutbox,
    applySyncBatch,
    recordSyncAttempt,
    addCards,
    addMissingCards,
    updateCard,
    applyOptions,
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
    pickOption,
    commitReview,
    commitQuickCheck,
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
