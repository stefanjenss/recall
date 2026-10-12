// Phone ↔ laptop sync through the real sync server, which also serves the app.
// Each test starts its own server on a spare port with an empty data folder.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noHorizontalScroll } from './helpers';

const KEY = 'e2e-sync-key-0123456789abcdef';
const SERVER = 'dist-server/recall-server.mjs';

interface SyncServer {
  url: string;
  stop: () => Promise<void>;
}

async function startServer(port: number): Promise<SyncServer> {
  if (!existsSync(SERVER)) execSync('npm run build:server', { stdio: 'inherit' });
  const dataDir = await mkdtemp(join(tmpdir(), 'recall-e2e-'));
  const child: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: { ...process.env, RECALL_PORT: String(port), RECALL_DATA_DIR: dataDir, RECALL_SYNC_KEY: KEY, RECALL_STATIC_DIR: 'dist' },
    stdio: 'pipe',
  });
  const url = `http://localhost:${port}/`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}api/health`)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function device(browser: Browser, kind: 'laptop' | 'phone', url: string): Promise<Page> {
  const context = await browser.newContext(
    kind === 'laptop'
      ? { viewport: { width: 1280, height: 860 }, baseURL: url }
      : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, baseURL: url },
  );
  return context.newPage();
}

async function checkConnection(page: Page) {
  await page.goto('./#/settings');
  // The address is filled in because the page itself comes from the sync server.
  await expect(page.getByLabel('Server address')).toHaveValue(new URL(page.url()).origin + '/');
  await page.getByLabel('Sync key').fill(KEY);
  await page.getByRole('button', { name: 'Check connection' }).click();
  await expect(page.getByText('The server answered')).toBeVisible();
}

let server: SyncServer;

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Each test drives its own laptop and phone.');
  server = await startServer(4300 + testInfo.workerIndex);
});

test.afterEach(async () => {
  await server?.stop();
});

test('a laptop and a phone stay in step through the sync server', async ({ browser }) => {
  const laptop = await device(browser, 'laptop', server.url);
  await laptop.goto('./');
  await laptop.getByRole('button', { name: 'Add six starter cards' }).click();
  await expect(laptop.getByText(/Added 6 starter cards/)).toBeVisible();
  await checkConnection(laptop);
  await expect(laptop.getByText('It doesn’t hold any data yet. This device has 6 cards')).toBeVisible();
  await laptop.getByRole('button', { name: 'Connect and upload this device’s data' }).click();
  await expect(laptop.getByText('Connected and synced. This device will stay in step with the server.')).toBeVisible();
  await expect(laptop.locator('.sync-status')).toContainText('Up to date');
  await expect(laptop.locator('.sidebar__foot')).toHaveText('Synced with localhost.');
  const axe = await new AxeBuilder({ page: laptop }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);

  const phone = await device(browser, 'phone', server.url);
  await checkConnection(phone);
  await expect(phone.getByText('It holds 6 cards, 0 reviews, and 0 reflections. This device has no data yet.')).toBeVisible();
  await phone.getByRole('button', { name: 'Connect and download' }).click();
  await expect(phone.getByText(/now has the server’s copy/)).toBeVisible();
  await noHorizontalScroll(phone);

  await phone.goto('./');
  await expect(phone.getByRole('heading', { name: /6\s*cards due/ })).toBeVisible();
  await phone.getByRole('button', { name: /Start review/ }).click();
  await phone.getByRole('button', { name: /Reveal answer/ }).click();
  await phone.getByRole('button', { name: /^Good/ }).click();
  await expect(phone.getByText(/Card 2 of/)).toBeVisible();

  // The review uploads shortly after it's saved; the laptop picks it up on its next sync.
  await phone.goto('./#/settings');
  await expect(phone.locator('.stat-list__item', { hasText: 'Waiting to upload' })).toContainText('0 changes', {
    timeout: 10_000,
  });

  await laptop.goto('./#/settings');
  await laptop.getByRole('button', { name: 'Sync now' }).click();
  await expect(laptop.locator('.sync-status')).toContainText('Up to date');
  await laptop.goto('./');
  await expect(laptop.getByRole('heading', { name: /5\s*cards due/ })).toBeVisible();
  await expect(laptop.locator('.stat-list__item', { hasText: 'Reviewed today' })).toContainText('1');
});

test('connecting a device that already has data asks what to do, and confirms before replacing', async ({ browser }) => {
  const laptop = await device(browser, 'laptop', server.url);
  await laptop.goto('./');
  await laptop.getByRole('button', { name: 'Add six starter cards' }).click();
  await checkConnection(laptop);
  await laptop.getByRole('button', { name: 'Connect and upload this device’s data' }).click();
  await expect(laptop.locator('.sync-status')).toContainText('Up to date');

  const phone = await device(browser, 'phone', server.url);
  await phone.goto('./#/add');
  await phone.getByLabel('Question').fill('Only on the phone?');
  await phone.getByLabel('Answer', { exact: true }).fill('Yes.');
  await phone.getByRole('button', { name: 'Save card' }).click();
  await expect(phone.getByText('Card added. It’s due now.')).toBeVisible();

  await phone.goto('./#/settings');
  await phone.getByLabel('Sync key').fill('not-the-right-key-at-all');
  await phone.getByRole('button', { name: 'Check connection' }).click();
  await expect(phone.getByText('The server rejected the sync key.')).toBeVisible();

  await phone.getByLabel('Sync key').fill(KEY);
  await phone.getByRole('button', { name: 'Check connection' }).click();
  const choices = phone.getByRole('group', { name: 'Both have data. What should happen?' });
  await expect(choices.getByRole('radio')).toHaveCount(3);
  await noHorizontalScroll(phone);
  await choices.getByRole('radio', { name: /Use the server’s copy/ }).check();
  await phone.getByRole('button', { name: 'Connect', exact: true }).click();
  const dialog = phone.getByRole('dialog', { name: 'Replace this device’s data?' });
  await expect(dialog).toContainText('1 card');
  await dialog.getByRole('button', { name: 'Replace this device’s data' }).click();
  await expect(phone.locator('.sync-status')).toContainText('Up to date');
  await phone.goto('./');
  await expect(phone.getByRole('heading', { name: /6\s*cards due/ })).toBeVisible();
  await phone.goto('./#/collection');
  await expect(phone.getByText('Only on the phone?')).toHaveCount(0);
});
