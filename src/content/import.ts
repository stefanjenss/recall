// Content import: parse pasted text or files (JSON or TSV), then validate and
// flag duplicates as a whole batch before anything is written.

import {
  duplicateKey,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_CARDS,
  validateCardInput,
  type CardInput,
  type FieldError,
} from '../domain/limits';
import type { Card, CardContent } from '../domain/types';

export type ImportFormat = 'json' | 'tsv';

export interface ImportRow {
  key: string;
  /** "Card 3" for JSON, "Line 7" for TSV. */
  label: string;
  input: CardInput;
  /** A structural problem with the row itself, cleared once the learner edits the row. */
  rowError: string | null;
}

export type ParseResult =
  | { ok: true; format: ImportFormat; rows: ImportRow[]; notes: string[] }
  | { ok: false; error: string };

const ALLOWED_EXTENSIONS = ['.json', '.tsv', '.txt'];

export function checkImportFile(name: string, size: number): string | null {
  const lower = name.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return `“${name}” isn't a supported file. Use a .json, .tsv, or .txt file.`;
  }
  if (size > IMPORT_MAX_BYTES) {
    return `“${name}” is ${(size / 1024 / 1024).toFixed(1)} MB. Content imports are limited to 2 MB; split the file into smaller parts.`;
  }
  return null;
}

export function checkImportText(text: string): string | null {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > IMPORT_MAX_BYTES) {
    return `The pasted text is ${(bytes / 1024 / 1024).toFixed(1)} MB. Content imports are limited to 2 MB.`;
  }
  return null;
}

export function detectFormat(text: string, fileName?: string): ImportFormat {
  const lower = fileName?.toLowerCase() ?? '';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.tsv')) return 'tsv';
  const first = text.replace(/^﻿/, '').trimStart()[0];
  return first === '[' || first === '{' ? 'json' : 'tsv';
}

export function parseImportText(text: string, fileName?: string): ParseResult {
  const clean = text.replace(/^﻿/, '');
  if (clean.trim() === '') return { ok: false, error: 'There is nothing to import yet. Paste cards or choose a file.' };
  const format = detectFormat(clean, fileName);
  return format === 'json' ? parseJson(clean) : parseTsv(clean);
}

const KNOWN_FIELDS = ['topic', 'question', 'answer', 'kind', 'source'] as const;

