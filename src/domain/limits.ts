import { CARD_KINDS, type CardContent, type CardKind } from './types';

export const LIMITS = {
  topic: 100,
  question: 3000,
  answer: 10_000,
  source: 1000,
  response: 10_000,
  reflection: 5000,
} as const;

export const DEFAULT_TOPIC = 'General';
export const DEFAULT_KIND: CardKind = 'recall';

export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_MAX_CARDS = 100;
export const BACKUP_MAX_BYTES = 50 * 1024 * 1024;

/** Length in Unicode code points, so an emoji counts as one character. */
export function charCount(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

export function overLimitMessage(label: string, value: string, limit: number): string | null {
  const n = charCount(value);
  if (n <= limit) return null;
  return `${label} is ${n.toLocaleString('en-US')} characters; the limit is ${limit.toLocaleString('en-US')}.`;
}

export type CardField = keyof CardContent;

export interface FieldError {
  field: CardField;
  message: string;
}

export interface CardInput {
  topic?: unknown;
  question?: unknown;
  answer?: unknown;
  kind?: unknown;
  source?: unknown;
}

const FIELD_LABELS: Record<CardField, string> = {
  topic: 'Topic',
  question: 'Question',
  answer: 'Answer',
  kind: 'Kind',
  source: 'Source',
};

export function parseKind(value: unknown): CardKind | null {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return DEFAULT_KIND;
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  return (CARD_KINDS as readonly string[]).includes(lower) ? (lower as CardKind) : null;
}

/**
 * Validate and normalise authored or imported card content. Question and
 * answer text is never altered; over-limit values are rejected rather than
 * truncated. Topic and source are trimmed; a blank topic becomes "General".
 */
export function validateCardInput(input: CardInput): { value: CardContent | null; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const text = (field: CardField, v: unknown): string | null => {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    errors.push({ field, message: `${FIELD_LABELS[field]} must be text.` });
    return null;
  };

  const topicRaw = text('topic', input.topic);
  const question = text('question', input.question);
  const answer = text('answer', input.answer);
  const sourceRaw = text('source', input.source);
  const kind = parseKind(input.kind);

  const topic = topicRaw === null ? null : topicRaw.trim() || DEFAULT_TOPIC;
  const source = sourceRaw === null ? null : sourceRaw.trim() || null;

  if (question !== null && question.trim() === '') errors.push({ field: 'question', message: 'Question is required.' });
  if (answer !== null && answer.trim() === '') errors.push({ field: 'answer', message: 'Answer is required.' });
  if (kind === null) {
    errors.push({
      field: 'kind',
      message: `Unknown kind "${String(input.kind)}". Use Recall, Apply, Compare, or Explain.`,
    });
  }

  const check = (field: CardField, v: string | null, limit: number) => {
    if (v === null) return;
    const msg = overLimitMessage(FIELD_LABELS[field], v, limit);
    if (msg) errors.push({ field, message: msg });
  };
  check('topic', topic, LIMITS.topic);
  check('question', question, LIMITS.question);
  check('answer', answer, LIMITS.answer);
  check('source', source, LIMITS.source);

  if (errors.length > 0 || topic === null || question === null || answer === null || kind === null) {
    return { value: null, errors };
  }
  return { value: { topic, question, answer, kind, source }, errors };
}

/** Normalised question text used for duplicate warnings. */
export function duplicateKey(question: string): string {
  return question.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}
