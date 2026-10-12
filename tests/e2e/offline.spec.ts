import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { cardPosition, freshWithStarterCards, startReview, waitForSavedDraft } from './helpers';

// Playwright's offline emulation doesn't reach a service worker's own requests,
// so this test serves the build itself and then shuts the server down: after
// that, anything the app loads can only come from the service worker's cache.

/** Serve `outDir` with `vite preview` on a free port; resolves with the server and its URL. */
async function startServer(outDir = 'dist'): Promise<{ server: ChildProcess; base: string }> {
  const server = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--port', '0', '--strictPort', '--outDir', outDir],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } },
  );
  const base = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`preview server did not start:\n${output}`)), 15_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /http:\/\/localhost:(\d+)\//.exec(output.replace(/\x1b\[[0-9;]*m/g, ''));
      if (match) {
        clearTimeout(timer);
        resolve(`http://localhost:${match[1]}/`);
      }
    };
    server.stdout?.on('data', onData);
    server.stderr?.on('data', onData);
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`preview server exited (${code}):\n${output}`));
    });
  });
  return { server, base };
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = once(server, 'exit');
  server.kill();
  await exited;
}

test('after one visit, the app loads and studies with the server gone', async ({ page }) => {
  const { server, base } = await startServer();
  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Add six starter cards' }).click();
    await expect(page.getByText(/Added 6 starter cards/)).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.goto(`${base}#/settings`);
    await expect(page.getByText(/Offline use:.*Ready/)).toBeVisible();

    await stopServer(server);

    const probe = await page.evaluate(() =>
      fetch(`./not-cached-${Date.now()}.txt`).then(
        () => 'reached a server',
        () => 'no server',
      ),
    );
    expect(probe).toBe('no server');

    await page.goto(base);
    await page.reload();
    await expect(page.getByRole('heading', { name: /6\s*cards due/ })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.fonts.load('16px "DM Sans"').then((f) => f.length > 0)), {
        message: 'bundled font loads from the cache',
      })
      .toBe(true);

    await page.getByRole('button', { name: /Start review/ }).click();
    await page.getByRole('button', { name: /Reveal answer/ }).click();
    await page.getByRole('button', { name: /^Good/ }).click();
    await expect(cardPosition(page)).toContainText('Card 2 of 6');
  } finally {
    await stopServer(server);
  }
});

test('with the device offline, a reload still opens Today with its cards', async ({ page, context }) => {
  // The test above proves the files come from the cache; this one covers a
  // phone in airplane mode, where the browser itself knows it's offline.
  await freshWithStarterCards(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await expect(page.getByRole('heading', { name: /6\s*cards due/ })).toBeVisible();
  await startReview(page);
});

test('sync API requests always go to the server, never through the offline cache', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  // The preview server has no API, but the worker must still leave these alone.
  const [apiResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/sync/v1/info')),
    page.evaluate(() => fetch('./api/sync/v1/info', { cache: 'no-store' }).catch(() => null)),
  ]);
  expect(apiResponse.fromServiceWorker(), 'API fetch answered by the worker').toBe(false);
  const opened = await page.goto('./api/health');
  expect(opened?.fromServiceWorker(), 'API page answered by the worker').toBe(false);

  await page.goto('./');
  const cachedPaths = await page.evaluate(async () => {
    const paths: string[] = [];
    for (const key of await caches.keys()) {
      for (const request of await (await caches.open(key)).keys()) paths.push(new URL(request.url).pathname);
    }
    return paths;
  });
  expect(cachedPaths).toContain('/index.html');
  expect(cachedPaths.filter((path) => path.includes('/api/'))).toEqual([]);
});

test('a new deploy waits for the learner, then reloads into the new version without losing the session', async ({ page }) => {
  // Serve a copy of the build so this test can publish a "new version" of it.
  const dir = await mkdtemp(join(tmpdir(), 'recall-update-'));
  await cp('dist', dir, { recursive: true });
  const { server, base } = await startServer(dir);
  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Add six starter cards' }).click();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.getByRole('button', { name: /Start review/ }).click();
    await page.getByLabel('Your answer').fill('Draft typed before the update');
    await waitForSavedDraft(page, 'Draft typed before the update', null);

    // Publish a new version: different index.html and a new service worker version.
    const index = join(dir, 'index.html');
    await writeFile(index, (await readFile(index, 'utf8')).replace('<head>', '<head><meta name="recall-build" content="2">'));
    const sw = join(dir, 'sw.js');
    await writeFile(sw, (await readFile(sw, 'utf8')).replace(/const VERSION = "[^"]+";/, 'const VERSION = "test-v2";'));
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));

    const notice = page.getByText('A new version of Recall is ready');
    await expect(notice).toBeVisible();
    // Nothing reloads on its own: the learner is still mid-answer on the old version.
    await expect(page.getByLabel('Your answer')).toHaveValue('Draft typed before the update');
    expect(await page.locator('meta[name="recall-build"]').count()).toBe(0);

    await page.getByRole('button', { name: 'Reload now' }).click();
    await expect(page.locator('meta[name="recall-build"]')).toHaveCount(1);
    await expect(notice).toBeHidden();
    await expect(page.getByLabel('Your answer')).toHaveValue('Draft typed before the update');
    expect(await page.evaluate(() => caches.keys())).toEqual(['recall-test-v2']);
  } finally {
    await stopServer(server);
  }
});