function parseJson(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `This isn't valid JSON (${detail}). Check that the assistant returned only the JSON block.` };
  }

  const notes: string[] = [];
  let items: unknown[];
  if (Array.isArray(value)) {
    items = value;
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.format === 'recall-backup') {
      return { ok: false, error: 'This is a full Recall backup. Restore it from Settings → Backups instead.' };
    }
    if (!Array.isArray(obj.cards)) {
      return { ok: false, error: 'JSON must be an array of cards, or an object with a "cards" array.' };
    }
    items = obj.cards;
    if (obj.format === 'recall-v1' || obj.version === 'recall-v1' || obj.version === 1) {
      notes.push('Recognised a recall-v1 content export.');
    }
  } else {
    return { ok: false, error: 'JSON must be an array of cards, or an object with a "cards" array.' };
  }

  if (items.length === 0) return { ok: false, error: 'The file contains no cards.' };

  const rows: ImportRow[] = items.map((item, i) => {
    const label = `Card ${i + 1}`;
    const key = `json-${i}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { key, label, input: {}, rowError: 'This entry is not a card object.' };
    }
    const obj = item as Record<string, unknown>;
    const input: CardInput = {};
    for (const field of KNOWN_FIELDS) if (field in obj) input[field] = obj[field];
    let rowError: string | null = null;
    if (!('question' in obj) && !('answer' in obj)) {
      const found = Object.keys(obj).slice(0, 6).join(', ') || 'none';
      rowError = `No "question" or "answer" field (found: ${found}).`;
    }
    return { key, label, input, rowError };
  });
  return { ok: true, format: 'json', rows, notes };
}

function parseTsv(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const rows: ImportRow[] = [];
  const notes: string[] = [];
  let headerChecked = false;

  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const cols = line.split('\t');
    if (!headerChecked) {
      headerChecked = true;
      const lowered = cols.map((c) => c.trim().toLowerCase());
      if (lowered[0] === 'question' && lowered[1] === 'answer' && (cols.length === 2 || lowered[2] === 'topic')) {
        notes.push('Skipped the header row.');
        return;
      }
    }
    const label = `Line ${i + 1}`;
    const key = `tsv-${i}`;
    const input: CardInput = { question: cols[0] ?? '', answer: cols[1] ?? '' };
    if (cols.length >= 3) input.topic = cols[2];
    let rowError: string | null = null;
    if (cols.length < 2) {
      rowError = 'Expected a question and an answer separated by a tab.';
    } else if (cols.length > 3) {
      rowError = `Expected at most 3 tab-separated columns (question, answer, topic); found ${cols.length}.`;
    }
    rows.push({ key, label, input, rowError });
  });

  if (rows.length === 0) return { ok: false, error: 'The text contains no cards.' };
  return { ok: true, format: 'tsv', rows, notes };
}

// ---------------------------------------------------------------------------
// Draft review

export interface ImportDraft extends ImportRow {
  removed: boolean;
  keepDuplicate: boolean;
}

export type DuplicateInfo =
  | { kind: 'existing'; cardId: string; topic: string }
  | { kind: 'batch'; label: string };

export interface DraftCheck {
  key: string;
  errors: FieldError[];
  rowError: string | null;
  content: CardContent | null;
  duplicate: DuplicateInfo | null;
}

export function toDrafts(rows: ImportRow[]): ImportDraft[] {
  return rows.map((row) => ({ ...row, removed: false, keepDuplicate: false }));
}

export function checkDrafts(drafts: ImportDraft[], existing: Card[]): DraftCheck[] {
  const existingByKey = new Map<string, Card>();
  for (const card of existing) {
    if (card.deletedAt !== null) continue;
    const k = duplicateKey(card.question);
    if (!existingByKey.has(k)) existingByKey.set(k, card);
  }
  const seen = new Map<string, string>();

  return drafts.map((draft) => {
    const { value, errors } = validateCardInput(draft.input);
    let duplicate: DuplicateInfo | null = null;
    if (value && !draft.removed) {
      const k = duplicateKey(value.question);
      const match = existingByKey.get(k);
      if (match) duplicate = { kind: 'existing', cardId: match.id, topic: match.topic };
      else if (seen.has(k)) duplicate = { kind: 'batch', label: seen.get(k)! };
      else seen.set(k, draft.label);
    }
    return { key: draft.key, errors, rowError: draft.rowError, content: value, duplicate };
  });
}

export interface ImportPlan {
  toAdd: CardContent[];
  errorRows: number;
  skippedDuplicates: number;
  keptDuplicates: number;
  removed: number;
  ready: boolean;
}

export function planImport(drafts: ImportDraft[], checks: DraftCheck[]): ImportPlan {
  const toAdd: CardContent[] = [];
  let errorRows = 0;
  let skippedDuplicates = 0;
  let keptDuplicates = 0;
  let removed = 0;
  drafts.forEach((draft, i) => {
    const check = checks[i]!;
    if (draft.removed) {
      removed += 1;
      return;
    }
    if (check.rowError || check.errors.length > 0 || !check.content) {
      errorRows += 1;
      return;
    }
    if (check.duplicate && !draft.keepDuplicate) {
      skippedDuplicates += 1;
      return;
    }
    if (check.duplicate) keptDuplicates += 1;
    toAdd.push(check.content);
  });
  return {
    toAdd,
    errorRows,
    skippedDuplicates,
    keptDuplicates,
    removed,
    ready: errorRows === 0 && toAdd.length > 0 && toAdd.length <= IMPORT_MAX_CARDS,
  };
}

/** Imports are reviewed and committed in batches of at most 100 cards. */
export function batchRanges(total: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < total; start += IMPORT_MAX_CARDS) {
    ranges.push({ start, end: Math.min(total, start + IMPORT_MAX_CARDS) });
  }
  return ranges;
}
