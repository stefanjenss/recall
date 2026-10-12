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
