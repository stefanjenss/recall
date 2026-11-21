// AI feedback for the sync server: a small proxy between the app and a model
// provider. The provider key (if any) lives only in this process's
// environment. Card text and answers pass through and are never stored or
// logged here.

import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import {
  newCriterionId,
  validateEvaluation,
  validateRubricContent,
  type Evaluation,
  type RubricContent,
} from '../src/domain/grading';
import {
  EVALUATION_SCHEMA,
  GRADING_SYSTEM_PROMPT,
  gradingUserMessage,
  RUBRIC_SCHEMA,
  RUBRIC_SYSTEM_PROMPT,
  rubricUserMessage,
} from '../src/ai/prompt';
import {
  GRADING_PROMPT_VERSION,
  RUBRIC_PROMPT_VERSION,
  type AiErrorCode,
  type AiInfo,
  type AiProviderKind,
  type GradeRequest,
  type GradeResponse,
  type RubricDraftRequest,
  type RubricDraftResponse,
} from '../src/ai/protocol';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-5-5';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_DAILY_LIMIT = 300;
const MAX_OUTPUT_TOKENS = 8000;
const CACHE_ENTRIES = 200;

export interface AiConfig {
  provider: AiProviderKind;
  model: string;
  /** Anthropic: the API key. OpenAI-compatible: optional (a local model needs none). */
  apiKey: string | null;
  /** OpenAI-compatible only: the API root, such as http://127.0.0.1:11434/v1. */
  baseUrl: string | null;
  timeoutMs: number;
  /** Provider requests allowed per UTC day, so a bug can't run up a bill. */
  dailyLimit: number;
}

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function positiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number, not ${value}.`);
  return n;
}

/** Read the AI settings from the environment. null means AI feedback is off. */
export function readAiConfig(env: Record<string, string | undefined>): AiConfig | null {
  const provider = (env.RECALL_AI_PROVIDER ?? '').trim().toLowerCase();
  if (provider === '' || provider === 'off' || provider === 'none') return null;
  const timeoutMs = positiveInt(env.RECALL_AI_TIMEOUT_MS, 'RECALL_AI_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const dailyLimit = positiveInt(env.RECALL_AI_DAILY_LIMIT, 'RECALL_AI_DAILY_LIMIT', DEFAULT_DAILY_LIMIT);
  const model = (env.RECALL_AI_MODEL ?? '').trim();
  if (provider === 'anthropic') {
    const apiKey = (env.ANTHROPIC_API_KEY ?? '').trim();
    if (!apiKey) throw new Error('RECALL_AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY.');
    return { provider, model: model || DEFAULT_ANTHROPIC_MODEL, apiKey, baseUrl: null, timeoutMs, dailyLimit };
  }
  if (provider === 'openai-compatible') {
    const raw = (env.RECALL_AI_BASE_URL ?? '').trim();
    if (!raw || !model) throw new Error('RECALL_AI_PROVIDER=openai-compatible needs RECALL_AI_BASE_URL and RECALL_AI_MODEL.');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`RECALL_AI_BASE_URL isn't a web address: ${raw}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error('RECALL_AI_BASE_URL must start with http:// or https://.');
    if (url.username || url.password) throw new Error('Put the provider key in RECALL_AI_API_KEY, not in RECALL_AI_BASE_URL.');
    const baseUrl = url.toString().replace(/\/+$/, '');
    return { provider, model, apiKey: (env.RECALL_AI_API_KEY ?? '').trim() || null, baseUrl, timeoutMs, dailyLimit };
  }
  throw new Error(`RECALL_AI_PROVIDER must be "anthropic" or "openai-compatible", not "${provider}".`);
}

/** Where answers are sent, for the app to show before anything is sent. */
export function destinationOf(config: AiConfig): string {
  if (config.provider === 'anthropic') return 'Anthropic (api.anthropic.com)';
  const host = new URL(config.baseUrl!).host;
  return /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || !host.includes('.')
    ? `a model on your own network (${host})`
    : host;
}

