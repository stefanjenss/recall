import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { freshWithStarterCards, noHorizontalScroll, startReview } from './helpers';

const SCREENS = ['./', './#/collection', './#/add', './#/add/import', './#/progress', './#/method', './#/settings'];

async function expectNoAxeViolations(page: import('@playwright/test').Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

test('automated WCAG checks pass on every screen and practice state', async ({ page }) => {
  await freshWithStarterCards(page);
  for (const path of SCREENS) {
    await page.goto(path);
    await expect(page.locator('main h1')).toBeVisible();
    await expectNoAxeViolations(page, path);
  }
  await page.goto('./');
  await startReview(page);
  await expectNoAxeViolations(page, 'practice: answering');
  await page.getByRole('button', { name: /Reveal answer/ }).click();
  await expectNoAxeViolations(page, 'practice: revealed');
});

test('AC14: content reflows at 320 CSS px (≈ 200% zoom of 640 px) without horizontal page scroll', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
  const page = await context.newPage();
  await freshWithStarterCards(page);
  for (const path of SCREENS) {
    await page.goto(path);
    await expect(page.locator('main h1')).toBeVisible();
    await noHorizontalScroll(page);
  }
  await page.goto('./');
  await startReview(page);
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: /Reveal answer/ }).click();
  await noHorizontalScroll(page);
  // Rating buttons fall into a 2×2 grid and stay at least 44 px tall.
  const boxes = await page.locator('.rating__button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  expect(new Set(boxes.map((b) => Math.round(b.top))).size).toBe(2);
  for (const b of boxes) expect(b.height).toBeGreaterThanOrEqual(44);
  await context.close();
});

test('study text sizes meet the reading spec', async ({ page }) => {
  await freshWithStarterCards(page);
  await startReview(page);
  const px = (sel: string) =>
    page
      .locator(sel)
      .first()
      .evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  expect(await px('.practice__response')).toBeGreaterThanOrEqual(18);
  const q = await px('.practice__question');
  expect(q).toBeGreaterThanOrEqual(26);
  expect(q).toBeLessThanOrEqual(34);
  await page.getByRole('button', { name: /Reveal answer/ }).click();
  expect(await px('.practice__answer-text')).toBeGreaterThanOrEqual(20);
  expect(await px('.practice__meta')).toBeGreaterThanOrEqual(14);

  // A larger reading size scales study text.
  await page.goto('./#/settings');
  await page.getByRole('radio', { name: /Larger/ }).check();
  await page.goto('./#/practice');
  expect(await px('.practice__answer-text')).toBeGreaterThanOrEqual(25);
});

test('touch targets for primary controls are at least 44×44 px', async ({ page }) => {
  await freshWithStarterCards(page);
  const sizes = await page
    .locator('main button:visible, main a.button:visible, .nav__link:visible, .topbar__menu:visible')
    .evaluateAll((els) => els.map((e) => ({ text: e.textContent?.trim(), ...e.getBoundingClientRect().toJSON() })));
  for (const s of sizes) expect(s.height, `${s.text} height`).toBeGreaterThanOrEqual(44);
});
