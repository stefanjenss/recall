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

export async function startQuickCheck(page: Page) {
  await page.getByRole('radio', { name: /Quick check/ }).check();
  await page.getByRole('button', { name: /Start quick check/ }).click();
  await expect(page.getByRole('heading', { name: 'Choose the best answer' })).toBeVisible();
}

/** A stored preference, read straight from IndexedDB (the UI updates before the write lands). */
export function storedPreference(page: Page, key: string): Promise<unknown> {
  return page.evaluate(
    (k) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('recall');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const get = db.transaction('meta').objectStore('meta').get('preferences');
          get.onsuccess = () => {
            resolve((get.result?.value as Record<string, unknown> | undefined)?.[k] ?? null);
            db.close();
          };
        };
      }),
    key,
  );
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
