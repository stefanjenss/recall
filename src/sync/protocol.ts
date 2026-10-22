// The sync wire format, shared by the browser client and the server. Pure.
//
// A device pushes changed records and pulls everything the server has stored
// since its last cursor. Each record travels whole, stamped with the hybrid
// logical clock of the change that produced it (see hlc.ts). The server decides
// conflicts (see merge.ts) and gives every stored version a sequence number.

import { validateRecord } from '../content/backup';
import { isHlc } from './hlc';

/**
 * Protocol 2 carries quick-check record shapes (card options, review modes,
 * recall-sm2-v2 schedules). The version is part of the API path, so a device
 * and a server on different protocols refuse each other's requests outright
 * instead of rejecting, and then dropping, records the other can't read.
 */
export const SYNC_PROTOCOL = 2;
/** Relative to the server's base URL. */
export const SYNC_API_PATH = `api/sync/v${SYNC_PROTOCOL}/`;
/** Every sync API version lives under this path. */
export const SYNC_API_ROOT = 'api/sync/';
export const SERVER_ID_HEADER = 'X-Recall-Server';

export const SYNC_STORES = [
  'cards',
  'schedules',
  'reviews',
  'sessions',
  'reflections',
  'rubrics',
  'assessments',
  'preferences',
] as const;
export type SyncStore = (typeof SYNC_STORES)[number];

/** Preferences are a single record. */
export const PREFERENCES_KEY = 'preferences';

export const MAX_KEY_LENGTH = 200;
export const MAX_PUSH_CHANGES = 500;
export const MAX_PULL_LIMIT = 2000;
export const DEFAULT_PULL_LIMIT = 500;
/** Request bodies above this are refused. Clients batch well below it. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** A change stamped further ahead of the server's clock than this is refused. */
export const MAX_CLOCK_AHEAD_MS = 24 * 60 * 60 * 1000;

export interface SyncChange {
  store: SyncStore;
  key: string;
  hlc: string;
  value: unknown;
}

export interface SyncRecord extends SyncChange {
  seq: number;
}

export interface ServerCounts {
  cards: number;
  reviews: number;
  reflections: number;
  sessions: number;
}

export interface ServerInfo {
  app: 'recall-sync';
  protocol: typeof SYNC_PROTOCOL;
  /** Changes when the server's data is replaced, so devices know to reconnect. */
  serverId: string;
  serverTime: number;
  records: number;
  counts: ServerCounts;
}

export interface PushRequest {
  deviceId: string;
  changes: SyncChange[];
}

/**
 * - applied: stored as sent.
 * - merged: combined with the server's copy; `record` is the result.
 * - kept: the server's copy is newer; `record` is that copy.
 * - rejected: invalid; `reason` says why. The device keeps its copy but stops sending it.
 */
export type PushStatus = 'applied' | 'merged' | 'kept' | 'rejected';

export interface PushResult {
  store: string;
  key: string;
  hlc: string;
  status: PushStatus;
  reason?: string;
  record?: SyncRecord;
}

export interface PushResponse {
  results: PushResult[];
  serverTime: number;
}

export interface PullResponse {
  changes: SyncRecord[];
  /** Pass back as `since` to continue. */
  cursor: number;
  more: boolean;
  serverTime: number;
}

export interface ResetRequest {
  /** The server ID being replaced, so a stale screen can't wipe a newer copy. */
  serverId: string;
}

export type SyncErrorCode =
  | 'unauthorized'
  | 'server-changed'
  | 'clock-ahead'
  | 'bad-request'
  | 'too-large'
  | 'not-found'
  | 'method-not-allowed'
  | 'internal';

export interface ErrorBody {
  error: SyncErrorCode;
  message: string;
}

export function isSyncStore(value: unknown): value is SyncStore {
  return typeof value === 'string' && (SYNC_STORES as readonly string[]).includes(value);
}

/** The key a record is stored under, read from the record itself. */
export function keyOf(store: SyncStore, value: unknown): string | null {
  if (store === 'preferences') return PREFERENCES_KEY;
  if (!value || typeof value !== 'object') return null;
  const field = store === 'schedules' ? 'cardId' : 'id';
  const key = (value as Record<string, unknown>)[field];
  return typeof key === 'string' ? key : null;
}

/** Structural and content checks for one change. The same rules apply on both ends. */
export function validateChange(input: unknown): { ok: true; change: SyncChange } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'A change must be an object.' };
  const c = input as Record<string, unknown>;
  if (!isSyncStore(c.store)) return { ok: false, reason: `Unknown store ${JSON.stringify(c.store)}.` };
  if (typeof c.key !== 'string' || c.key === '' || c.key.length > MAX_KEY_LENGTH) {
    return { ok: false, reason: 'A change needs a key of 1 to 200 characters.' };
  }
  if (!isHlc(c.hlc)) return { ok: false, reason: 'A change needs a valid clock stamp.' };
  const store = c.store;
  const problems = validateRecord(store, c.value);
  if (problems.length > 0) return { ok: false, reason: problems.slice(0, 3).join(' ') };
  if (keyOf(store, c.value) !== c.key) return { ok: false, reason: `The key doesn't match the ${store} record.` };
  if (store === 'sessions' && (c.value as { status?: unknown }).status === 'active') {
    return { ok: false, reason: 'Sessions sync once they finish, not while they are active.' };
  }
  return { ok: true, change: { store, key: c.key, hlc: c.hlc, value: c.value } };
}
