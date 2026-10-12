// One sync pass: push this device's queued changes, then pull everything new
// from the server. Every step is committed locally in its own transaction
// together with its bookkeeping, so an interrupted pass resumes cleanly.

import { newId } from '../domain/ids';
import { outboxId, type Repository, type SyncConfig } from '../storage/repository';
import { createSyncClient, SyncError, type FetchLike } from './client';
import { DEFAULT_PULL_LIMIT, MAX_PUSH_CHANGES, type ServerInfo, type SyncRecord, type SyncStore } from './protocol';

const OUTBOX_BATCH = 200;
/** Keep each push request well under the server's body limit. */
const PUSH_MAX_BYTES = 4 * 1024 * 1024;
/** A safety stop in case changes keep arriving faster than they upload. */
const MAX_PUSH_ROUNDS = 1000;

export interface SyncOutcome {
  pushed: number;
  pulled: number;
  /** Records from the server written to this device. */
  applied: number;
  rejected: number;
}

interface SyncDeps {
  fetch?: FetchLike;
  now: () => number;
  pullLimit?: number;
}

/** Run one pass. Returns null if this device isn't connected (or disconnects mid-pass). */
export async function runSync(repo: Repository, deps: SyncDeps): Promise<SyncOutcome | null> {
  const config = await repo.getSyncConfig();
  if (!config) return null;
  const client = createSyncClient({ url: config.url, key: config.key, serverId: config.serverId, fetch: deps.fetch });
  const outcome: SyncOutcome = { pushed: 0, pulled: 0, applied: 0, rejected: 0 };
  try {
    let previous = '';
    for (let round = 0; round < MAX_PUSH_ROUNDS; round += 1) {
      const { items, stale } = await repo.readOutbox(OUTBOX_BATCH);
      const signature = items.map((i) => `${i.entry.id}@${i.entry.hlc}`).join('|');
      if (signature !== '' && signature === previous) {
        throw new SyncError('server', "The server didn't acknowledge this device's changes. Try again later.");
      }
      previous = signature;
      if (stale.length > 0) {
        const r = await repo.applySyncBatch({ serverId: config.serverId, acked: stale });
        if (r.disconnected) return null;
      }
      if (items.length === 0) {
        if (stale.length === 0) break;
        continue;
      }
      for (const chunk of chunkBySize(items, (i) => JSON.stringify(i.change).length)) {
        const response = await client.push(
          chunk.map((i) => i.change),
          config.deviceId,
        );
        const records: SyncRecord[] = [];
        let rejected = 0;
        let lastReason: string | null = null;
        for (const result of response.results) {
          if (result.record) records.push(result.record);
          if (result.status === 'rejected') {
            rejected += 1;
            lastReason = result.reason ?? lastReason;
          }
        }
        const r = await repo.applySyncBatch({
          serverId: config.serverId,
          acked: response.results.map((res) => ({ id: outboxId(res.store as SyncStore, res.key), hlc: res.hlc })),
          records,
          rejected: { count: rejected, lastReason },
        });
        if (r.disconnected) return null;
        outcome.pushed += chunk.length - rejected;
        outcome.rejected += rejected;
        outcome.applied += r.applied;
      }
    }

    let cursor = (await repo.getSyncStatus())?.cursor ?? 0;
    for (;;) {
      const page = await client.pull(cursor, deps.pullLimit ?? DEFAULT_PULL_LIMIT, config.deviceId);
      const r = await repo.applySyncBatch({ serverId: config.serverId, records: page.changes, cursor: page.cursor });
      if (r.disconnected) return null;
      outcome.pulled += page.changes.length;
      outcome.applied += r.applied;
      cursor = page.cursor;
      if (!page.more) break;
    }
    await repo.recordSyncAttempt(config.serverId, { ok: true, at: deps.now() });
    return outcome;
  } catch (err) {
    const error =
      err instanceof SyncError
        ? err
        : new SyncError('server', `Sync stopped: ${err instanceof Error ? err.message : String(err)}`);
    await repo.recordSyncAttempt(config.serverId, {
      ok: false,
      error: { kind: error.kind, message: error.message, at: deps.now() },
    });
    throw error;
  }
}

function chunkBySize<T>(items: T[], size: (item: T) => number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const n = size(item);
    if (current.length > 0 && (bytes + n > PUSH_MAX_BYTES || current.length >= MAX_PUSH_CHANGES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += n;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Check the address and key, and see what the server holds. Changes nothing. */
export function probeServer(url: string, key: string, fetchImpl?: FetchLike): Promise<ServerInfo> {
  return createSyncClient({ url, key, fetch: fetchImpl }).info();
}

/**
 * How a device joins:
 * - download: replace this device's data with the server's copy.
 * - upload: send this device's data; the server keeps whichever copy of each record changed last.
 * - replace-server: reset the server (it saves a backup first), then upload this device's data.
 */
export type JoinMode = 'download' | 'upload' | 'replace-server';

export async function connectDevice(
  repo: Repository,
  opts: { url: string; key: string; info: ServerInfo; mode: JoinMode } & SyncDeps,
): Promise<SyncOutcome | null> {
  let serverId = opts.info.serverId;
  if (opts.mode === 'replace-server') {
    const client = createSyncClient({ url: opts.url, key: opts.key, fetch: opts.fetch });
    serverId = (await client.reset(serverId)).serverId;
  }
  // A new device ID per connection, so the server never mistakes this
  // device's earlier uploads for records it already has.
  const config: SyncConfig = { url: opts.url, key: opts.key, deviceId: newId(), serverId, connectedAt: opts.now() };
  await repo.connectSync(config, opts.mode === 'download' ? 'download' : 'upload', opts.now());
  return runSync(repo, opts);
}
