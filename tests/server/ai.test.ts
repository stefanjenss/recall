// The AI feedback proxy: the server routes, both provider adapters' handling
// of bad replies, and the browser client's checks, with a scripted model in
// place of a real one. What a real model actually answers is checked by
// tests/ai/real-provider.test.ts, which only runs when asked.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiClientError, createAiClient, type FetchLike } from '../../src/ai/client';
import { createServerEvaluator } from '../../src/ai/evaluator';
import { GRADING_SYSTEM_PROMPT } from '../../src/ai/prompt';
import type { GradeRequest } from '../../src/ai/protocol';
import type { Card, Rubric } from '../../src/domain/types';
import {
  AiError,
  createAiService,
  openAiCompatibleComplete,
  parseJsonObject,
  readAiConfig,
  type AiConfig,
  type Complete,
} from '../../server/ai';
import { createHandler } from '../../server/handler';
import { openServerStore, type ServerStore } from '../../server/store';
import { FIXTURES } from '../ai/fixtures';

const KEY = 'test-sync-key-0123456789';
const BASE = 'https://recall.test/';
const T0 = Date.UTC(2026, 10, 12, 18, 0, 0);

const config: AiConfig = {
  provider: 'openai-compatible',
  model: 'test-model',
  apiKey: 'provider-secret',
  baseUrl: 'http://127.0.0.1:11434/v1',
  timeoutMs: 200,
  dailyLimit: 5,
};

const fixture = FIXTURES[0]!;
const request: GradeRequest = {
  attemptId: 'attempt-1',
  cardId: 'card-1',
  cardVersion: 1,
  rubricVersion: 1,
  question: fixture.question,
  referenceAnswer: fixture.referenceAnswer,
  rubric: fixture.rubric,
  response: fixture.response,
};

const good = {
  status: 'assessed',
  criteria: [
    { id: 'c1', result: 'met', evidence: 'keep all the customers on the left' },
    { id: 'c2', result: 'met', evidence: 'come back as null' },
  ],
  incorrectClaims: [],
  contradictsReference: false,
  criticalMisconceptions: [],
  correctAspects: ['Left rows are kept.'],
  missingAspects: [],
  explanation: 'You covered both ideas.',
  uncertaintyReason: '',
};

let store: ServerStore;
let calls: Array<Parameters<Complete>[0]>;
let logs: string[];
let now: number;

beforeEach(() => {
  store = openServerStore(':memory:');
  calls = [];
  logs = [];
  now = T0;
});
afterEach(() => store.close());

function server(complete: Complete | null, overrides: Partial<AiConfig> = {}) {
  const ai = complete
    ? createAiService(
        { ...config, ...overrides },
        {
          complete: (r) => {
            calls.push(r);
            return complete(r);
          },
          now: () => now,
          log: (l) => logs.push(l),
        },
      )
    : null;
  const handle = createHandler({ store, syncKey: KEY, staticDir: null, backupDir: '/nonexistent', ai, log: (l) => logs.push(l) });
  const fetchImpl: FetchLike = (input, init) => handle(new Request(input, init));
  return { handle, client: createAiClient({ url: BASE, key: KEY, fetch: fetchImpl }) };
}

const replies =
  (value: unknown): Complete =>
  async () =>
    typeof value === 'string' ? value : JSON.stringify(value);

async function failure(promise: Promise<unknown>): Promise<AiClientError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AiClientError) return err;
    throw err;
  }
  throw new Error('Expected the request to fail.');
}

