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

/**
 * Read every record in one of the app's IndexedDB stores. Tests use it to wait
 * until a write has landed before reloading: a reload aborts any transaction
 * still in flight, just as closing the tab would.
 */
export function readStore<T = unknown>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(
    (name) =>
      new Promise<T[]>((resolve, reject) => {
        const open = indexedDB.open('recall');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction(name, 'readonly').objectStore(name).getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result as T[]);
          };
          request.onerror = () => {
            db.close();
            reject(request.error);
          };
        };
      }),
    store,
  );
}

/** Wait until the active session's draft (answer and confidence) is saved. */
export async function waitForSavedDraft(page: Page, response: string, confidence: string | null) {
  type StoredSession = { status: string; attempt: { response: string; confidence: string | null } | null };
  await expect
    .poll(async () => {
      const sessions = await readStore<StoredSession>(page, 'sessions');
      const attempt = sessions.find((s) => s.status === 'active')?.attempt;
      return attempt ? { response: attempt.response, confidence: attempt.confidence } : null;
    })
    .toEqual({ response, confidence });
}
