import { expect, test, type Locator, type Page } from '@playwright/test';
import { freshWithStarterCards, noHorizontalScroll, startReview } from './helpers';

// iPad mini: 744×1133 points in portrait (6th generation and later), 768×1024 on earlier models.
// Every other spec also runs on the tablet project in portrait; these cover landscape and touch.
const LANDSCAPE = [
  { width: 1133, height: 744 },
  { width: 1024, height: 768 },
];

const SCREENS = [
  './',
  './#/collection',
  './#/add',
  './#/add/import',
  './#/add/options',
  './#/progress',
  './#/method',
  './#/settings',
];

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'tablet', 'Runs on the iPad mini project.');
});

const box = async (locator: Locator) => (await locator.boundingBox())!;

async function expectStacked(page: Page, first: Locator, second: Locator) {
  const [a, b, column] = await Promise.all([box(first), box(second), box(page.locator('main'))]);
  expect(b.y, 'the side panel sits below the form').toBeGreaterThanOrEqual(a.y + a.height);
  expect(a.width, 'the form spans the content column').toBeGreaterThan(column.width * 0.85);
}

test('iPad mini, portrait: the tab bar navigates, every screen fits, and ratings sit in one row', async ({ page }) => {
  await freshWithStarterCards(page);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  for (const path of SCREENS) {
    await page.goto(path);
    await expect(page.locator('main h1')).toBeVisible();
    await noHorizontalScroll(page);
  }
  await page.goto('./');
  await startReview(page);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  await page.getByRole('button', { name: /Reveal answer/ }).click();
  await expect(page.locator('.rating__button')).toHaveCount(4);
  const tops = await page
    .locator('.rating__button')
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
});

for (const viewport of LANDSCAPE) {
  test(`iPad mini, landscape ${viewport.width}×${viewport.height}: the sidebar replaces the tab bar, and forms use the whole column`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await freshWithStarterCards(page);
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
    await expect(page.locator('.tabbar')).toBeHidden();
    for (const path of SCREENS) {
      await page.goto(path);
      await expect(page.locator('main h1')).toBeVisible();
      await noHorizontalScroll(page);
    }

    // Beside the sidebar there isn't room for the writing tips too: they move below the form,
    // and Topic and Kind keep their side-by-side row at full width.
    await page.goto('./#/add');
    await expectStacked(page, page.locator('.add__write > form'), page.locator('.add__tips'));
    const [topic, kind] = await Promise.all([
      box(page.getByLabel('Topic', { exact: true })),
      box(page.getByLabel('Kind', { exact: true })),
    ]);
    expect(Math.round(kind.y)).toBe(Math.round(topic.y));
    expect(kind.width).toBeGreaterThan(280);

    await page.goto('./#/collection');
    await page.locator('.card-row').first().click();
    await expect(page.getByRole('heading', { name: 'Edit card' })).toBeVisible();
    await expectStacked(page, page.locator('.editor__form'), page.locator('.editor__side'));
  });
}

test('a desktop-width window keeps the writing tips beside the form', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./#/add');
  const [form, tips] = await Promise.all([box(page.locator('.add__write > form')), box(page.locator('.add__tips'))]);
  expect(tips.x).toBeGreaterThan(form.x + form.width);
  expect(Math.round(tips.y)).toBe(Math.round(form.y));
});

test('touch screens show no hover highlight on a rating, so nothing looks chosen on the next card', async ({ page }) => {
  await freshWithStarterCards(page);
  await startReview(page);
  await page.getByRole('button', { name: /Reveal answer/ }).click();
  const good = page.locator('.rating__button').nth(2);
  await good.hover();
  expect(await good.evaluate((e) => e.matches(':hover'))).toBe(true);
  expect(await good.evaluate((e) => getComputedStyle(e).boxShadow)).toBe('none');
});
