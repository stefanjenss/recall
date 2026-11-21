// The AI feedback wire format, shared by the browser and the sync server. Pure.
//
// The browser never talks to a model provider. It asks the sync server, which
// holds any provider key and sends only what a request carries: one card's
// question and reference answer, its rubric, and one typed answer.

import { LIMITS } from '../domain/limits';
import { isGradable, validateRubricContent, type Evaluation, type RubricContent } from '../domain/grading';

export const AI_API_VERSION = 1;
/** Relative to the server's base URL. */
export const AI_API_PATH = `api/ai/v${AI_API_VERSION}/`;

/** Changes whenever the grading instructions change, so a result can be traced to them. */
export const GRADING_PROMPT_VERSION = 'recall-grade-v1';
export const RUBRIC_PROMPT_VERSION = 'recall-rubric-v1';

export type AiProviderKind = 'anthropic' | 'openai-compatible';

export interface AiInfo {
  app: 'recall-ai';
  enabled: boolean;
  /** null when no provider is configured. */
  provider: AiProviderKind | null;
  /** Where answers go, in words: "Anthropic (api.anthropic.com)" or the configured host. */
  destination: string | null;
  model: string | null;
  promptVersion: string;
  /** How long the server waits for the provider. */
  timeoutMs: number;
}

export interface GradeRequest {
  attemptId: string;
  cardId: string;
  cardVersion: number;
  rubricVersion: number;
  question: string;
  referenceAnswer: string;
  rubric: RubricContent;
  response: string;
}

export interface GradeResponse {
  attemptId: string;
  cardId: string;
  cardVersion: number;
  rubricVersion: number;
  /** Checked by the server against the rubric; the browser checks it again and computes the score. */
  evaluation: Evaluation;
  provider: AiProviderKind;
  model: string;
  promptVersion: string;
}

export interface RubricDraftRequest {
  question: string;
  referenceAnswer: string;
}

export interface RubricDraftResponse {
  /** A draft for the learner to review. IDs are assigned by the server. */
  rubric: RubricContent;
  provider: AiProviderKind;
  model: string;
  promptVersion: string;
}

export type AiErrorCode =
  /** No provider is configured on the server. */
  | 'ai-disabled'
  /** The provider didn't answer in time. */
  | 'ai-timeout'
  /** The provider couldn't be reached or answered with an error. */
  | 'ai-unavailable'
  /** The provider answered, but not with a usable result. */
  | 'ai-malformed'
  /** The provider declined to evaluate this content. */
  | 'ai-refused'
  /** The server's daily request limit was reached. */
  | 'ai-limit';

type Check<T> = { ok: true; value: T } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const length = (s: string) => [...s].length;

function text(o: Record<string, unknown>, key: string, max: number): string | null {
  const v = o[key];
  return typeof v === 'string' && v.trim() !== '' && length(v) <= max ? v : null;
}

export function validateGradeRequest(input: unknown): Check<GradeRequest> {
  if (!isObj(input)) return { ok: false, reason: 'Expected a grading request.' };
  const attemptId = text(input, 'attemptId', 100);
  const cardId = text(input, 'cardId', 100);
  if (!attemptId || !cardId) return { ok: false, reason: 'A grading request names its attempt and card.' };
  const { cardVersion, rubricVersion } = input;
  if (
    !Number.isInteger(cardVersion) ||
    !Number.isInteger(rubricVersion) ||
    (cardVersion as number) < 1 ||
    (rubricVersion as number) < 1
  ) {
    return { ok: false, reason: 'A grading request names the card and rubric versions.' };
  }
  const question = text(input, 'question', LIMITS.question);
  const referenceAnswer = text(input, 'referenceAnswer', LIMITS.answer);
  if (!question || !referenceAnswer) return { ok: false, reason: 'The question or reference answer is missing or too long.' };
  const response = text(input, 'response', LIMITS.response);
  if (!response || !isGradable(response)) return { ok: false, reason: 'AI feedback needs a typed answer.' };
  const rubric = validateRubricContent(input.rubric);
  if (!rubric.value) return { ok: false, reason: rubric.errors[0] ?? 'The rubric is malformed.' };
  return {
    ok: true,
    value: {
      attemptId,
      cardId,
      cardVersion: cardVersion as number,
      rubricVersion: rubricVersion as number,
      question,
      referenceAnswer,
      rubric: rubric.value,
      response,
    },
  };
}

export function validateRubricDraftRequest(input: unknown): Check<RubricDraftRequest> {
  if (!isObj(input)) return { ok: false, reason: 'Expected a rubric request.' };
  const question = text(input, 'question', LIMITS.question);
  const referenceAnswer = text(input, 'referenceAnswer', LIMITS.answer);
  if (!question || !referenceAnswer) return { ok: false, reason: 'The question or reference answer is missing or too long.' };
  return { ok: true, value: { question, referenceAnswer } };
}
