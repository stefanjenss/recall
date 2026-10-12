import { expect, test } from '@playwright/test';
import { cardPosition, freshWithStarterCards, startReview } from './helpers';

test('AC01: a fresh install adds cards and completes a persisted session with no sign-in or AI', async ({ page }) => {
  await freshWithStarterCards(page);
  await expect(page.getByRole('heading', { name: /6\s*cards due/ })).toBeVisible();

  // Smallest session size, so the run is short.
  await page.getByRole('radio', { name: '5' }).check();
  await startReview(page);

  for (let i = 1; i <= 5; i++) {
    await expect(cardPosition(page)).toContainText(`Card ${i} of 5`);
    await page.getByLabel('Your answer').fill(`Attempt ${i}`);
    await page.getByRole('button', { name: /Reveal answer/ }).click();
    await expect(page.getByRole('heading', { name: 'Answer', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Good/ }).click();
  }

  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /5\s*cards reviewed/ })).toBeVisible();

  await page.getByLabel(/What will you take from this session/).fill('Idempotency still needs an example.');
  await page.getByRole('button', { name: 'Save reflection' }).click();
  await expect(page.getByText('Reflection saved.')).toBeVisible();

  // Reload: everything is still there.
  await page.reload();
  await page.goto('./#/progress');
  await expect(page.getByText('Reviews, all time')).toBeVisible();
  await expect(page.locator('.stat-list__item').first()).toContainText('5');
  await expect(page.getByText('Idempotency still needs an example.')).toBeVisible();
  await page.goto('./');
  await expect(page.getByRole('heading', { name: /1\s*card due/ })).toBeVisible();
});

test('AC15: Space and 1–4 typed into the answer are text, not shortcuts; outside inputs they reveal and rate', async ({
  page,
}) => {
  await freshWithStarterCards(page);
  await startReview(page);
  const answer = page.getByLabel('Your answer');
  await answer.click();
  await page.keyboard.type('a 1 2 3 4 b');
  await expect(answer).toHaveValue('a 1 2 3 4 b');
  await expect(page.getByRole('button', { name: /Reveal answer/ })).toBeVisible();

  // Move focus out of the textarea (to the question heading) and use the shortcuts.
  await page.locator('.practice__question').click();
  await page.keyboard.press('3');
  await expect(page.getByRole('button', { name: /Reveal answer/ })).toBeVisible(); // ratings aren't available before reveal
  await page.keyboard.press('Space');
  await expect(page.getByRole('heading', { name: 'Answer', exact: true })).toBeVisible();
  await expect(page.getByText('a 1 2 3 4 b')).toBeVisible(); // frozen response
  await page.keyboard.press('3');
  await expect(cardPosition(page)).toContainText('Card 2 of 6');
});

test('shortcuts are ignored while a dialog is open', async ({ page }) => {
  await freshWithStarterCards(page);
  await startReview(page);
  await page.getByRole('button', { name: 'End session' }).click();
  const dialog = page.getByRole('dialog', { name: 'End this session?' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: /Reveal answer/ })).toBeVisible();
});

test('AC08: refreshing mid-attempt restores the card, draft, confidence, reveal state, and queue', async ({ page }) => {
  await freshWithStarterCards(page);
  await startReview(page);
  const question = await page.locator('.practice__question').innerText();
  await page.getByLabel('Your answer').fill('A draft I do not want to lose');
  await page.getByRole('radio', { name: 'Unsure' }).check();
  await page.waitForTimeout(700); // draft save is debounced

  await page.reload();
  await expect(page.locator('.practice__question')).toHaveText(question);
  await expect(page.getByLabel('Your answer')).toHaveValue('A draft I do not want to lose');
  await expect(page.getByRole('radio', { name: 'Unsure' })).toBeChecked();
  await expect(cardPosition(page)).toContainText('Card 1 of 6');

  await page.getByRole('button', { name: /Reveal answer/ }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Answer', exact: true })).toBeVisible();
  await expect(page.getByText('A draft I do not want to lose')).toBeVisible();
  await expect(page.getByText('Confidence: Unsure')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Your answer' })).toHaveCount(0); // frozen after reveal
});

test('leaving a session offers Resume or End, and never rates on its own', async ({ page }) => {
  await freshWithStarterCards(page);
  await startReview(page);
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Session in progress' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /6\s*cards due/ })).toBeVisible();
  await page.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByRole('heading', { name: 'Session ended' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /0\s*cards reviewed/ })).toBeVisible();
});

test('AC10: the same attempt open in two tabs is committed once', async ({ page, context }) => {
  await freshWithStarterCards(page);
  await startReview(page);
  const second = await context.newPage();
  await second.goto('./#/practice');
  await expect(second.getByRole('button', { name: /Reveal answer/ })).toBeVisible();

  await page.getByRole('button', { name: /Reveal answer/ }).click();
  await page.getByRole('button', { name: /^Good/ }).click();
  await expect(cardPosition(page)).toContainText('Card 2 of 6');

  // The second tab still shows card 1. Its reveal and rating can't create a second review.
  await second.getByRole('button', { name: /Reveal answer/ }).click();
  await expect(second.getByText(/session changed in another tab/i)).toBeVisible();
  await second.getByRole('button', { name: 'Reload session' }).click();
  await expect(cardPosition(second)).toContainText('Card 2 of 6');

  await page.goto('./#/progress');
  await expect(page.locator('.stat-list__item').first()).toContainText('1');
});

test('an Again rating schedules the card for a later session and says so', async ({ page }) => {
  await freshWithStarterCards(page);
  await page.getByRole('radio', { name: '5' }).check();
  await startReview(page);
  await page.getByRole('button', { name: /Reveal answer/ }).click();
  await expect(page.getByRole('button', { name: /^Again/ })).toContainText('Next in 10 min');
  await page.getByRole('button', { name: /^Again/ }).click();
  await page.getByRole('button', { name: 'End session' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'End session' }).click();
  await expect(page.getByText(/1 card rated Again will be due in 10 min/)).toBeVisible();
});