/** One request to a model: instructions, the material, and the JSON shape wanted back. Returns the model's text. */
export type Complete = (request: {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<string>;

export function anthropicComplete(config: AiConfig): Complete {
  const client = new Anthropic({ apiKey: config.apiKey ?? undefined, maxRetries: 1 });
  return async ({ system, user, schema, signal }) => {
    let message: Anthropic.Message;
    try {
      message = await client.messages.create(
        {
          model: config.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          messages: [{ role: 'user', content: user }],
          output_config: { format: { type: 'json_schema', schema } },
        },
        { signal, timeout: config.timeoutMs },
      );
    } catch (err) {
      if (signal.aborted || err instanceof Anthropic.APIConnectionTimeoutError) throw err;
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new AiError('ai-unavailable', 'Anthropic rejected the API key on the server.');
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new AiError('ai-unavailable', 'Anthropic is rate-limiting this key. Try again in a moment.');
      }
      if (err instanceof Anthropic.NotFoundError) {
        throw new AiError(
          'ai-unavailable',
          `Anthropic doesn't know the model "${config.model}". Check RECALL_AI_MODEL on the server.`,
        );
      }
      if (err instanceof Anthropic.APIConnectionError)
        throw new AiError('ai-unavailable', "The server couldn't reach Anthropic.");
      if (err instanceof Anthropic.APIError) {
        throw new AiError('ai-unavailable', `Anthropic answered with an error (HTTP ${err.status ?? 'unknown'}).`);
      }
      throw err;
    }
    if (message.stop_reason === 'refusal') throw new AiError('ai-refused', 'The model declined to evaluate this content.');
    if (message.stop_reason === 'max_tokens') throw new AiError('ai-malformed', "The model's reply was cut off.");
    return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Chat Completions, as spoken by Ollama, llama.cpp, vLLM, and hosted open-model providers. */
export function openAiCompatibleComplete(config: AiConfig, doFetch: FetchLike = (input, init) => fetch(input, init)): Complete {
  const url = `${config.baseUrl}/chat/completions`;
  const host = new URL(config.baseUrl!).host;
  return async ({ system, user, schemaName, schema, signal }) => {
    const call = async (responseFormat: unknown) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      try {
        return await doFetch(url, {
          method: 'POST',
          headers,
          signal,
          body: JSON.stringify({
            model: config.model,
            stream: false,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            response_format: responseFormat,
          }),
        });
      } catch (err) {
        if (signal.aborted) throw err;
        throw new AiError('ai-unavailable', `The server couldn't reach the model provider at ${host}.`);
      }
    };
    let response = await call({ type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } });
    // Some servers and models only support plain JSON mode; the reply is validated either way.
    if (response.status === 400 || response.status === 422) response = await call({ type: 'json_object' });
    if (response.status === 401 || response.status === 403) {
      throw new AiError('ai-unavailable', `The model provider at ${host} rejected the server's key.`);
    }
    if (response.status === 404) {
      throw new AiError('ai-unavailable', `The model provider at ${host} doesn't have the model "${config.model}".`);
    }
    if (!response.ok) throw new AiError('ai-unavailable', `The model provider at ${host} answered with HTTP ${response.status}.`);
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      if (signal.aborted) throw err;
      throw new AiError('ai-malformed', "The model provider's reply wasn't JSON.");
    }
    const choice = (body as { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }> })
      ?.choices?.[0];
    if (typeof choice?.message?.refusal === 'string' && choice.message.refusal !== '') {
      throw new AiError('ai-refused', 'The model declined to evaluate this content.');
    }
    if (choice?.finish_reason === 'content_filter')
      throw new AiError('ai-refused', 'The provider declined to evaluate this content.');
    if (choice?.finish_reason === 'length') throw new AiError('ai-malformed', "The model's reply was cut off.");
    const content = choice?.message?.content;
    if (typeof content !== 'string') throw new AiError('ai-malformed', "The model provider's reply had no text.");
    return content;
  };
}

/** Parse a model's reply as one JSON object, tolerating a code fence or a sentence around it. */
export function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AiError('ai-malformed', "The model's reply wasn't a JSON object.");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AiError('ai-malformed', "The model's reply wasn't valid JSON.");
  }
}

export interface AiService {
  info(): AiInfo;
  grade(request: GradeRequest): Promise<GradeResponse>;
  draftRubric(request: RubricDraftRequest): Promise<RubricDraftResponse>;
}

export interface AiServiceOptions {
  /** Replaces the provider call, for tests. */
  complete?: Complete;
  now?: () => number;
  log?: (line: string) => void;
}

