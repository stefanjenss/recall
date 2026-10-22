// Options import: give existing cards multiple-choice options in bulk. Parse
// the assistant's reply, match each entry to a card by ID, and validate the
// options exactly as the card editor would, before anything is written.

import { sameChoices } from '../domain/choices';
import { IMPORT_MAX_CARDS, validateCardInput } from '../domain/limits';
import type { Card, CardChoices } from '../domain/types';

export const OPTIONS_FORMAT = 'recall-options-v1';

/** Active cards without options, optionally in one topic, by topic and then oldest first. */
export function cardsWithoutOptions(cards: Card[], topic: string | null = null): Card[] {
  return cards
    .filter((c) => c.deletedAt === null && c.choices === null && (!topic || c.topic === topic))
    .sort((a, b) => a.topic.localeCompare(b.topic) || a.createdAt - b.createdAt);
}

export interface OptionsRow {
  key: string;
  /** "Entry 3". */
  label: string;
  /** The card ID, trimmed; null when the entry has none. */
  cardId: string | null;
  choices: unknown;
  /** A structural problem with the entry itself. */
  rowError: string | null;
}

export type OptionsParseResult = { ok: true; rows: OptionsRow[] } | { ok: false; error: string };

const SHAPE_HINT = `JSON must be an object with "format": "${OPTIONS_FORMAT}" and an "options" list.`;

export function parseOptionsText(text: string): OptionsParseResult {
  const clean = text.replace(/^﻿/, '');
  if (clean.trim() === '') return { ok: false, error: 'There is nothing to preview yet. Paste the assistant’s reply.' };

  let value: unknown;
  try {
    value = JSON.parse(clean);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `This isn't valid JSON (${detail}). Check that the assistant returned only the JSON block.` };
  }

  let items: unknown[];
  if (Array.isArray(value)) {
    items = value;
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.format === 'recall-backup') {
      return { ok: false, error: 'This is a full Recall backup. Restore it from Settings → Backups instead.' };
    }
    if (Array.isArray(obj.cards) && !('options' in obj)) {
      return {
        ok: false,
        error: 'This is a list of new cards, not options for existing ones. Add it from Import cards instead.',
      };
    }
    if (obj.format !== undefined && obj.format !== OPTIONS_FORMAT) {
      return { ok: false, error: `Unknown format "${String(obj.format)}". ${SHAPE_HINT}` };
    }
    if (!Array.isArray(obj.options)) return { ok: false, error: SHAPE_HINT };
    items = obj.options;
  } else {
    return { ok: false, error: SHAPE_HINT };
  }

  if (items.length === 0) return { ok: false, error: 'The reply contains no options.' };
  if (items.length > IMPORT_MAX_CARDS) {
    return {
      ok: false,
      error: `The reply has ${items.length} entries. Add options to at most ${IMPORT_MAX_CARDS} cards at a time; split it into smaller parts.`,
    };
  }

  const rows = items.map((item, i): OptionsRow => {
    const row = { key: `entry-${i}`, label: `Entry ${i + 1}`, cardId: null, choices: null };
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ...row, rowError: 'This entry is not an object with an "id" and "choices".' };
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== 'string' || obj.id.trim() === '') {
      const found = Object.keys(obj).slice(0, 6).join(', ') || 'none';
      return { ...row, rowError: `This entry has no card "id" (found: ${found}).` };
    }
    if (!('choices' in obj)) return { ...row, cardId: obj.id.trim(), rowError: 'This entry has no "choices".' };
    return { ...row, cardId: obj.id.trim(), choices: obj.choices, rowError: null };
  });
  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// Preview

/**
 * - ready: the card has no options; these would be added.
 * - replace: the card already has different options; these would replace them.
 * - unchanged: the card already has exactly these options.
 * - none: the entry's options are null or blank.
 * - error, unknown, deleted, repeat: skipped, with the reason shown.
 */
export type OptionsStatus = 'ready' | 'replace' | 'unchanged' | 'none' | 'error' | 'unknown' | 'deleted' | 'repeat';

export interface OptionsCheck {
  key: string;
  label: string;
  status: OptionsStatus;
  cardId: string | null;
  card: Card | null;
  /** The validated, normalized options, for ready, replace, and unchanged entries. */
  choices: CardChoices | null;
  errors: string[];
  /** For a repeat: the earlier entry for the same card. */
  repeatOf: string | null;
}

/** `cards` should include deleted cards, so a deleted card is reported as deleted rather than unknown. */
export function checkOptions(rows: OptionsRow[], cards: Card[]): OptionsCheck[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const seen = new Map<string, string>();
  return rows.map((row): OptionsCheck => {
    const base = { key: row.key, label: row.label, cardId: row.cardId, card: null, choices: null, errors: [], repeatOf: null };
    if (row.rowError) return { ...base, status: 'error', errors: [row.rowError] };
    const card = row.cardId === null ? undefined : byId.get(row.cardId);
    if (!card) return { ...base, status: 'unknown' };
    if (card.deletedAt !== null) return { ...base, card, status: 'deleted' };
    const earlier = seen.get(card.id);
    if (earlier) return { ...base, card, status: 'repeat', repeatOf: earlier };
    seen.set(card.id, row.label);

    // The same validation as editing the card, with only the options changed.
    const { topic, question, answer, kind, source } = card;
    const { value, errors } = validateCardInput({ topic, question, answer, kind, source, choices: row.choices });
    if (!value) return { ...base, card, status: 'error', errors: errors.map((e) => e.message) };
    if (!value.choices) return { ...base, card, status: 'none' };
    const status = sameChoices(card.choices, value.choices) ? 'unchanged' : card.choices ? 'replace' : 'ready';
    return { ...base, card, choices: value.choices, status };
  });
}

/** What the repository writes for one card. `cardVersion` is the content version the preview showed. */
export interface OptionsUpdate {
  cardId: string;
  cardVersion: number;
  choices: CardChoices;
}

export interface OptionsPlan {
  updates: OptionsUpdate[];
  /** Cards without options that get them. */
  adding: number;
  /** Cards whose current options are replaced. */
  replacing: number;
  /** Cards with options of their own that keep them. */
  keeping: number;
  /** Ready entries the learner left out. */
  leftOut: number;
  errors: number;
  /** Unknown, deleted, repeated, unchanged, or empty entries. */
  skipped: number;
}

/**
 * Whether an entry is applied. Ready entries are, unless the learner leaves
 * them out; replacing options a card already has needs the learner's say-so.
 */
export function isIncluded(check: OptionsCheck, included: Record<string, boolean>): boolean {
  if (check.status !== 'ready' && check.status !== 'replace') return false;
  return included[check.key] ?? check.status === 'ready';
}

export function planOptions(checks: OptionsCheck[], included: Record<string, boolean>): OptionsPlan {
  const plan: OptionsPlan = { updates: [], adding: 0, replacing: 0, keeping: 0, leftOut: 0, errors: 0, skipped: 0 };
  for (const check of checks) {
    if (check.status === 'error') plan.errors += 1;
    else if (check.status === 'ready' || check.status === 'replace') {
      if (isIncluded(check, included)) {
        plan.updates.push({ cardId: check.card!.id, cardVersion: check.card!.contentVersion, choices: check.choices! });
        if (check.status === 'ready') plan.adding += 1;
        else plan.replacing += 1;
      } else if (check.status === 'ready') plan.leftOut += 1;
      else plan.keeping += 1;
    } else plan.skipped += 1;
  }
  return plan;
}