describe('configuration', () => {
  it('is off unless a provider is named', () => {
    expect(readAiConfig({})).toBeNull();
    expect(readAiConfig({ RECALL_AI_PROVIDER: '' })).toBeNull();
    expect(readAiConfig({ RECALL_AI_PROVIDER: 'off', ANTHROPIC_API_KEY: 'k' })).toBeNull();
  });

  it('Anthropic needs a key and defaults to Claude Haiku 5.5', () => {
    expect(() => readAiConfig({ RECALL_AI_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(readAiConfig({ RECALL_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' })).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      timeoutMs: 60_000,
      dailyLimit: 300,
    });
    expect(
      readAiConfig({ RECALL_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', RECALL_AI_MODEL: 'claude-sonnet-5-5' })?.model,
    ).toBe('claude-sonnet-5-5');
  });

  it('an OpenAI-compatible provider needs an address and a model; the key is optional', () => {
    expect(() => readAiConfig({ RECALL_AI_PROVIDER: 'openai-compatible', RECALL_AI_MODEL: 'm' })).toThrow(/RECALL_AI_BASE_URL/);
    expect(() => readAiConfig({ RECALL_AI_PROVIDER: 'openai-compatible', RECALL_AI_BASE_URL: 'http://x/v1' })).toThrow(
      /RECALL_AI_MODEL/,
    );
    expect(() =>
      readAiConfig({ RECALL_AI_PROVIDER: 'openai-compatible', RECALL_AI_BASE_URL: 'http://u:p@x/v1', RECALL_AI_MODEL: 'm' }),
    ).toThrow(/RECALL_AI_API_KEY/);
    expect(
      readAiConfig({
        RECALL_AI_PROVIDER: 'openai-compatible',
        RECALL_AI_BASE_URL: 'http://ollama:11434/v1/',
        RECALL_AI_MODEL: 'm',
      }),
    ).toMatchObject({ baseUrl: 'http://ollama:11434/v1', apiKey: null });
    expect(() => readAiConfig({ RECALL_AI_PROVIDER: 'gpt' })).toThrow(/anthropic/);
  });
});

describe('server routes', () => {
  it('says plainly when no provider is configured, and refuses to grade', async () => {
    const { client } = server(null);
    expect(await client.info()).toMatchObject({ app: 'recall-ai', enabled: false, provider: null, model: null });
    expect((await failure(client.grade(request))).kind).toBe('ai-disabled');
  });

  it('requires the sync key', async () => {
    const { handle } = server(replies(good));
    const info = await handle(new Request(`${BASE}api/ai/v1/info`));
    expect(info.status).toBe(401);
    const grade = await handle(
      new Request(`${BASE}api/ai/v1/grade`, {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong' },
        body: JSON.stringify(request),
      }),
    );
    expect(grade.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('reports the provider and model, and never the provider key', async () => {
    const { client, handle } = server(replies(good));
    const info = await client.info();
    expect(info).toMatchObject({ enabled: true, provider: 'openai-compatible', model: 'test-model', timeoutMs: 200 });
    expect(info.destination).toContain('127.0.0.1:11434');
    const raw = await (
      await handle(new Request(`${BASE}api/ai/v1/info`, { headers: { Authorization: `Bearer ${KEY}` } }))
    ).text();
    expect(raw).not.toContain('provider-secret');
  });

  it('grades: sends only the card, rubric, and answer as data, and returns the checked evaluation', async () => {
    const { client } = server(replies(good));
    const result = await client.grade(request);
    expect(result).toMatchObject({
      attemptId: 'attempt-1',
      cardVersion: 1,
      rubricVersion: 1,
      model: 'test-model',
      promptVersion: 'recall-grade-v1',
    });
    expect(result.evaluation.criteria.map((c) => c.result)).toEqual(['met', 'met']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toBe(GRADING_SYSTEM_PROMPT);
    expect(Object.keys(JSON.parse(calls[0]!.user)).sort()).toEqual(['learnerAnswer', 'question', 'referenceAnswer', 'rubric']);
    expect(JSON.parse(calls[0]!.user).learnerAnswer).toBe(fixture.response);
  });

  it('does not log card text, answers, or keys', async () => {
    const { client } = server(replies(good));
    await client.grade(request);
    const all = logs.join('\n');
    expect(all).toContain('ai grade ok');
    for (const secret of [fixture.response, fixture.question, 'provider-secret', KEY]) expect(all).not.toContain(secret);
  });

  it('a repeated request is answered from the cache, not by a second provider call', async () => {
    const { client } = server(replies(good));
    const [a, b] = await Promise.all([client.grade(request), client.grade(request)]);
    const c = await client.grade(request);
    expect(calls).toHaveLength(1);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    await client.grade({ ...request, response: 'A different answer about left rows.' });
    expect(calls).toHaveLength(2);
  });

  it('a failed request is not cached, so a retry asks again', async () => {
    let n = 0;
    const { client } = server(async () => (n++ === 0 ? 'not json at all' : JSON.stringify(good)));
    expect((await failure(client.grade(request))).kind).toBe('ai-malformed');
    expect((await client.grade(request)).evaluation.status).toBe('assessed');
    expect(calls).toHaveLength(2);
  });

  it('stops at the daily limit and starts again the next day', async () => {
    const { client } = server(replies(good), { dailyLimit: 2 });
    await client.grade({ ...request, attemptId: 'a1' });
    await client.grade({ ...request, attemptId: 'a2' });
    const err = await failure(client.grade({ ...request, attemptId: 'a3' }));
    expect(err.kind).toBe('ai-limit');
    expect(err.message).toMatch(/limit of 2/);
    expect(calls).toHaveLength(2);
    now += 24 * 60 * 60 * 1000;
    await client.grade({ ...request, attemptId: 'a3' });
    expect(calls).toHaveLength(3);
  });

  it.each([
    ['a blank answer', { response: '   ' }],
    ['an answer with nothing to grade', { response: '...' }],
    ['an oversized answer', { response: 'x'.repeat(10_001) }],
    ['no rubric', { rubric: { criteria: [], criticalMisconceptions: [] } }],
    ['a missing question', { question: '' }],
    ['a bad version', { cardVersion: 0 }],
  ])('refuses %s before calling the provider', async (_name, patch) => {
    const { client } = server(replies(good));
    expect((await failure(client.grade({ ...request, ...patch } as GradeRequest))).kind).toBe('bad-request');
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['prose instead of JSON', 'I think this answer is great!'],
    ['an unknown criterion', { ...good, criteria: [...good.criteria.slice(0, 1), { id: 'c9', result: 'met', evidence: '' }] }],
    ['a missing criterion', { ...good, criteria: good.criteria.slice(0, 1) }],
    ['an invented result value', { ...good, criteria: good.criteria.map((c) => ({ ...c, result: 'excellent' })) }],
    ['an unknown status', { ...good, status: 'pass' }],
    ['unable to assess without a reason', { ...good, status: 'unable_to_assess' }],
    ['an oversized explanation', { ...good, explanation: 'x'.repeat(4000) }],
  ])('rejects %s as malformed, with nothing to display', async (_name, reply) => {
    const { client } = server(replies(reply));
    const err = await failure(client.grade(request));
    expect(err.kind).toBe('ai-malformed');
  });

  it('a slow provider times out with a clear error', async () => {
    const { client } = server(
      ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      { timeoutMs: 30 },
    );
    const err = await failure(client.grade(request));
    expect(err.kind).toBe('ai-timeout');
    expect(logs.join('\n')).toContain('ai grade failed ai-timeout');
  });

  it('passes on a refusal and an unreachable provider', async () => {
    const refused = server(async () => {
      throw new AiError('ai-refused', 'The model declined to evaluate this content.');
    });
    expect((await failure(refused.client.grade(request))).kind).toBe('ai-refused');
    const down = server(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await failure(down.client.grade(request))).kind).toBe('ai-unavailable');
  });

  it('accepts an unable-to-assess result with a reason', async () => {
    const { client } = server(replies({ ...good, status: 'unable_to_assess', uncertaintyReason: 'The reference is ambiguous.' }));
    const result = await client.grade(request);
    expect(result.evaluation).toMatchObject({
      status: 'unable_to_assess',
      criteria: [],
      uncertaintyReason: 'The reference is ambiguous.',
    });
  });

  it('injected instructions in the answer stay inside the data and cannot change the instructions', async () => {
    const injection = FIXTURES.find((f) => f.name.startsWith('prompt injection wrapped'))!;
    const { client } = server(replies({ ...good, criteria: [good.criteria[0], { id: 'c2', result: 'missing', evidence: '' }] }));
    await client.grade({ ...request, response: injection.response });
    const sent = calls[0]!;
    expect(sent.system).toBe(GRADING_SYSTEM_PROMPT);
    expect(sent.system).not.toContain('admin mode');
    // The answer arrives intact as one JSON string value: its fake closing tag and JSON are just text.
    const parsed = JSON.parse(sent.user);
    expect(parsed.learnerAnswer).toBe(injection.response);
    expect(Object.keys(parsed)).toHaveLength(4);
  });

  it('drafts a rubric, assigning IDs itself and checking the draft', async () => {
    const { client } = server(
      replies({
        criteria: [
          {
            id: 'ignored',
            description: 'Says every left row is kept',
            weight: 3,
            requiredConcepts: ['left rows kept'],
            acceptableAlternatives: [],
          },
          { description: 'Says unmatched right columns are NULL', weight: 2, requiredConcepts: [], acceptableAlternatives: [] },
        ],
        criticalMisconceptions: [],
      }),
    );
    const draft = await client.draftRubric({ question: fixture.question, referenceAnswer: fixture.referenceAnswer });
    expect(draft.rubric.criteria.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(draft.promptVersion).toBe('recall-rubric-v1');
    const bad = server(replies({ criteria: [], criticalMisconceptions: [] }));
    expect((await failure(bad.client.draftRubric({ question: 'q', referenceAnswer: 'a' }))).kind).toBe('ai-malformed');
  });

  it('an older server without AI routes is reported as not supporting it', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ error: 'not-found', message: 'No such endpoint.' }), { status: 404 });
    const client = createAiClient({ url: BASE, key: KEY, fetch: fetchImpl });
    expect((await failure(client.info())).kind).toBe('not-supported');
  });
});

describe('browser evaluator', () => {
  const card = {
    id: 'card-1',
    question: fixture.question,
    answer: fixture.referenceAnswer,
    contentVersion: 1,
  } as Card;
  const rubric: Rubric = {
    id: 'card-1',
    cardId: 'card-1',
    version: 1,
    ...fixture.rubric,
    reviewed: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const attempt = { id: 'attempt-1', cardId: 'card-1', cardVersion: 1, response: fixture.response };

  async function evaluator(fetchImpl?: FetchLike) {
    const { client } = server(replies(good));
    const used = fetchImpl ? createAiClient({ url: BASE, key: KEY, fetch: fetchImpl }) : client;
    return createServerEvaluator(used, await client.info());
  }

  it('turns a server result into a scored assessment bound to the attempt', async () => {
    const assessment = await (await evaluator()).grade({ attempt, card, rubric }, T0);
    expect(assessment).toMatchObject({
      id: 'attempt-1',
      cardVersion: 1,
      rubricVersion: 1,
      score: 1,
      label: 'correct',
      suggestedRating: 3,
      provider: 'openai-compatible',
      model: 'test-model',
      createdAt: T0,
      finalRating: null,
    });
  });

  it('discards a result for another attempt or version, and re-checks what the server sent', async () => {
    const answer =
      (body: unknown): FetchLike =>
      async () =>
        new Response(JSON.stringify(body), { status: 200 });
    const base = {
      attemptId: 'attempt-1',
      cardId: 'card-1',
      cardVersion: 1,
      rubricVersion: 1,
      evaluation: good,
      provider: 'p',
      model: 'm',
      promptVersion: 'v',
    };
    for (const patch of [{ attemptId: 'other' }, { cardVersion: 2 }, { rubricVersion: 2 }, { cardId: 'other' }]) {
      const err = await failure((await evaluator(answer({ ...base, ...patch }))).grade({ attempt, card, rubric }, T0));
      expect(err.kind).toBe('ai-malformed');
    }
    const tampered = { ...base, evaluation: { ...good, criteria: good.criteria.slice(1) } };
    expect((await failure((await evaluator(answer(tampered))).grade({ attempt, card, rubric }, T0))).kind).toBe('ai-malformed');
  });

  it('refuses to send an answer with nothing typed', async () => {
    const err = await failure((await evaluator()).grade({ attempt: { ...attempt, response: '  ' }, card, rubric }, T0));
    expect(err.kind).toBe('bad-request');
    expect(calls).toHaveLength(0);
  });
});

describe('OpenAI-compatible adapter', () => {
  const run = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) =>
    openAiCompatibleComplete(
      config,
      fetchImpl,
    )({
      system: 'sys',
      user: 'user',
      schemaName: 'recall_evaluation',
      schema: { type: 'object' },
      signal: new AbortController().signal,
    });
  const reply = (message: unknown, extra: Record<string, unknown> = {}, status = 200) =>
    new Response(JSON.stringify({ choices: [{ message, ...extra }] }), { status });

  it('posts a strict JSON-schema chat completion with the server’s key', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const text = await run(async (url, init) => {
      seen.push({ url, init });
      return reply({ content: '{"ok":true}' });
    });
    expect(text).toBe('{"ok":true}');
    expect(seen[0]!.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect((seen[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer provider-secret');
    const body = JSON.parse(String(seen[0]!.init!.body));
    expect(body).toMatchObject({
      model: 'test-model',
      stream: false,
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(body.tools).toBeUndefined();
  });

  it('falls back to plain JSON mode when the provider rejects a schema', async () => {
    const formats: string[] = [];
    await run(async (_url, init) => {
      const format = JSON.parse(String(init!.body)).response_format.type;
      formats.push(format);
      return format === 'json_schema' ? new Response('{}', { status: 400 }) : reply({ content: '{}' });
    });
    expect(formats).toEqual(['json_schema', 'json_object']);
  });

  it.each([
    ['a rejected key', () => new Response('{}', { status: 401 }), 'ai-unavailable'],
    ['an unknown model', () => new Response('{}', { status: 404 }), 'ai-unavailable'],
    ['a server error', () => new Response('{}', { status: 500 }), 'ai-unavailable'],
    ['a refusal', () => reply({ content: null, refusal: 'I cannot help with that.' }), 'ai-refused'],
    ['a content filter', () => reply({ content: '' }, { finish_reason: 'content_filter' }), 'ai-refused'],
    ['a cut-off reply', () => reply({ content: '{"sta' }, { finish_reason: 'length' }), 'ai-malformed'],
    ['a reply with no text', () => reply({}), 'ai-malformed'],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 }), 'ai-malformed'],
  ])('maps %s to an error', async (_name, respond, code) => {
    await expect(run(async () => respond())).rejects.toMatchObject({ code });
  });

  it('reports an unreachable provider without leaking the request', async () => {
    await expect(
      run(async () => {
        throw new TypeError('fetch failed');
      }),
    ).rejects.toMatchObject({ code: 'ai-unavailable', message: expect.stringContaining('127.0.0.1:11434') });
  });

  it('reads one JSON object out of a fenced or wrapped reply', () => {
    expect(parseJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('Here you go: {"a": {"b": 2}} Thanks!')).toEqual({ a: { b: 2 } });
    expect(() => parseJsonObject('no object here')).toThrow(AiError);
    expect(() => parseJsonObject('{broken')).toThrow(AiError);
  });
});
