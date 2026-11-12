// Browser client for the sync server's AI feedback routes. Every failure
// becomes an AiClientError with a message the Practice screen can show next to
// the self-rating buttons, which keep working regardless.

import type { ErrorBody } from '../sync/protocol';
import {
  AI_API_PATH,
  type AiErrorCode,
  type AiInfo,
  type GradeRequest,
  type GradeResponse,
  type RubricDraftRequest,
  type RubricDraftResponse,
} from './protocol';

export type AiFailure = AiErrorCode | 'offline' | 'unauthorized' | 'not-supported' | 'bad-request' | 'server';

export class AiClientError extends Error {
  constructor(
    readonly kind: AiFailure,
    message: string,
  ) {
    super(message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const INFO_TIMEOUT_MS = 15_000;
/** Longer than the server's own provider timeout, so its explanation arrives rather than a bare abort. */
const SLACK_MS = 10_000;
const DEFAULT_WAIT_MS = 70_000;

const AI_CODES: readonly string[] = ['ai-disabled', 'ai-timeout', 'ai-unavailable', 'ai-malformed', 'ai-refused', 'ai-limit'];

export interface AiClient {
  info(): Promise<AiInfo>;
  grade(request: GradeRequest, waitMs?: number): Promise<GradeResponse>;
  draftRubric(request: RubricDraftRequest, waitMs?: number): Promise<RubricDraftResponse>;
}

export function createAiClient(opts: { url: string; key: string; fetch?: FetchLike }): AiClient {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = new URL(AI_API_PATH, opts.url);
  const host = new URL(opts.url).host;

  async function call<T>(path: string, method: 'GET' | 'POST', body: unknown, timeoutMs: number): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.key}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined;
    let response: Response;
    try {
      response = await doFetch(new URL(path, base).toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new AiClientError('ai-timeout', 'AI feedback took too long to arrive.');
      }
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      throw new AiClientError(
        'offline',
        offline ? "You're offline, so AI feedback isn't available right now." : `Couldn't reach your sync server at ${host}.`,
      );
    }
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      // Handled below.
    }
    if (!response.ok) {
      const error = parsed as Partial<ErrorBody> | null;
      const code = typeof error?.error === 'string' ? (error.error as string) : undefined;
      const message = typeof error?.message === 'string' ? error.message : undefined;
      if (response.status === 401) throw new AiClientError('unauthorized', 'Your sync server rejected the sync key.');
      if (code && AI_CODES.includes(code)) throw new AiClientError(code as AiErrorCode, message ?? 'AI feedback failed.');
      if (response.status === 404) {
        throw new AiClientError(
          'not-supported',
          "Your sync server doesn't offer AI feedback yet. Update it to this version of Recall.",
        );
      }
      if (code === 'bad-request') throw new AiClientError('bad-request', message ?? 'The server refused the request.');
      throw new AiClientError('server', message ?? `Your sync server answered with HTTP ${response.status}.`);
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new AiClientError('server', "Your sync server's answer wasn't readable.");
    }
    return parsed as T;
  }

  return {
    async info() {
      const info = await call<AiInfo>('info', 'GET', undefined, INFO_TIMEOUT_MS);
      if (info.app !== 'recall-ai' || typeof info.enabled !== 'boolean') {
        throw new AiClientError(
          'not-supported',
          "Your sync server doesn't offer AI feedback yet. Update it to this version of Recall.",
        );
      }
      return info;
    },
    grade: (request, waitMs = DEFAULT_WAIT_MS) => call<GradeResponse>('grade', 'POST', request, waitMs + SLACK_MS),
    draftRubric: (request, waitMs = DEFAULT_WAIT_MS) => call<RubricDraftResponse>('rubric', 'POST', request, waitMs + SLACK_MS),
  };
}
