// The server's copy of the workspace, in SQLite (Node's built-in node:sqlite).
//
// One row per record: (store, key) → latest value, its clock stamp, and a
// sequence number that increases every time a row is written. Devices pull by
// sequence number, so they receive each record's latest version exactly once
// per change. A row also notes which device wrote it as sent, so that device
// isn't sent its own change back. SQLite is synchronous here and Node runs one
// request at a time, so each push is applied atomically and in order.

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { WorkspaceData } from '../src/content/backup';
import type { Preferences } from '../src/domain/types';
import { mergeRecord } from '../src/sync/merge';
import {
  SYNC_PROTOCOL,
  validateChange,
  type PushResult,
  type ServerInfo,
  type SyncRecord,
  type SyncStore,
} from '../src/sync/protocol';

const SCHEMA_VERSION = 1;

interface Row {
  store: string;
  key: string;
  seq: number;
  hlc: string;
  value: string;
}

export interface ServerStore {
  serverId(): string;
  info(now: number): ServerInfo;
  push(changes: unknown[], deviceId: string, now: number): PushResult[];
  /** Records written after `since`, leaving out those `deviceId` wrote itself. */
  pull(since: number, limit: number, deviceId: string): { changes: SyncRecord[]; cursor: number; more: boolean };
  /** Everything the server holds, in the backup format's shape. */
  exportData(): WorkspaceData;
  /** Delete every record and start a new server copy. Returns the new server ID. */
  reset(): string;
  close(): void;
}

export function openServerStore(path: string): ServerStore {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);

  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const putSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  );
  const getRow = db.prepare('SELECT store, key, seq, hlc, value FROM records WHERE store = ? AND key = ?');
  const upsertRow = db.prepare(
    `INSERT INTO records (store, key, seq, hlc, value, origin, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (store, key) DO UPDATE SET seq = excluded.seq, hlc = excluded.hlc, value = excluded.value,
       origin = excluded.origin, updated_at = excluded.updated_at`,
  );
  const pullRows = db.prepare(
    `SELECT store, key, seq, hlc, value FROM records
     WHERE seq > ? AND (origin IS NULL OR origin <> ?) ORDER BY seq LIMIT ?`,
  );
  const allRows = db.prepare('SELECT store, key, seq, hlc, value FROM records ORDER BY seq');
  const maxSeq = db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM records');
  const counts = db.prepare(
    `SELECT count(*) AS records,
       coalesce(sum(store = 'cards' AND json_extract(value, '$.deletedAt') IS NULL), 0) AS cards,
       coalesce(sum(store = 'reviews'), 0) AS reviews,
       coalesce(sum(store = 'reflections'), 0) AS reflections,
       coalesce(sum(store = 'sessions'), 0) AS sessions
     FROM records`,
  );

  // Sequence numbers keep increasing across resets, so a stale cursor can never
  // skip records written after a reset.
  let seq = Math.max(Number((maxSeq.get() as { seq: number }).seq), Number(setting('lastSeq') ?? 0));
  let serverId = setting('serverId') ?? '';
  if (!serverId) {
    serverId = randomUUID();
    putSetting.run('serverId', serverId);
  }

  function setting(key: string): string | null {
    const row = getSetting.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  function toRecord(row: Row): SyncRecord {
    return { store: row.store as SyncStore, key: row.key, seq: row.seq, hlc: row.hlc, value: JSON.parse(row.value) };
  }

  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /** `origin` is the device whose copy now matches this row exactly, or null after a merge. */
  function write(store: SyncStore, key: string, hlc: string, value: unknown, origin: string | null, now: number): SyncRecord {
    seq += 1;
    upsertRow.run(store, key, seq, hlc, JSON.stringify(value), origin, now);
    return { store, key, seq, hlc, value };
  }

  return {
    serverId: () => serverId,

    info(now) {
      const c = counts.get() as Record<string, number>;
      return {
        app: 'recall-sync',
        protocol: SYNC_PROTOCOL,
        serverId,
        serverTime: now,
        records: Number(c.records),
        counts: {
          cards: Number(c.cards),
          reviews: Number(c.reviews),
          reflections: Number(c.reflections),
          sessions: Number(c.sessions),
        },
      };
    },

    push(changes, deviceId, now) {
      return transaction(() => {
        const results = changes.map((raw): PushResult => {
          const checked = validateChange(raw);
          if (!checked.ok) {
            const r = (raw ?? {}) as Record<string, unknown>;
            return {
              store: String(r.store ?? ''),
              key: String(r.key ?? ''),
              hlc: String(r.hlc ?? ''),
              status: 'rejected',
              reason: checked.reason,
            };
          }
          const { store, key, hlc, value } = checked.change;
          const base = { store, key, hlc };
          const row = getRow.get(store, key) as Row | undefined;
          if (!row) {
            write(store, key, hlc, value, deviceId, now);
            return { ...base, status: 'applied' };
          }
          const merged = mergeRecord(store, { hlc: row.hlc, value: JSON.parse(row.value) }, { hlc, value });
          if (merged.outcome === 'incoming') {
            write(store, key, hlc, value, deviceId, now);
            return { ...base, status: 'applied' };
          }
          if (merged.outcome === 'merged' && !(merged.hlc === row.hlc && JSON.stringify(merged.value) === row.value)) {
            return { ...base, status: 'merged', record: write(store, key, merged.hlc, merged.value, null, now) };
          }
          return { ...base, status: 'kept', record: toRecord(row) };
        });
        putSetting.run('lastSeq', String(seq));
        return results;
      });
    },

    pull(since, limit, deviceId) {
      const rows = pullRows.all(since, deviceId, limit + 1) as unknown as Row[];
      const more = rows.length > limit;
      const page = (more ? rows.slice(0, limit) : rows).map(toRecord);
      // On the last page, skip past this device's own rows too.
      const cursor = more ? page[page.length - 1]!.seq : Math.max(since, seq);
      return { changes: page, cursor, more };
    },

    exportData() {
      const data: WorkspaceData = {
        cards: [],
        schedules: [],
        reviews: [],
        sessions: [],
        reflections: [],
        rubrics: [],
        assessments: [],
        preferences: null,
      };
      for (const row of allRows.all() as unknown as Row[]) {
        const value = JSON.parse(row.value);
        if (row.store === 'preferences') data.preferences = value as Preferences;
        else (data[row.store as Exclude<SyncStore, 'preferences'>] as unknown[]).push(value);
      }
      return data;
    },

    reset() {
      return transaction(() => {
        db.exec('DELETE FROM records');
        serverId = randomUUID();
        putSetting.run('serverId', serverId);
        putSetting.run('lastSeq', String(seq));
        return serverId;
      });
    },

    close() {
      db.close();
    },
  };
}

function migrate(db: DatabaseSync) {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version > SCHEMA_VERSION) {
    throw new Error(`The sync database uses schema ${version}, newer than this server supports (${SCHEMA_VERSION}).`);
  }
  if (version < 1) {
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE records (
        store TEXT NOT NULL,
        key TEXT NOT NULL,
        seq INTEGER NOT NULL UNIQUE,
        hlc TEXT NOT NULL,
        value TEXT NOT NULL,
        origin TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (store, key)
      ) WITHOUT ROWID;
      PRAGMA user_version = 1;
    `);
  }
}
