// End-to-end sync tests: two devices (separate IndexedDB databases) syncing
// through the real server handler and an in-memory SQLite store.

import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardContent } from '../../src/domain/types';
import { createRepository, type Repository } from '../../src/storage/repository';
import { SyncError, type FetchLike } from '../../src/sync/client';
import { connectDevice, probeServer, runSync, type JoinMode } from '../../src/sync/engine';
import { hlcAt } from '../../src/sync/hlc';
import { createHandler } from '../../server/handler';
import { openServerStore, type ServerStore } from '../../server/store';

const KEY = 'test-sync-key-0123456789';
const URL_BASE = 'https://recall.test/';
const T0 = Date.UTC(2026, 9, 12, 18, 0, 0);
const MIN = 60_000;

let dir: string;
let store: ServerStore;
let handle: (r: Request) => Promise<Response>;
let serverNow = T0;
let counter = 0;
const repos: Repository[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'recall-sync-'));
  store = openServerStore(':memory:');
  serverNow = T0;
  handle = createHandler({ store, syncKey: KEY, staticDir: null, backupDir: join(dir, 'backups'), now: () => serverNow });
});

afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.close()));
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const fetchImpl: FetchLike = (input, init) => handle(new Request(input, init));

function device(): Repository {
  const repo = createRepository(`recall-sync-test-${Date.now()}-${counter++}`);
  repos.push(repo);
  return repo;
}

const content = (question: string, topic = 'SQL'): CardContent => ({
  topic,
  question,
  answer: `Answer to ${question}`,
  kind: 'recall',
  source: null,
});

async function connect(repo: Repository, mode: JoinMode, now = T0) {
  const info = await probeServer(URL_BASE, KEY, fetchImpl);
  return connectDevice(repo, { url: URL_BASE, key: KEY, info, mode, fetch: fetchImpl, now: () => now });
}

const sync = (repo: Repository, now = T0, pullLimit?: number) => runSync(repo, { fetch: fetchImpl, now: () => now, pullLimit });

async function review(repo: Repository, rating: 1 | 2 | 3 | 4, now: number) {
  const started = await repo.startSession({ topics: null, size: 1, now });
  if (started.status !== 'started') throw new Error(`expected a session, got ${started.status}`);
  const { session } = started.state;
  const attempt = session.attempt!;
  await repo.reveal(session.id, attempt.id, { response: 'from memory', confidence: 'somewhat' }, now);
  const result = await repo.commitReview(session.id, attempt.id, rating, now);
  if (result.status !== 'committed') throw new Error(`expected a commit, got ${result.status}`);
  return result.review;
}

