import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { freshWithStarterCards } from './helpers';

test('AC02/AC03/AC04: import validates the whole batch, preserves content, and never adds a batch twice', async ({ page }) => {
  await page.goto('./#/add/import');
  const cards = [
    {
      topic: 'Python',
      kind: 'apply',
      question: 'What does `yield` do?',
      answer: '```python\ndef gen():\n    yield 1  # café\n```',
      source: null,
    },
    { topic: 'SQL', kind: 'recall', question: 'What does NULL = NULL return?', answer: '' },
  ];
  await page.getByLabel('Cards as JSON or tab-separated text').fill(JSON.stringify({ format: 'recall-v1', cards }));
  await page.getByRole('button', { name: 'Preview import' }).click();

  await expect(page.getByText('Recognized a recall-v1 content export.')).toBeVisible();
  await expect(page.getByText('Answer is required.')).toBeVisible();
  await expect(page.getByText(/Fix or remove 1 card with errors/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Add 1 card/ })).toBeDisabled();

  // Fix the bad row in place.
  await page.locator('.draft').nth(1).getByRole('button', { name: 'Edit' }).click();
  await page.locator('.draft').nth(1).getByLabel('Answer').fill('UNKNOWN (NULL), not TRUE.');
  const add = page.getByRole('button', { name: 'Add 2 cards' });
  await expect(add).toBeEnabled();
  await add.dblclick();
  await expect(page.getByText(/Added 2 cards/).first()).toBeVisible();

  await page.goto('./#/collection');
  await expect(page.locator('.card-row')).toHaveCount(2);
  await page.locator('.card-row', { hasText: 'yield' }).click();
  await expect(page.getByLabel('Answer')).toHaveValue('```python\ndef gen():\n    yield 1  # café\n```');
  await expect(page.getByText('New · due now')).toBeVisible();

  // Importing the same content again flags duplicates and skips them by default.
  await page.goto('./#/add/import');
  await page.getByLabel('Cards as JSON or tab-separated text').fill(JSON.stringify({ format: 'recall-v1', cards: [cards[0]] }));
  await page.getByRole('button', { name: 'Preview import' }).click();
  await expect(page.getByText(/Already in your collection under/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add 0 cards' })).toBeDisabled();
});

test('TSV import reads question, answer, topic in that order', async ({ page }) => {
  await page.goto('./#/add/import');
  await page
    .getByLabel('Cards as JSON or tab-separated text')
    .fill('question\tanswer\ttopic\nCapital of France?\tParis\tGeography');
  await page.getByRole('button', { name: 'Preview import' }).click();
  await expect(page.getByText('Skipped the header row.')).toBeVisible();
  await page.getByRole('button', { name: 'Add 1 card' }).click();
  await page.goto('./#/collection');
  await expect(page.locator('.card-row')).toContainText(['Capital of France?']);
  await expect(page.locator('.card-row__meta')).toContainText(['Geography']);
});

test('AC11: edit keeps the schedule; pause, resume, and delete follow eligibility', async ({ page }) => {
  await freshWithStarterCards(page);
  await page.goto('./#/collection');
  await page.locator('.card-row', { hasText: 'testing effect' }).click();
  await expect(page.getByRole('heading', { name: 'Edit card' })).toBeVisible();

  await page.getByLabel('Question').fill('What is the testing effect?');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes saved. The schedule is unchanged.')).toBeVisible();
  await expect(page.getByText('version 2')).toBeVisible();

  await page.getByRole('button', { name: 'Pause card' }).click();
  await expect(page.getByText('Card paused.')).toBeVisible();
  await page.goto('./');
  await expect(page.getByRole('heading', { name: /5\s*cards due/ })).toBeVisible();

  await page.goto('./#/collection?status=paused');
  await page.locator('.card-row').first().click();
  await page.getByRole('button', { name: 'Resume card' }).click();
  await expect(page.getByText('Card resumed.')).toBeVisible();
  await page.goto('./');
  await expect(page.getByRole('heading', { name: /6\s*cards due/ })).toBeVisible();

  await page.goto('./#/collection');
  await page.locator('.card-row', { hasText: 'testing effect' }).click();
  await page.getByRole('button', { name: 'Delete card' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete card' }).click();
  await expect(page.getByText('Card deleted.')).toBeVisible();
  await expect(page.locator('.card-row')).toHaveCount(5);
});

test('collection search and filters, with a no-results state', async ({ page }) => {
  await freshWithStarterCards(page);
  await page.goto('./#/collection');
  await page.getByLabel('Search').fill('index');
  await expect(page.locator('.card-row')).toHaveCount(1);
  await page.getByLabel('Search').fill('zzz-nothing');
  await expect(page.getByRole('heading', { name: 'No matching cards' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search and filters' }).click();
  await page.getByLabel('Topic', { exact: true }).selectOption('Learning science');
  await expect(page.locator('.card-row')).toHaveCount(3);
  await page.getByLabel('Status').selectOption('new');
  await expect(page.locator('.card-row')).toHaveCount(3);
});

test('starter cards loaded twice are not duplicated', async ({ page }) => {
  await freshWithStarterCards(page);
  await page.goto('./#/add');
  await page.getByRole('button', { name: 'Add the six starter cards' }).click();
  await expect(page.getByText('The starter cards are already in your collection.')).toBeVisible();
});

test('AC12/AC22: full backup round-trips through restore; delete all returns to a fresh state', async ({ page }, testInfo) => {
  await freshWithStarterCards(page);
  await page.getByRole('button', { name: /Start review/ }).click();
  await page.getByRole('button', { name: /Reveal answer/ }).click();
  await page.getByRole('button', { name: /^Easy/ }).click();
  await page.goto('./#/settings');
  await page.getByRole('radio', { name: /Large/ }).first().check();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download full backup' }).click();
  const file = testInfo.outputPath('backup.json');
  await (await download).saveAs(file);
  const backup = JSON.parse(await readFile(file, 'utf8'));
  expect(backup.format).toBe('recall-backup');
  expect(backup.data.cards).toHaveLength(6);
  expect(backup.data.reviews).toHaveLength(1);

  // Delete everything.
  await page.getByRole('button', { name: 'Delete all data…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete all Recall data?' });
  await expect(confirm.getByRole('button', { name: 'Delete everything' })).toBeDisabled();
  await confirm.getByLabel(/Type delete/).fill('delete');
  await confirm.getByRole('button', { name: 'Delete everything' }).click();
  await expect(page.getByRole('heading', { name: 'Your collection is empty' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-reading-size', 'standard');

  // Restore.
  await page.goto('./#/settings');
  await page.getByLabel('Choose a backup file (.json)').setInputFiles(file);
  const dialog = page.getByRole('dialog', { name: 'Replace this workspace?' });
  await expect(dialog).toContainText('In the backup');
  await dialog.getByRole('button', { name: 'Replace with backup' }).click();
  await expect(page.getByText(/Restored 6 cards and 1 reviews/)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-reading-size', 'large');
  await expect(page.getByRole('heading', { name: /5\s*cards due/ })).toBeVisible();
});

test('AC13: a future-version backup is rejected and nothing changes', async ({ page }, testInfo) => {
  await freshWithStarterCards(page);
  const file = testInfo.outputPath('future.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, JSON.stringify({ format: 'recall-backup', formatVersion: 99, data: {} }));
  await page.goto('./#/settings');
  await page.getByLabel('Choose a backup file (.json)').setInputFiles(file);
  await expect(page.getByText(/newer than this app supports/)).toBeVisible();
  await page.goto('./');
  await expect(page.getByRole('heading', { name: /6\s*cards due/ })).toBeVisible();
});

test('AC18: with AI unavailable the app says so plainly and study works', async ({ page }) => {
  await page.goto('./#/settings');
  await expect(page.getByText(/Not configured\./)).toBeVisible();
  await page.goto('./#/method');
  await expect(page.getByText(/doesn’t grade your answers with AI/)).toBeVisible();
});

test('multiple-choice options can be written, imported, and edited; Today says which cards a quick check can take', async ({
  page,
}) => {
  await page.goto('./#/add');
  await page.getByLabel('Question').fill('Which SQL clause filters groups after aggregation?');
  await page.getByLabel('Answer').fill('`HAVING` filters groups; `WHERE` filters rows before grouping.');
  await page.getByRole('button', { name: /Multiple-choice options/ }).click();
  await page.getByLabel('Correct option').fill('`HAVING`');
  await page.getByLabel('Wrong option 1').fill('`WHERE`');
  await page.getByLabel('Wrong option 2').fill('`GROUP BY`');
  await page.getByRole('button', { name: 'Save card' }).click();
  await expect(page.getByText('Card added.')).toBeVisible();

  // Imported cards keep their options; bad options block the batch and name the problem.
  await page.goto('./#/add/import');
  const cards = [
    { question: 'Plain card', answer: 'No options here.' },
    { question: 'Too many', answer: 'A', choices: { correct: 'A', distractors: ['B', 'C', 'D', 'E'] } },
    { question: 'Capital of France?', answer: 'Paris', choices: { correct: 'Paris', distractors: ['Lyon', 'Nice'] } },
  ];
  await page.getByLabel('Cards as JSON or tab-separated text').fill(JSON.stringify({ cards }));
  await page.getByRole('button', { name: 'Preview import' }).click();
  await expect(page.getByText('Use at most 3 wrong options; found 4.')).toBeVisible();
  await expect(page.locator('.draft').nth(2)).toContainText('multiple choice');
  await page.locator('.draft').nth(1).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('button', { name: 'Add 2 cards' }).click();
  await expect(page.getByText(/Added 2 cards/).first()).toBeVisible();

  await page.goto('./');
  await page.getByRole('radio', { name: /Quick check/ }).check();
  await expect(page.getByText(/2 of 3 due cards can be quick-checked; 1 has no multiple-choice options/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start quick check · 2 cards' })).toBeEnabled();

  // Editing: duplicate options are rejected; clearing them all makes the card recall-only.
  await page.goto('./#/collection');
  await page.locator('.card-row', { hasText: 'Capital of France' }).click();
  await expect(page.getByLabel('Correct option')).toHaveValue('Paris');
  await page.getByLabel('Wrong option 1').fill('paris');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Each option must be different.')).toBeVisible();
  for (const label of ['Correct option', 'Wrong option 1', 'Wrong option 2']) await page.getByLabel(label).fill('');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes saved.')).toBeVisible();
  await expect(page.getByText('No options')).toBeVisible();
});

test('existing cards get options in bulk: export the cards without them, paste the reply, preview, and save', async ({
  page,
}) => {
  await freshWithStarterCards(page); // the starter cards already have options
  await page.goto('./#/add/import');
  const plain = [
    { topic: 'SQL', question: 'What does `COALESCE` return?', answer: 'The first non-NULL argument.' },
    { topic: 'SQL', question: 'What does `HAVING` filter?', answer: 'Groups, after aggregation.' },
    { topic: 'Python', question: 'What does `zip` stop on?', answer: 'The shortest input.' },
  ];
  await page.getByLabel('Cards as JSON or tab-separated text').fill(JSON.stringify({ cards: plain }));
  await page.getByRole('button', { name: 'Preview import' }).click();
  await page.getByRole('button', { name: 'Add 3 cards' }).click();
  await expect(page.getByText(/Added 3 cards/).first()).toBeVisible();

  // Step 1: the prompt carries only cards without options, filterable by topic.
  await page.goto('./#/add/options');
  await expect(page.getByRole('link', { name: 'Add options' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.import-summary')).toHaveText('3 of 9 cards have no multiple-choice options.');
  await page.getByText('Show the prompt').click();
  const promptCards = async () => {
    const prompt = await page.getByLabel('Options prompt').inputValue();
    return JSON.parse(prompt.slice(prompt.indexOf('<<<') + 3, prompt.indexOf('>>>'))) as Array<{
      id: string;
      question: string;
      answer: string;
    }>;
  };
  await page.getByLabel('Topic', { exact: true }).selectOption('SQL');
  await expect(page.getByText('This prompt has all 2 cards without options in SQL.')).toBeVisible();
  expect((await promptCards()).map((c) => c.question).sort()).toEqual([plain[0]!.question, plain[1]!.question].sort());
  await page.getByLabel('Topic', { exact: true }).selectOption('');
  const exported = await promptCards();
  expect(
    exported.map(({ question, answer }) => ({ question, answer })).sort((a, b) => a.question.localeCompare(b.question)),
  ).toEqual(plain.map(({ question, answer }) => ({ question, answer })).sort((a, b) => a.question.localeCompare(b.question)));
  const [coalesce, having, zip] = plain.map((p) => exported.find((c) => c.question === p.question));

  // Step 2: paste a reply with two good entries, one bad one, and an ID that matches nothing.
  const reply = {
    format: 'recall-options-v1',
    options: [
      { id: zip!.id, choices: { correct: 'The shortest input', distractors: ['The longest input', 'The first input'] } },
      { id: coalesce!.id, choices: { correct: 'The first non-NULL argument', distractors: ['NULL', 'The last argument'] } },
      { id: having!.id, choices: { correct: 'Groups', distractors: ['groups'] } },
      { id: 'made-up-id', choices: { correct: 'A', distractors: ['B'] } },
    ],
  };
  await page.getByLabel('Options as JSON').fill(JSON.stringify(reply));
  await page.getByRole('button', { name: 'Preview options' }).click();

  // Step 3: preview each entry with its question, options, and any problem.
  const entries = page.locator('.draft');
  await expect(page.getByRole('status').filter({ hasText: 'to update' })).toHaveText(
    '2 cards to update · 1 with errors · 1 skipped',
  );
  await expect(entries.nth(0)).toContainText('Ready');
  await expect(entries.nth(0)).toContainText(plain[2]!.question.replaceAll('`', ''));
  await expect(entries.nth(0)).toContainText('Correct The shortest input');
  await expect(entries.nth(0)).toContainText('Wrong The longest input');
  await expect(entries.nth(2)).toContainText('Error · skipped');
  await expect(entries.nth(2)).toContainText('Each option must be different.');
  await expect(entries.nth(3)).toContainText('Unknown card · skipped');
  await expect(entries.nth(3)).toContainText('No card has the ID made-up-id.');

  await entries.nth(1).getByRole('button', { name: 'Leave out' }).click();
  await expect(entries.nth(1)).toContainText('Left out');
  await expect(page.getByRole('button', { name: 'Save options for 1 card' })).toBeVisible();
  await entries.nth(1).getByRole('button', { name: 'Include' }).click();
  await page.getByRole('button', { name: 'Save options for 2 cards' }).dblclick();
  await expect(page.getByText('Saved options for 2 cards. They can now appear in quick checks.')).toBeVisible();
  await expect(page.locator('.import-summary')).toHaveText('1 of 9 cards has no multiple-choice options.');

  // The cards keep their content and schedule; the edit counts as a new version.
  await page.goto('./');
  await page.getByRole('radio', { name: /Quick check/ }).check();
  await expect(page.getByText(/8 of 9 due cards can be quick-checked; 1 has no multiple-choice options/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add options to existing cards' })).toHaveAttribute('href', '#/add/options');
  await page.goto(`./#/collection/${coalesce!.id}`);
  await expect(page.getByLabel('Question')).toHaveValue(plain[0]!.question);
  await expect(page.getByLabel('Answer')).toHaveValue(plain[0]!.answer);
  await expect(page.getByLabel('Correct option')).toHaveValue('The first non-NULL argument');
  await expect(page.getByText('version 2')).toBeVisible();
  await expect(page.getByText('New · due now')).toBeVisible();
});
