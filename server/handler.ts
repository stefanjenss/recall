// HTTP routes for the sync server, written against the WHATWG Request and
// Response types so tests can call them directly. main.ts adapts node:http.

import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { buildBackup } from '../src/content/backup';
import { parseHlc } from '../src/sync/hlc';
import {
  DEFAULT_PULL_LIMIT,
  MAX_BODY_BYTES,
  MAX_CLOCK_AHEAD_MS,
  MAX_PULL_LIMIT,
  MAX_PUSH_CHANGES,
  SERVER_ID_HEADER,
  SYNC_API_PATH,
  SYNC_API_ROOT,
  SYNC_PROTOCOL,
  type ErrorBody,
  type PullResponse,
  type PushResponse,
  type SyncErrorCode,
} from '../src/sync/protocol';
import type { ServerStore } from './store';

export interface HandlerOptions {
  store: ServerStore;
  /** The shared secret every sync request must present. */
  syncKey: string;
  /** Built app to serve at `/`, or null to serve only the API. */
  staticDir: string | null;
  /** Other origins allowed to call the API from a browser (CORS). */
  allowedOrigins?: string[];
  /** Where a copy of the data is saved before a reset. */
  backupDir: string;
  now?: () => number;
  log?: (line: string) => void;
}

const API = `/${SYNC_API_PATH}`;
const ANY_SYNC_API = `/${SYNC_API_ROOT}`;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// The app only talks to the server that serves it, renders card Markdown
// without raw HTML, and loads nothing from other sites.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: SyncErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function createHandler(options: HandlerOptions): (request: Request) => Promise<Response> {
  const { store, staticDir, backupDir } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const keyDigest = digest(options.syncKey);
  const allowed = new Set((options.allowedOrigins ?? []).map((o) => o.replace(/\/+$/, '')));
  const root = staticDir ? resolve(staticDir) : null;

  function corsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get('origin');
    if (!origin || !allowed.has(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': `Authorization, Content-Type, ${SERVER_ID_HEADER}`,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600',
      // Chrome asks before a public page may reach a private-network address.
      ...(request.headers.get('access-control-request-private-network') === 'true'
        ? { 'Access-Control-Allow-Private-Network': 'true' }
        : {}),
      Vary: 'Origin',
    };
  }

  function json(request: Request, status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        ...corsHeaders(request),
      },
    });
  }

  function error(request: Request, err: HttpError): Response {
    const body: ErrorBody = { error: err.code, message: err.message };
    return json(request, err.status, body);
  }

  function authorize(request: Request) {
    const header = request.headers.get('authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match || !timingSafeEqual(digest(match[1]!.trim()), keyDigest)) {
      throw new HttpError(401, 'unauthorized', 'The sync key is missing or wrong.');
    }
  }

  function requireServer(request: Request) {
    const expected = request.headers.get(SERVER_ID_HEADER);
    if (expected !== store.serverId()) {
      throw new HttpError(409, 'server-changed', "The server's data was replaced or reset. Reconnect this device.");
    }
  }

  async function readJson(request: Request): Promise<unknown> {
    const length = Number(request.headers.get('content-length') ?? '0');
    if (length > MAX_BODY_BYTES) throw new HttpError(413, 'too-large', 'The request is too large.');
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'too-large', 'The request is too large.');
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, 'bad-request', 'The request body is not valid JSON.');
    }
  }

  async function api(request: Request, path: string, url: URL): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    authorize(request);
    const route = `${request.method} ${path}`;
    switch (route) {
      case 'GET info':
        return json(request, 200, store.info(now()));

      case 'POST push': {
        requireServer(request);
        const body = (await readJson(request)) as { changes?: unknown; deviceId?: unknown };
        if (!body || !Array.isArray(body.changes)) throw new HttpError(400, 'bad-request', 'Expected a list of changes.');
        if (!isDeviceId(body.deviceId)) throw new HttpError(400, 'bad-request', 'Expected a device ID.');
        if (body.changes.length > MAX_PUSH_CHANGES) {
          throw new HttpError(413, 'too-large', `Send at most ${MAX_PUSH_CHANGES} changes at a time.`);
        }
        const serverNow = now();
        for (const c of body.changes) {
          const hlc = parseHlc(String((c as { hlc?: unknown } | null)?.hlc ?? ''));
          if (hlc && hlc.ms > serverNow + MAX_CLOCK_AHEAD_MS) {
            throw new HttpError(
              422,
              'clock-ahead',
              "This device's clock is more than a day ahead of the server's. Correct its date and time, then sync again.",
            );
          }
        }
        const results = store.push(body.changes, body.deviceId, serverNow);
        const response: PushResponse = { results, serverTime: serverNow };
        const counts = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
        log(`push ${results.length} ${JSON.stringify(counts)}`);
        return json(request, 200, response);
      }

      case 'GET pull': {
        requireServer(request);
        const since = Number(url.searchParams.get('since') ?? '0');
        const limit = Number(url.searchParams.get('limit') ?? DEFAULT_PULL_LIMIT);
        const device = url.searchParams.get('device') ?? '';
        if (device !== '' && !isDeviceId(device)) throw new HttpError(400, 'bad-request', '`device` is malformed.');
        if (!Number.isSafeInteger(since) || since < 0) throw new HttpError(400, 'bad-request', '`since` must be a whole number.');
        if (!Number.isSafeInteger(limit) || limit < 1) throw new HttpError(400, 'bad-request', '`limit` must be positive.');
        const page = store.pull(since, Math.min(limit, MAX_PULL_LIMIT), device);
        const response: PullResponse = { ...page, serverTime: now() };
        return json(request, 200, response);
      }

      case 'POST reset': {
        const body = (await readJson(request)) as { serverId?: unknown };
        if (!body || body.serverId !== store.serverId()) {
          throw new HttpError(409, 'server-changed', "The server's data changed since you checked it. Check again first.");
        }
        const at = now();
        if (store.info(at).records > 0) {
          await mkdir(backupDir, { recursive: true });
          const file = join(backupDir, `before-reset-${new Date(at).toISOString().replace(/[:.]/g, '-')}.json`);
          await writeFile(file, JSON.stringify(buildBackup(store.exportData(), at)), { mode: 0o600 });
          log(`reset: saved the previous data to ${file}`);
        }
        store.reset();
        log('reset: server data replaced');
        return json(request, 200, store.info(now()));
      }

      default:
        if (['info', 'push', 'pull', 'reset'].includes(path)) {
          throw new HttpError(405, 'method-not-allowed', `${request.method} isn't supported here.`);
        }
        throw new HttpError(404, 'not-found', 'No such sync endpoint.');
    }
  }

  async function serveStatic(request: Request, pathname: string): Promise<Response> {
    const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (!root) return notFound();
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return notFound();
    }
    if (rel.includes('\0')) return notFound();
    if (rel.endsWith('/')) rel += 'index.html';
    const file = resolve(root, `.${rel}`);
    if (!file.startsWith(root + sep)) return notFound();
    try {
      const info = await stat(file);
      if (!info.isFile()) return notFound();
    } catch {
      return notFound();
    }
    const body = await readFile(file);
    const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers: Record<string, string> = {
      'Content-Type': type,
      'Content-Length': String(body.byteLength),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Vite fingerprints everything under assets/; other files can change between deploys.
      'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (type.startsWith('text/html')) {
      headers['Content-Security-Policy'] = CSP;
      headers['X-Frame-Options'] = 'DENY';
    }
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') {
        return json(request, 200, { ok: true, app: 'recall-sync' });
      }
      if (url.pathname.startsWith(API)) {
        return await api(request, url.pathname.slice(API.length), url);
      }
      if (url.pathname.startsWith(ANY_SYNC_API)) {
        // An app built for another protocol. Refuse before reading anything, so nothing is half-applied.
        throw new HttpError(
          404,
          'not-found',
          `This sync server speaks protocol ${SYNC_PROTOCOL}, and this copy of Recall doesn't. Reload the page to update Recall; changes stay on this device until then.`,
        );
      }
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'not-found', 'No such endpoint.');
      return await serveStatic(request, url.pathname);
    } catch (err) {
      if (err instanceof HttpError) return error(request, err);
      log(`error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return error(request, new HttpError(500, 'internal', 'The server ran into a problem. Check its log.'));
    }
  };
}
