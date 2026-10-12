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

/**
 * Reads every record in one IndexedDB store, in a new read-only transaction. That transaction waits for
 * any earlier read-write one on the store, so it only sees committed data. Poll it to wait for a write
 * that has no on-screen confirmation before reloading or leaving the page, which would abort the write.
 */
export function storedRecords<T>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(
    (store) =>
      new Promise<T[]>((resolve, reject) => {
        const open = indexedDB.open('recall');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          try {
            const request = db.transaction(store, 'readonly').objectStore(store).getAll();
            request.onsuccess = () => resolve(request.result as T[]);
            request.onerror = () => reject(request.error);
          } catch (err) {
            reject(err);
          } finally {
            db.close(); // takes effect once the read finishes
          }
        };
      }),
    store,
  );
}

export async function noHorizontalScroll(page: Page) {
  const [scroll, client] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scroll, 'page should not scroll horizontally').toBeLessThanOrEqual(client);
}
