import { describe, expect, it } from 'vitest';
import {
  batchRanges,
  checkDrafts,
  checkImportFile,
  checkImportText,
  parseImportText,
  planImport,
  toDrafts,
  type ImportDraft,
} from '../../src/content/import';
import { buildContentExport } from '../../src/content/exportContent';
import { validateCardInput } from '../../src/domain/limits';
import type { Card } from '../../src/domain/types';

const NOW = Date.UTC(2026, 9, 12);

function existingCard(question: string, topic = 'SQL'): Card {
  return {
    id: `id-${question}`,
    topic,
    question,
    answer: 'a',
    kind: 'recall',
    source: null,
    contentVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

function parseOk(text: string, fileName?: string) {
  const result = parseImportText(text, fileName);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe('JSON import', () => {
  it('AC02: preserves recall-v1 content exactly — Unicode, code, and multiline answers', () => {
    const cards = [
      {
        topic: 'Python',
        kind: 'Apply',
        question: 'What does `yield` do?\n\nGive an example.',
        answer: '```python\ndef gen():\n    yield 1  # café ☕ 你好\n```\n\n  Indented line kept.  ',
        source: 'PEP 255',
      },
      { topic: 'Learning', kind: 'explain', question: 'Why space practice? 🧠', answer: 'Forgetting makes retrieval effortful.', source: null },
    ];
    const text = JSON.stringify({ format: 'recall-v1', cards });
    const parsed = parseOk(text);
    expect(parsed.format).toBe('json');
    expect(parsed.notes).toContain('Recognised a recall-v1 content export.');
    const drafts = toDrafts(parsed.rows);
    const checks = checkDrafts(drafts, []);
    const plan = planImport(drafts, checks);
    expect(plan.ready).toBe(true);
    expect(plan.toAdd).toHaveLength(2);
    expect(plan.toAdd[0]).toEqual({ ...cards[0], kind: 'apply' });
    expect(plan.toAdd[1]).toEqual(cards[1]);
  });

  it('round-trips the app’s own content export', () => {
    const card: Card = { ...existingCard('Q1'), answer: 'line 1\nline 2', source: 'src' };
    const exported = buildContentExport([card, { ...existingCard('gone'), deletedAt: NOW }], NOW);
    expect(exported.cards).toHaveLength(1);
    const plan = (() => {
      const drafts = toDrafts(parseOk(JSON.stringify(exported)).rows);
      return planImport(drafts, checkDrafts(drafts, []));
    })();
    expect(plan.toAdd).toEqual([{ topic: 'SQL', question: 'Q1', answer: 'line 1\nline 2', kind: 'recall', source: 'src' }]);
  });

  it('accepts a bare array and applies defaults for topic and kind', () => {
    const drafts = toDrafts(parseOk('[{"question":"Q","answer":"A"}]').rows);
    const [check] = checkDrafts(drafts, []);
    expect(check!.content).toEqual({ topic: 'General', question: 'Q', answer: 'A', kind: 'recall', source: null });
  });

  it('AC03: one invalid row makes the batch not ready and identifies the row', () => {
    const text = JSON.stringify([
      { question: 'Q1', answer: 'A1' },
      { question: 'Q2', answer: '' },
      { question: 'Q3', answer: 'A3', kind: 'flashcard' },
    ]);
    const drafts = toDrafts(parseOk(text).rows);
    const checks = checkDrafts(drafts, []);
    const plan = planImport(drafts, checks);
    expect(plan.ready).toBe(false);
    expect(plan.errorRows).toBe(2);
    expect(drafts[1]!.label).toBe('Card 2');
    expect(checks[1]!.errors).toEqual([{ field: 'answer', message: 'Answer is required.' }]);
    expect(checks[2]!.errors[0]!.field).toBe('kind');
  });

  it('removing or fixing the bad rows makes the batch ready', () => {
    const drafts = toDrafts(parseOk('[{"question":"Q1","answer":"A1"},{"question":"Q2"}]').rows);
    const removed: ImportDraft[] = drafts.map((d, i) => (i === 1 ? { ...d, removed: true } : d));
    expect(planImport(removed, checkDrafts(removed, [])).ready).toBe(true);
    const fixed: ImportDraft[] = drafts.map((d, i) => (i === 1 ? { ...d, input: { ...d.input, answer: 'A2' } } : d));
    expect(planImport(fixed, checkDrafts(fixed, [])).toAdd).toHaveLength(2);
  });

  it('rejects over-limit fields with a field-specific message instead of truncating', () => {
    const { value, errors } = validateCardInput({ question: 'q'.repeat(3001), answer: 'a' });
    expect(value).toBeNull();
    expect(errors).toEqual([{ field: 'question', message: 'Question is 3,001 characters; the limit is 3,000.' }]);
  });

  it('counts emoji as one character for limits', () => {
    expect(validateCardInput({ question: '🧠'.repeat(3000), answer: 'a' }).errors).toEqual([]);
  });

  it('flags non-card entries and unknown shapes', () => {
    const drafts = toDrafts(parseOk('["just text", {"front":"Q","back":"A"}]').rows);
    expect(drafts[0]!.rowError).toMatch(/not a card object/);
    expect(drafts[1]!.rowError).toMatch(/found: front, back/);
  });

  it('gives clear errors for unusable JSON', () => {
    expect(parseImportText('{"cards": 5}')).toMatchObject({ ok: false });
    expect(parseImportText('{oops')).toMatchObject({ ok: false });
    const backup = parseImportText('{"format":"recall-backup","formatVersion":1,"data":{}}');
    expect(backup.ok).toBe(false);
    if (!backup.ok) expect(backup.error).toMatch(/Restore it from Settings/);
  });
});

describe('TSV import', () => {
  it('reads question, answer, optional topic — in that order', () => {
    const parsed = parseOk('question\tanswer\ttopic\nWhat is 2+2?\t4\tMath\nCapital of France?\tParis\n\n', 'cards.tsv');
    expect(parsed.notes).toContain('Skipped the header row.');
    const checks = checkDrafts(toDrafts(parsed.rows), []);
    expect(checks.map((c) => c.content)).toEqual([
      { topic: 'Math', question: 'What is 2+2?', answer: '4', kind: 'recall', source: null },
      { topic: 'General', question: 'Capital of France?', answer: 'Paris', kind: 'recall', source: null },
    ]);
  });

  it('identifies lines with the wrong number of columns', () => {
    const parsed = parseOk('Q only\nQ\tA\tT\textra\nQ2\tA2');
    expect(parsed.rows.map((r) => [r.label, r.rowError !== null])).toEqual([
      ['Line 1', true],
      ['Line 2', true],
      ['Line 3', false],
    ]);
  });

  it('treats pasted text as JSON only when it starts with [ or {', () => {
    expect(parseOk('[{"question":"q","answer":"a"}]').format).toBe('json');
    expect(parseOk('q\ta').format).toBe('tsv');
  });
});

describe('duplicates', () => {
  it('warns about cards already in the collection and repeats within the batch, skipping them by default', () => {
    const text = JSON.stringify([
      { question: 'What is an index?', answer: 'x' },
      { question: '  what   is an INDEX? ', answer: 'y' },
      { question: 'Existing question', answer: 'z' },
      { question: 'Fresh', answer: 'w' },
    ]);
    const drafts = toDrafts(parseOk(text).rows);
    const checks = checkDrafts(drafts, [existingCard('Existing  question')]);
    expect(checks[0]!.duplicate).toBeNull();
    expect(checks[1]!.duplicate).toEqual({ kind: 'batch', label: 'Card 1' });
    expect(checks[2]!.duplicate).toMatchObject({ kind: 'existing', topic: 'SQL' });
    const plan = planImport(drafts, checks);
    expect(plan.toAdd.map((c) => c.answer)).toEqual(['x', 'w']);
    expect(plan.skippedDuplicates).toBe(2);

    const keep = drafts.map((d, i) => (i === 2 ? { ...d, keepDuplicate: true } : d));
    expect(planImport(keep, checkDrafts(keep, [existingCard('Existing question')])).toAdd).toHaveLength(3);
  });
});

describe('limits', () => {
  it('rejects files over 2 MB and unsupported extensions before reading', () => {
    expect(checkImportFile('cards.json', 2 * 1024 * 1024 + 1)).toMatch(/limited to 2 MB/);
    expect(checkImportFile('cards.csv', 10)).toMatch(/isn't a supported file/);
    expect(checkImportFile('cards.TXT', 10)).toBeNull();
    expect(checkImportText('x'.repeat(2 * 1024 * 1024 + 1))).toMatch(/limited to 2 MB/);
  });

  it('splits large imports into batches of at most 100', () => {
    expect(batchRanges(250)).toEqual([
      { start: 0, end: 100 },
      { start: 100, end: 200 },
      { start: 200, end: 250 },
    ]);
  });
});
