import { expect, type Page } from '@playwright/test';

export async function freshWithStarterCards(page: Page) {
  await page.goto('./');
  await page.getByRole('button', { name: 'Add six starter cards' }).click();
  await expect(page.getByText(/Added 6 starter cards/)).toBeVisible();
}

export async function startReview(page: Page) {
  await page.getByRole('button', { name: /Start review/ }).click();
  await expect(page.getByRole('button', { name: /Reveal answer/ })).toBeVisible();
}

export function cardPosition(page: Page) {
  return page.locator('.practice__progress p').first();
}

export async function noHorizontalScroll(page: Page) {
  const [scroll, client] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scroll, 'page should not scroll horizontally').toBeLessThanOrEqual(client);
}
