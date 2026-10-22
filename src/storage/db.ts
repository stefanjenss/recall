import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import type { Assessment, Card, Reflection, Review, Rubric, Schedule, Session } from '../domain/types';
import { upgradeCard, upgradeReview, upgradeSchedule, upgradeSession } from '../domain/upgrade';
import type { SyncStore } from '../sync/protocol';

export const DB_NAME = 'recall';

/**
 * Storage schema version. Each bump adds a case to `upgrade` below; never
 * edit a past case. See docs/DATA.md for the history.
 */
export const DB_VERSION = 3;

export interface ImportBatchRecord {
  id: string;
  committedAt: number;
  cardIds: string[];
}

export interface MetaRecord {
  key: string;
  value: unknown;
}

/** A record changed on this device that the sync server hasn't acknowledged yet. */
export interface OutboxEntry {
  /** `${store}/${key}`: one entry per record, however many times it changed. */
  id: string;
  store: SyncStore;
  key: string;
  /** Clock stamp of the latest local change. */
  hlc: string;
}

export interface RecallSchema extends DBSchema {
  cards: { key: string; value: Card };
  schedules: { key: string; value: Schedule };
  reviews: {
    key: string;
    value: Review;
    indexes: { byCard: string; byCommittedAt: number; bySession: string };
  };
  sessions: { key: string; value: Session; indexes: { byStatus: string } };
  reflections: { key: string; value: Reflection; indexes: { byCreatedAt: number } };
  rubrics: { key: string; value: Rubric; indexes: { byCard: string } };
  assessments: { key: string; value: Assessment; indexes: { byAttempt: string } };
  /** Idempotency keys for content imports. A runtime cache: not included in backups. */
  importBatches: { key: string; value: ImportBatchRecord };
  /** Preferences and small bookkeeping values, keyed by name. */
  meta: { key: string; value: MetaRecord };
  /** Local changes waiting to sync. Only written while sync is connected. */
  outbox: { key: string; value: OutboxEntry };
}

export type StoreName =
  | 'cards'
  | 'schedules'
  | 'reviews'
  | 'sessions'
  | 'reflections'
  | 'rubrics'
  | 'assessments'
  | 'importBatches'
  | 'meta'
  | 'outbox';

export const ALL_STORES: StoreName[] = [
  'cards',
  'schedules',
  'reviews',
  'sessions',
  'reflections',
  'rubrics',
  'assessments',
  'importBatches',
  'meta',
  'outbox',
];

export type RecallDb = IDBPDatabase<RecallSchema>;

export interface OpenOptions {
  /** Another tab is waiting to upgrade the schema; this connection has been closed. */
  onVersionChange?: () => void;
}

type UpgradeTx = IDBPTransaction<RecallSchema, StoreNames<RecallSchema>[], 'versionchange'>;
type Backfilled = 'cards' | 'schedules' | 'reviews' | 'sessions';

/** Rewrite every record in a store. Only IDB requests are awaited, so the upgrade transaction stays open. */
async function backfill<S extends Backfilled>(
  tx: UpgradeTx,
  store: S,
  upgrade: (record: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  let cursor = await tx.objectStore(store).openCursor();
  while (cursor) {
    const record = cursor.value as unknown as Record<string, unknown>;
    await cursor.update(upgrade(record) as unknown as RecallSchema[S]['value']);
    cursor = await cursor.continue();
  }
}

export function openRecallDb(name: string = DB_NAME, opts: OpenOptions = {}): Promise<RecallDb> {
  return openDB<RecallSchema>(name, DB_VERSION, {
    async upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        db.createObjectStore('cards', { keyPath: 'id' });
        db.createObjectStore('schedules', { keyPath: 'cardId' });
        const reviews = db.createObjectStore('reviews', { keyPath: 'id' });
        reviews.createIndex('byCard', 'cardId');
        reviews.createIndex('byCommittedAt', 'committedAt');
        reviews.createIndex('bySession', 'sessionId');
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('byStatus', 'status');
        const reflections = db.createObjectStore('reflections', { keyPath: 'id' });
        reflections.createIndex('byCreatedAt', 'createdAt');
        const rubrics = db.createObjectStore('rubrics', { keyPath: 'id' });
        rubrics.createIndex('byCard', 'cardId');
        const assessments = db.createObjectStore('assessments', { keyPath: 'id' });
        assessments.createIndex('byAttempt', 'attemptId');
        db.createObjectStore('importBatches', { keyPath: 'id' });
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (oldVersion < 2) {
        db.createObjectStore('outbox', { keyPath: 'id' });
      }
      if (oldVersion < 3) {
        // Quick checks: optional card options, a quick-check counter on schedules,
        // review and session modes, and recall-sm2-v2 (v1 rating rules unchanged).
        // Not queued for sync: the sync server upgrades its own copies the same way.
        await Promise.all([
          backfill(tx, 'cards', upgradeCard),
          backfill(tx, 'schedules', upgradeSchedule),
          backfill(tx, 'reviews', upgradeReview),
          backfill(tx, 'sessions', upgradeSession),
        ]);
      }
      // Future migrations: `if (oldVersion < 4) { ... }`
    },
    blocking(_current, _next, event) {
      (event.target as IDBDatabase | null)?.close();
      opts.onVersionChange?.();
    },
  });
}