export function disabledInfo(): AiInfo {
  return {
    app: 'recall-ai',
    enabled: false,
    provider: null,
    destination: null,
    model: null,
    promptVersion: GRADING_PROMPT_VERSION,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

export function createAiService(config: AiConfig, options: AiServiceOptions = {}): AiService {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const complete =
    options.complete ?? (config.provider === 'anthropic' ? anthropicComplete(config) : openAiCompatibleComplete(config));

  // Results by request content, so a repeated click or a retry after a dropped
  // connection gets the same answer without a second provider charge.
  const cache = new Map<string, GradeResponse>();
  const inFlight = new Map<string, Promise<GradeResponse>>();
  let day = '';
  let usedToday = 0;

  function spend() {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      usedToday = 0;
    }
    if (usedToday >= config.dailyLimit) {
      throw new AiError(
        'ai-limit',
        `The server reached its limit of ${config.dailyLimit} AI requests for today (RECALL_AI_DAILY_LIMIT). It resets at midnight UTC.`,
      );
    }
    usedToday += 1;
  }

  async function ask(kind: string, request: Omit<Parameters<Complete>[0], 'signal'>): Promise<unknown> {
    spend();
    const started = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const text = await complete({ ...request, signal: controller.signal });
      log(`ai ${kind} ok ${now() - started}ms ${config.model}`);
      return parseJsonObject(text);
    } catch (err) {
      const failure =
        err instanceof AiError
          ? err
          : controller.signal.aborted || (err instanceof Error && /timeout|timed out|abort/i.test(`${err.name} ${err.message}`))
            ? new AiError('ai-timeout', `The model didn't answer within ${Math.round(config.timeoutMs / 1000)} seconds.`)
            : null;
      // Provider error text can quote the request, so only its kind is logged.
      log(`ai ${kind} failed ${failure?.code ?? 'error'} ${now() - started}ms ${config.model}`);
      if (failure) throw failure;
      throw new AiError('ai-unavailable', 'The model provider failed in an unexpected way. Check the server log.');
    } finally {
      clearTimeout(timer);
    }
  }

  async function gradeOnce(request: GradeRequest): Promise<GradeResponse> {
    const raw = await ask('grade', {
      system: GRADING_SYSTEM_PROMPT,
      user: gradingUserMessage(request),
      schemaName: 'recall_evaluation',
      schema: EVALUATION_SCHEMA,
    });
    const checked = validateEvaluation(raw, request.rubric);
    if (!checked.ok) {
      log('ai grade rejected: malformed evaluation');
      throw new AiError('ai-malformed', `The model's evaluation didn't pass Recall's checks: ${checked.reason}`);
    }
    const evaluation: Evaluation = checked.value;
    return {
      attemptId: request.attemptId,
      cardId: request.cardId,
      cardVersion: request.cardVersion,
      rubricVersion: request.rubricVersion,
      evaluation,
      provider: config.provider,
      model: config.model,
      promptVersion: GRADING_PROMPT_VERSION,
    };
  }

  return {
    info: () => ({
      app: 'recall-ai',
      enabled: true,
      provider: config.provider,
      destination: destinationOf(config),
      model: config.model,
      promptVersion: GRADING_PROMPT_VERSION,
      timeoutMs: config.timeoutMs,
    }),

    grade(request) {
      const key = createHash('sha256')
        .update(JSON.stringify([GRADING_PROMPT_VERSION, config.provider, config.model, request]))
        .digest('hex');
      const cached = cache.get(key);
      if (cached) return Promise.resolve(cached);
      const running = inFlight.get(key);
      if (running) return running;
      const promise = gradeOnce(request)
        .then((result) => {
          cache.set(key, result);
          if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
          return result;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return promise;
    },

    async draftRubric(request) {
      const raw = await ask('rubric', {
        system: RUBRIC_SYSTEM_PROMPT,
        user: rubricUserMessage(request),
        schemaName: 'recall_rubric',
        schema: RUBRIC_SCHEMA,
      });
      // The model doesn't choose IDs: they are assigned here, in order.
      const source = raw as { criteria?: unknown; criticalMisconceptions?: unknown };
      const ids: string[] = [];
      const criteria = Array.isArray(source?.criteria)
        ? source.criteria.map((c) => {
            const id = newCriterionId(ids);
            ids.push(id);
            return c && typeof c === 'object' ? { ...(c as object), id } : c;
          })
        : source?.criteria;
      const checked = validateRubricContent({ criteria, criticalMisconceptions: source?.criticalMisconceptions });
      if (!checked.value) {
        log('ai rubric rejected: malformed draft');
        throw new AiError(
          'ai-malformed',
          `The model's draft didn't pass Recall's checks: ${checked.errors[0] ?? 'malformed rubric'}`,
        );
      }
      const rubric: RubricContent = checked.value;
      return { rubric, provider: config.provider, model: config.model, promptVersion: RUBRIC_PROMPT_VERSION };
    },
  };
}
