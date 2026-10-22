import { describe, expect, it } from 'vitest';
import { buildAssistantPrompt, buildOptionsPrompt } from '../../src/content/assistantPrompt';
import {
  cardsWithoutOptions,
  checkOptions,
  OPTIONS_FORMAT,
  parseOptionsText,
  planOptions,
  type OptionsRow,
} from '../../src/content/optionsImport';
import type { Card, CardChoices } from '../../src/domain/types';

const NOW = Date.UTC(2026, 9, 21);

function existing(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    topic: 'SQL',
    question: `Question ${id}`,
    answer: `Answer ${id}`,
    kind: 'recall',
    source: null,
    choices: null,
    contentVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

const CHOICES: CardChoices = { correct: 'Right', distractors: ['Wrong A', 'Wrong B', 'Wrong C'] };

function reply(options: unknown[]): string {
  return JSON.stringify({ format: OPTIONS_FORMAT, options });
}

function rowsOf(text: string): OptionsRow[] {
  const result = parseOptionsText(text);
  if (!result.ok) throw new Error(result.error);
  return result.rows;
}

describe('options import: parsing', () => {
  it('reads recall-options-v1 entries, trimming card IDs', () => {
    const rows = rowsOf(
      reply([
        { id: '  c1 ', choices: CHOICES },
        { id: 'c2', choices: null },
      ]),
    );
    expect(rows).toEqual([
      { key: 'entry-0', label: 'Entry 1', cardId: 'c1', choices: CHOICES, rowError: null },
      { key: 'entry-1', label: 'Entry 2', cardId: 'c2', choices: null, rowError: null },
    ]);
  });

  it('accepts a bare array and a missing format; ignores other fields', () => {
    expect(rowsOf(JSON.stringify([{ id: 'c1', question: 'ignored', choices: CHOICES }]))[0]).toMatchObject({
      cardId: 'c1',
      choices: CHOICES,
    });
    expect(rowsOf(JSON.stringify({ options: [{ id: 'c1', choices: CHOICES }] }))).toHaveLength(1);
  });

  it('flags entries without an object shape, an ID, or choices', () => {
    const rows = rowsOf(reply(['text', { choices: CHOICES }, { id: 42, choices: CHOICES }, { id: 'c1' }]));
    expect(rows.map((r) => r.rowError)).toEqual([
      'This entry is not an object with an "id" and "choices".',
      'This entry has no card "id" (found: choices).',
      'This entry has no card "id" (found: id, choices).',
      'This entry has no "choices".',
    ]);
  });

  it('explains replies it can’t use', () => {
    const error = (text: string) => {
      const result = parseOptionsText(text);
      return result.ok ? null : result.error;
    };
    expect(error('  ')).toMatch(/nothing to preview/);
    expect(error('{"format": "recall-options-v1", "options": [')).toMatch(/isn't valid JSON/);
    expect(error('{"format":"recall-backup","data":{}}')).toMatch(/full Recall backup/);
    expect(error('{"format":"recall-v1","cards":[]}')).toMatch(/new cards, not options.*Import cards/);
    expect(error('{"format":"recall-options-v9","options":[]}')).toMatch(/Unknown format "recall-options-v9"/);
    expect(error('{"entries":[]}')).toMatch(/"options" list/);
    expect(error('"just text"')).toMatch(/"options" list/);
    expect(error(reply([]))).toMatch(/no options/);
    expect(error(reply(Array.from({ length: 101 }, (_, i) => ({ id: `c${i}`, choices: CHOICES }))))).toMatch(
      /101 entries.*at most 100/,
    );
  });
});

describe('options import: matching and validation', () => {
  it('matches entries to cards by ID and reports why others are skipped', () => {
    const cards = [
      existing('c1'),
      existing('c2'),
      existing('gone', { deletedAt: NOW }),
      existing('has', { choices: { correct: 'Old', distractors: ['Older'] } }),
      existing('same', { choices: CHOICES }),
      existing('blank'),
    ];
    const rows = rowsOf(
      reply([
        { id: 'c1', choices: CHOICES },
        { id: 'nope', choices: CHOICES },
        { id: 'gone', choices: CHOICES },
        { id: 'c1', choices: { correct: 'Again', distractors: ['No'] } },
        { id: 'has', choices: CHOICES },
        { id: 'same', choices: CHOICES },
        { id: 'blank', choices: null },
        { id: 'c2', choices: { correct: ' ', distractors: ['', ' '] } },
      ]),
    );
    const checks = checkOptions(rows, cards);
    expect(checks.map((c) => c.status)).toEqual([
      'ready',
      'unknown',
      'deleted',
      'repeat',
      'replace',
      'unchanged',
      'none',
      'none',
    ]);
    expect(checks[0]).toMatchObject({ card: { id: 'c1' }, choices: CHOICES, errors: [] });
    expect(checks[1]).toMatchObject({ cardId: 'nope', card: null });
    expect(checks[3]!.repeatOf).toBe('Entry 1');
  });

  it('validates options exactly as the card editor does, and normalizes them', () => {
    const cards = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => existing(id));
    const checks = checkOptions(
      rowsOf(
        reply([
          { id: 'c1', choices: { correct: '  Right ', distractors: [' Wrong ', '', '  '] } },
          { id: 'c2', choices: { correct: 'A', distractors: ['B', 'C', 'D', 'E'] } },
          { id: 'c3', choices: { correct: 'Paris', distractors: ['paris'] } },
          { id: 'c4', choices: { correct: 'x'.repeat(501), distractors: ['y'] } },
          { id: 'c5', choices: ['Right', 'Wrong'] },
          { id: 'c6', choices: { correct: 'Right', distractors: [] } },
        ]),
      ),
      cards,
    );
    expect(checks[0]).toMatchObject({ status: 'ready', choices: { correct: 'Right', distractors: ['Wrong'] } });
    expect(checks.slice(1).map((c) => [c.status, c.errors])).toEqual([
      ['error', ['Use at most 3 wrong options; found 4.']],
      ['error', ['Each option must be different.']],
      ['error', ['The correct option is 501 characters; the limit is 500.']],
      ['error', ['Options must be an object with a "correct" option and a "distractors" list of wrong options.']],
      ['error', ['Add at least one wrong option, or clear the correct one.']],
    ]);
  });

  it('plans ready entries by default and replacements only when the learner asks', () => {
    const cards = [
      existing('c1'),
      existing('c2', { contentVersion: 4 }),
      existing('has', { choices: { correct: 'Old', distractors: ['Older'] } }),
    ];
    const checks = checkOptions(
      rowsOf(
        reply([
          { id: 'c1', choices: CHOICES },
          { id: 'c2', choices: CHOICES },
          { id: 'has', choices: CHOICES },
          { id: 'nope', choices: CHOICES },
          { id: 'c1', choices: CHOICES },
          { id: 'c2', choices: { correct: 'A', distractors: [] } },
        ]),
      ),
      cards,
    );
    expect(planOptions(checks, {})).toEqual({
      updates: [
        { cardId: 'c1', cardVersion: 1, choices: CHOICES },
        { cardId: 'c2', cardVersion: 4, choices: CHOICES },
      ],
      adding: 2,
      replacing: 0,
      keeping: 1,
      leftOut: 0,
      errors: 0,
      skipped: 3,
    });
    const chosen = planOptions(checks, { 'entry-0': false, 'entry-2': true, 'entry-3': true });
    expect(chosen.updates.map((u) => u.cardId)).toEqual(['c2', 'has']);
    expect(chosen).toMatchObject({ adding: 1, replacing: 1, keeping: 0, leftOut: 1, skipped: 3 });
  });
});

describe('options import: export prompt', () => {
  it('lists only active cards without options, filterable by topic', () => {
    const cards = [
      existing('b2', { topic: 'Python', createdAt: NOW + 2 }),
      existing('a1', { topic: 'SQL' }),
      existing('b1', { topic: 'Python', createdAt: NOW + 1 }),
      existing('has', { choices: CHOICES }),
      existing('gone', { deletedAt: NOW }),
    ];
    expect(cardsWithoutOptions(cards).map((c) => c.id)).toEqual(['b1', 'b2', 'a1']);
    expect(cardsWithoutOptions(cards, 'SQL').map((c) => c.id)).toEqual(['a1']);
  });

  it('carries each card’s ID, question, and answer, the shared option guidance, and the reply format', () => {
    const cards = [existing('c1', { question: 'What does "NULL = NULL" return?', answer: 'UNKNOWN\n```sql\nSELECT 1;\n```' })];
    const prompt = buildOptionsPrompt(cards);
    const listed = JSON.parse(prompt.slice(prompt.indexOf('<<<') + 3, prompt.indexOf('>>>')));
    expect(listed).toEqual([{ id: 'c1', topic: 'SQL', question: cards[0]!.question, answer: cards[0]!.answer }]);
    expect(prompt).toContain(`"format": "${OPTIONS_FORMAT}"`);
    expect(prompt).toContain('Copy each card\'s "id" exactly');

    // The option-writing rules are the same ones the card prompt uses.
    const guidance = buildAssistantPrompt({ material: 'x', topic: '', count: 5 })
      .split('\n')
      .filter((line) => /^- "(correct|distractors)"|^- Match the length|^- No "all of the above"|"choices": null\.$/.test(line));
    expect(guidance).toHaveLength(5);
    for (const line of guidance) expect(prompt).toContain(line);
  });

  it('an assistant reply in the requested shape round-trips to ready entries', () => {
    const cards = [existing('c1'), existing('c2')];
    const prompt = buildOptionsPrompt(cards);
    const ids = (JSON.parse(prompt.slice(prompt.indexOf('<<<') + 3, prompt.indexOf('>>>'))) as Card[]).map((c) => c.id);
    const checks = checkOptions(rowsOf(reply(ids.map((id) => ({ id, choices: CHOICES })))), cards);
    expect(checks.map((c) => c.status)).toEqual(['ready', 'ready']);
  });
});
