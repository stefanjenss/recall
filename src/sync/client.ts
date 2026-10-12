// HTTP client for the sync server. Turns network and server failures into a
// SyncError with a kind the interface can explain.

import {
  SERVER_ID_HEADER,
  SYNC_API_PATH,
  type ErrorBody,
  type PullResponse,
  type PushResponse,
  type ServerInfo,
  type SyncChange,
} from './protocol';

export type SyncErrorKind = 'offline' | 'unauthorized' | 'server-changed' | 'clock-ahead' | 'server';

export class SyncError extends Error {
  constructor(
    readonly kind: SyncErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 30_000;

/**
 * Accept what a person is likely to type ("thinkcentre.example.ts.net",
 * "http://192.168.1.20:8787/") and return a base URL ending in "/".
 */
export function normalizeServerUrl(input: string): { ok: true; url: string } | { ok: false; message: string } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, message: 'Enter the address of your sync server.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: "That doesn't look like a web address." };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, message: 'Use an address that starts with https:// or http://.' };
  }
  if (url.username || url.password) return { ok: false, message: 'Leave the user name and password out of the address.' };
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return { ok: true, url: url.toString() };
}

/** Browsers block an http:// request from an https:// page, except to this machine. */
export function isBlockedMixedContent(serverUrl: string, pageProtocol: string): boolean {
  const url = new URL(serverUrl);
  if (pageProtocol !== 'https:' || url.protocol !== 'http:') return false;
  return !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export interface SyncClient {
  info(): Promise<ServerInfo>;
  push(changes: SyncChange[], deviceId: string): Promise<PushResponse>;
  pull(since: number, limit: number, deviceId: string): Promise<PullResponse>;
  reset(serverId: string): Promise<ServerInfo>;
}

export function createSyncClient(opts: { url: string; key: string; serverId?: string; fetch?: FetchLike }): SyncClient {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = new URL(SYNC_API_PATH, opts.url);

  async function call<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown; query?: Record<string, string> }) {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.key}` };
    if (opts.serverId) headers[SERVER_ID_HEADER] = opts.serverId;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const timeout = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: timeout,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      throw new SyncError(
        'offline',
        offline
          ? "You're offline. Changes are saved on this device and will sync when you reconnect."
          : `Couldn't reach the sync server at ${new URL(opts.url).host}. Check that it's running and that this device can reach it.`,
      );
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Handled below.
    }
    if (!response.ok) {
      const message = (body as ErrorBody | null)?.message;
      const code = (body as ErrorBody | null)?.error;
      if (response.status === 401) throw new SyncError('unauthorized', 'The server rejected the sync key.');
      if (response.status === 409 || code === 'server-changed') {
        throw new SyncError('server-changed', message ?? "The server's data was replaced or reset. Reconnect this device.");
      }
      if (code === 'clock-ahead') throw new SyncError('clock-ahead', message ?? "This device's clock is ahead of the server's.");
      if (code === undefined) {
        throw new SyncError('server', `That address answered with HTTP ${response.status}, not like a Recall sync server.`);
      }
      throw new SyncError('server', message ?? `The sync server answered with HTTP ${response.status}.`);
    }
    if (body === null) throw new SyncError('server', "That address didn't answer like a Recall sync server.");
    return body as T;
  }

  return {
    async info() {
      const info = await call<ServerInfo>('info', { method: 'GET' });
      if (info?.app !== 'recall-sync' || typeof info.serverId !== 'string') {
        throw new SyncError('server', "That address didn't answer like a Recall sync server.");
      }
      if (info.protocol !== 1) {
        throw new SyncError(
          'server',
          `The server speaks sync protocol ${info.protocol}; this app needs protocol 1. Update both.`,
        );
      }
      return info;
    },
    push: (changes, deviceId) => call<PushResponse>('push', { method: 'POST', body: { deviceId, changes } }),
    pull: (since, limit, deviceId) =>
      call<PullResponse>('pull', { method: 'GET', query: { since: String(since), limit: String(limit), device: deviceId } }),
    reset: (serverId) => call<ServerInfo>('reset', { method: 'POST', body: { serverId } }),
  };
}