async function api(path: string, init: RequestInit = {}, key: string | null = KEY) {
  const headers = new Headers(init.headers);
  if (key) headers.set('Authorization', `Bearer ${key}`);
  const res = await handle(new Request(new URL(path, URL_BASE), { ...init, headers }));
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

describe('sync server', () => {
  it('answers health checks without a key, and everything else only with the right key', async () => {
    expect((await api('api/health', {}, null)).body).toEqual({ ok: true, app: 'recall-sync' });
    expect((await api('api/sync/v1/info', {}, null)).status).toBe(401);
    expect((await api('api/sync/v1/info', {}, 'wrong-key-wrong-key')).status).toBe(401);
    const info = await api('api/sync/v1/info');
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ app: 'recall-sync', protocol: 1, records: 0 });
    expect(info.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses pushes and pulls aimed at a different server copy', async () => {
    const res = await api('api/sync/v1/pull?since=0', { headers: { 'X-Recall-Server': 'not-this-one' } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('server-changed');
  });

  it('rejects invalid records individually and keeps the valid ones', async () => {
    const serverId = store.serverId();
    const res = await api('api/sync/v1/push', {
      method: 'POST',
      headers: { 'X-Recall-Server': serverId, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'dev-a',
        changes: [
          {
            store: 'reflections',
            key: 'r1',
            hlc: hlcAt(T0, 'dev-a'),
            value: { id: 'r1', sessionId: null, body: 'Ok', createdAt: T0 },
          },
          {
            store: 'reflections',
            key: 'r2',
            hlc: hlcAt(T0, 'dev-a'),
            value: { id: 'r2', sessionId: null, body: '', createdAt: T0 },
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['applied', 'rejected']);
    expect(store.info(T0).counts.reflections).toBe(1);
  });

  it('refuses changes stamped more than a day ahead of its clock', async () => {
    const res = await api('api/sync/v1/push', {
      method: 'POST',
      headers: { 'X-Recall-Server': store.serverId() },
      body: JSON.stringify({
        deviceId: 'dev-a',
        changes: [
          {
            store: 'reflections',
            key: 'r1',
            hlc: hlcAt(T0 + 2 * 86_400_000, 'dev-a'),
            value: { id: 'r1', sessionId: null, body: 'Ok', createdAt: T0 },
          },
        ],
      }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('clock-ahead');
    expect(store.info(T0).records).toBe(0);
  });

  it('serves the built app without leaving its folder, with a CSP on HTML', async () => {
    const site = join(dir, 'site');
    await mkdir(join(site, 'assets'), { recursive: true });
    await writeFile(join(site, 'index.html'), '<!doctype html><title>recall.</title>');
    await writeFile(join(site, 'assets', 'app-abc123.js'), 'console.log(1)');
    await writeFile(join(dir, 'secret.txt'), 'nope');
    const h = createHandler({ store, syncKey: KEY, staticDir: site, backupDir: dir });
    const get = (p: string) => h(new Request(`https://recall.test${p}`));

    const index = await get('/');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(index.headers.get('cache-control')).toBe('no-cache');
    const asset = await get('/assets/app-abc123.js');
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await get('/../secret.txt')).status).toBe(404);
    expect((await get('/%2e%2e/secret.txt')).status).toBe(404);
    expect((await get('/assets/%2e%2e%2f..%2fsecret.txt')).status).toBe(404);
    expect((await get('/missing.js')).status).toBe(404);
  });

  it('allows configured browser origins only', async () => {
    const h = createHandler({
      store,
      syncKey: KEY,
      staticDir: null,
      backupDir: dir,
      allowedOrigins: ['https://stefan.github.io'],
    });
    const preflight = (origin: string) =>
      h(new Request(`${URL_BASE}api/sync/v1/info`, { method: 'OPTIONS', headers: { Origin: origin } }));
    expect((await preflight('https://stefan.github.io')).headers.get('access-control-allow-origin')).toBe(
      'https://stefan.github.io',
    );
    expect((await preflight('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('two devices', () => {
  it('a new phone downloads the laptop’s collection, preferences included', async () => {
    const laptop = device();
    await laptop.addCards([content('Q1'), content('Q2', 'Python')], T0);
    await laptop.savePreferences(
      { schemaVersion: 1, timezone: 'Europe/Berlin', readingSize: 'large', sessionSize: 10, aiMode: 'disabled' },
      T0,
    );
    const up = await connect(laptop, 'upload');
    expect(up).toMatchObject({ pushed: 5, rejected: 0 });

    const phone = device();
    await connect(phone, 'download');
    const [l, p] = await Promise.all([laptop.loadWorkspace(), phone.loadWorkspace()]);
    expect(p.cards).toEqual(l.cards);
    expect(sortBy(p.schedules, 'cardId')).toEqual(sortBy(l.schedules, 'cardId'));
    expect(p.preferences).toMatchObject({ timezone: 'Europe/Berlin', readingSize: 'large', sessionSize: 10 });
    expect(await phone.getSyncStatus()).toMatchObject({ pending: 0, lastError: null, cursor: expect.any(Number) });
  });

  it('a review on the phone reaches the laptop with its schedule and finished session', async () => {
    const laptop = device();
    await laptop.addCards([content('Q1')], T0);
    await connect(laptop, 'upload');
    const phone = device();
    await connect(phone, 'download');

    const r = await review(phone, 3, T0 + MIN);
    expect((await phone.getSyncStatus())?.pending).toBe(3); // review, schedule, completed session
    await sync(phone, T0 + MIN);
    expect((await phone.getSyncStatus())?.pending).toBe(0);
    const pulled = await sync(laptop, T0 + 2 * MIN);
    expect(pulled).toMatchObject({ pulled: 3, applied: 3 });

    const ws = await laptop.loadWorkspace();
    expect(ws.reviews.map((x) => x.id)).toEqual([r.id]);
    expect(ws.schedules[0]).toMatchObject({ reviewCount: 1, stateVersion: 1, lastReviewedAt: T0 + MIN });
    expect(await laptop.getSession(r.sessionId!)).toMatchObject({ status: 'completed' });
  });

  it('keeps active sessions on their own device until they finish', async () => {
    const laptop = device();
    await laptop.addCards([content('Q1'), content('Q2')], T0);
    await connect(laptop, 'upload');
    const started = await laptop.startSession({ topics: null, size: 2, now: T0 });
    if (started.status !== 'started') throw new Error('expected a session');
    await sync(laptop);
    const phone = device();
    await connect(phone, 'download');
    expect((await phone.loadWorkspace()).activeSession).toBeNull();

    await laptop.endSession(started.state.session.id, T0 + MIN);
    await sync(laptop, T0 + MIN);
    await sync(phone, T0 + MIN);
    expect(await phone.getSession(started.state.session.id)).toMatchObject({ status: 'ended' });
  });

  it('does not send a device its own changes back', async () => {
    const laptop = device();
    await laptop.addCards([content('Q1'), content('Q2')], T0);
    await connect(laptop, 'upload');
    await laptop.addCards([content('Q3')], T0 + MIN);
    expect(await sync(laptop, T0 + MIN)).toMatchObject({ pushed: 2, pulled: 0 });
  });

  it('settles conflicting edits made offline on the later one, on both devices', async () => {
    const laptop = device();
    const [id] = (await laptop.addCards([content('Q1')], T0)).cardIds as [string];
    await connect(laptop, 'upload');
    const phone = device();
    await connect(phone, 'download');

    await laptop.updateCard(id, { ...content('Q1'), answer: 'Laptop answer' }, T0 + MIN);
    await phone.updateCard(id, { ...content('Q1'), answer: 'Phone answer, written later' }, T0 + 2 * MIN);
    await sync(laptop, T0 + 3 * MIN);
    await sync(phone, T0 + 3 * MIN);
    await sync(laptop, T0 + 3 * MIN);

    const [l, p] = await Promise.all([laptop.loadWorkspace(), phone.loadWorkspace()]);
    expect(l.cards[0]!.answer).toBe('Phone answer, written later');
    expect(p.cards).toEqual(l.cards);
  });

  it('a delete on one device wins over an edit made on the other before they synced', async () => {
    const laptop = device();
    const [id] = (await laptop.addCards([content('Q1')], T0)).cardIds as [string];
    await connect(laptop, 'upload');
    const phone = device();
    await connect(phone, 'download');

    await phone.deleteCard(id, T0 + MIN);
    await laptop.updateCard(id, { ...content('Q1'), answer: 'Edited after the delete' }, T0 + 2 * MIN);
    await sync(phone, T0 + 3 * MIN);
    await sync(laptop, T0 + 3 * MIN);
    await sync(phone, T0 + 3 * MIN);

    const [l, p] = await Promise.all([laptop.loadWorkspace(), phone.loadWorkspace()]);
    expect(l.cards[0]).toMatchObject({ deletedAt: T0 + MIN, answer: 'Edited after the delete' });
    expect(p.cards).toEqual(l.cards);
  });

  it('cards added on both devices while apart end up on both', async () => {
    const laptop = device();
    await connect(laptop, 'upload');
    const phone = device();
    await connect(phone, 'download');
    await laptop.addCards([content('From the laptop')], T0 + MIN);
    await phone.addCards([content('From the phone')], T0 + MIN);
    await sync(laptop, T0 + 2 * MIN);
    await sync(phone, T0 + 2 * MIN);
    await sync(laptop, T0 + 2 * MIN);
    for (const repo of [laptop, phone]) {
      const ws = await repo.loadWorkspace();
      expect(ws.cards.map((c) => c.question).sort()).toEqual(['From the laptop', 'From the phone']);
      expect(ws.schedules).toHaveLength(2);
    }
  });

  it('combining keeps the server’s newer copy of a record over an older local one', async () => {
    const laptop = device();
    const [id] = (await laptop.addCards([content('Q1')], T0)).cardIds as [string];
    await connect(laptop, 'upload');
    const phone = device();
    await connect(phone, 'download');
    await phone.disconnectSync();

    await review(laptop, 4, T0 + 10 * MIN);
    await sync(laptop, T0 + 10 * MIN);
    // The phone, reconnecting with its stale copy, combines rather than downloads.
    await connect(phone, 'upload', T0 + 20 * MIN);
    const schedule = (await phone.loadWorkspace()).schedules.find((s) => s.cardId === id);
    expect(schedule).toMatchObject({ reviewCount: 1, lastReviewedAt: T0 + 10 * MIN });
  });

  it('downloading replaces what was on the device, including an active session', async () => {
    const laptop = device();
    await laptop.addCards([content('Shared')], T0);
    await connect(laptop, 'upload');
    const phone = device();
    await phone.addCards([content('Phone only')], T0);
    await phone.startSession({ topics: null, size: 5, now: T0 });
    await connect(phone, 'download');
    const ws = await phone.loadWorkspace();
    expect(ws.cards.map((c) => c.question)).toEqual(['Shared']);
    expect(ws.activeSession).toBeNull();
  });

  it('replacing the server saves a backup there and makes other devices reconnect', async () => {
    const laptop = device();
    await laptop.addCards([content('Old')], T0);
    await connect(laptop, 'upload');
    const phone = device();
    await connect(phone, 'download');

    const fresh = device();
    await fresh.addCards([content('Restored')], T0 + MIN);
    await connect(fresh, 'replace-server', T0 + MIN);
    expect(store.info(T0).counts.cards).toBe(1);
    expect(store.exportData().cards.map((c) => c.question)).toEqual(['Restored']);
    const saved = await readdir(join(dir, 'backups'));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/^before-reset-.*\.json$/);

    await expect(sync(phone, T0 + 2 * MIN)).rejects.toMatchObject({ kind: 'server-changed' });
    expect((await phone.getSyncStatus())?.lastError).toMatchObject({ kind: 'server-changed' });
  });

  it('pulls a large collection across several pages', async () => {
    const laptop = device();
    await laptop.addCards(
      Array.from({ length: 30 }, (_, i) => content(`Q${i}`)),
      T0,
    );
    await connect(laptop, 'upload');
    const phone = device();
    const info = await probeServer(URL_BASE, KEY, fetchImpl);
    const result = await connectDevice(phone, {
      url: URL_BASE,
      key: KEY,
      info,
      mode: 'download',
      fetch: fetchImpl,
      now: () => T0,
      pullLimit: 7,
    });
    expect(result).toMatchObject({ pulled: 60 });
    expect((await phone.loadWorkspace()).cards).toHaveLength(30);
  });

  it('a change made while its earlier version is uploading stays queued', async () => {
    const laptop = device();
    const [id] = (await laptop.addCards([content('Q1')], T0)).cardIds as [string];
    await connect(laptop, 'upload');
    await laptop.updateCard(id, { ...content('Q1'), answer: 'First edit' }, T0 + MIN);
    let edited = false;
    const racing: FetchLike = async (input, init) => {
      if (!edited && input.includes('/push')) {
        edited = true;
        await laptop.updateCard(id, { ...content('Q1'), answer: 'Second edit' }, T0 + 2 * MIN);
      }
      return fetchImpl(input, init);
    };
    await runSync(laptop, { fetch: racing, now: () => T0 + 2 * MIN });
    expect((await laptop.getSyncStatus())?.pending).toBe(0);
    expect(store.exportData().cards[0]!.answer).toBe('Second edit');
  });

  it('records nothing for sync while disconnected, and forgets queued changes on disconnect', async () => {
    const laptop = device();
    await laptop.addCards([content('Q1')], T0);
    expect(await laptop.getSyncStatus()).toBeNull();
    await connect(laptop, 'upload');
    await laptop.disconnectSync();
    await laptop.addCards([content('Q2')], T0 + MIN);
    expect(await laptop.getSyncStatus()).toBeNull();
    expect((await laptop.readOutbox(10)).items).toHaveLength(0);
    expect(await sync(laptop)).toBeNull();
  });

  it('reports a wrong key and an unreachable server as errors it can explain', async () => {
    const laptop = device();
    await connect(laptop, 'upload');
    await expect(probeServer(URL_BASE, 'not-the-key-not-the-key', fetchImpl)).rejects.toMatchObject({ kind: 'unauthorized' });
    const offline: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    const err = await runSync(laptop, { fetch: offline, now: () => T0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe('offline');
    expect((await laptop.getSyncStatus())?.lastError).toMatchObject({ kind: 'offline' });
    await sync(laptop, T0 + MIN);
    expect((await laptop.getSyncStatus())?.lastError).toBeNull();
  });

  it('restoring a backup disconnects sync', async () => {
    const laptop = device();
    await laptop.addCards([content('Q1')], T0);
    await connect(laptop, 'upload');
    const data = await laptop.exportWorkspace();
    await laptop.replaceWorkspace(data);
    expect(await laptop.getSyncStatus()).toBeNull();
  });
});

function sortBy<T>(list: T[], key: keyof T): T[] {
  return [...list].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
}
