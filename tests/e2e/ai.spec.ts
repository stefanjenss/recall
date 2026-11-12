// AI feedback through the real sync server, with a scripted stand-in for the
// model provider (an OpenAI-compatible endpoint the server calls). This checks
// the whole path except the model itself: what a real model answers is
// covered by `npm run test:ai-real`.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noHorizontalScroll, readStore } from './helpers';

const KEY = 'e2e-sync-key-0123456789abcdef';
const SERVER = 'dist-server/recall-server.mjs';
const MODEL = 'stub-model';

interface Provider {
  url: string;
  /** Every request body the server sent to the provider. */
  requests: Array<{ authorization: string | undefined; body: { messages: Array<{ role: string; content: string }> } }>;
  stop: () => Promise<void>;
}

/**
 * Plays the model. A rubric request gets a two-criterion draft. A grading
 * request gets the first criterion met and the rest missing, except that an
 * answer containing GARBLE gets prose back the first time it is seen.
 */
async function startProvider(port: number): Promise<Provider> {
  const requests: Provider['requests'] = [];
  let garbled = false;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as Provider['requests'][number]['body'];
      requests.push({ authorization: req.headers.authorization, body });
      const system = body.messages[0]!.content;
      const user = JSON.parse(body.messages[1]!.content) as {
        learnerAnswer?: string;
        rubric?: { criteria: Array<{ id: string }> };
      };
      let content: string;
      if (system.includes('draft a grading rubric')) {
        content = JSON.stringify({
          criteria: [
            {
              description: 'Says that every row of the left table is kept',
              weight: 3,
              requiredConcepts: [],
              acceptableAlternatives: [],
            },
            {
              description: 'Says that unmatched rows get NULL on the right side',
              weight: 2,
              requiredConcepts: ['NULL'],
              acceptableAlternatives: [],
            },
          ],
          criticalMisconceptions: [],
        });
      } else if (user.learnerAnswer?.includes('GARBLE') && !garbled) {
        garbled = true;
        content = 'Great answer! I would give it full marks.';
      } else {
        content = JSON.stringify({
          status: 'assessed',
          criteria: user.rubric!.criteria.map((c, i) => ({
            id: c.id,
            result: i === 0 ? 'met' : 'missing',
            evidence: i === 0 ? 'keeps every left row' : '',
          })),
          incorrectClaims: [],
          contradictsReference: false,
          criticalMisconceptions: [],
          correctAspects: ['You said the left table’s rows are all kept.'],
          missingAspects: ['Unmatched rows have NULL in the right table’s columns.'],
          explanation: 'You have the main idea. Also say what happens to rows without a match.',
          uncertaintyReason: '',
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${port}/v1`, requests, stop: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function startRecall(port: number, env: Record<string, string>) {
  if (!existsSync(SERVER)) execSync('npm run build:server', { stdio: 'inherit' });
  const dataDir = await mkdtemp(join(tmpdir(), 'recall-e2e-ai-'));
  const child: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env,
      RECALL_PORT: String(port),
      RECALL_DATA_DIR: dataDir,
      RECALL_SYNC_KEY: KEY,
      RECALL_STATIC_DIR: 'dist',
      ...env,
    },
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

async function addCard(page: Page) {
  await page.goto('./#/add');
  await page.getByLabel('Question').fill('What does a LEFT JOIN return?');
  await page
    .getByLabel('Answer', { exact: true })
    .fill('Every row from the left table. Where the right table has no match, its columns are NULL.');
  await page.getByRole('button', { name: 'Save card' }).click();
  await expect.poll(async () => (await readStore(page, 'cards')).length).toBe(1);
}

async function connect(page: Page) {
  await page.goto('./#/settings');
  await page.getByLabel('Sync key').fill(KEY);
  await page.getByRole('button', { name: 'Check connection' }).click();
  await page.getByRole('button', { name: 'Connect and upload this device’s data' }).click();
  await expect(page.locator('.sync-status')).toContainText('Up to date');
}

async function expectNoAxeViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

let provider: Provider | null = null;
let recall: Awaited<ReturnType<typeof startRecall>>;

test.afterEach(async () => {
  await recall?.stop();
  await provider?.stop();
  provider = null;
});

test('AI feedback grades a typed answer, survives a bad reply, and never rates for the learner', async ({
  browser,
}, testInfo) => {
  const offset = testInfo.workerIndex * 2 + (testInfo.project.name === 'phone' ? 40 : 0);
  provider = await startProvider(4500 + offset);
  recall = await startRecall(4400 + offset, {
    RECALL_AI_PROVIDER: 'openai-compatible',
    RECALL_AI_BASE_URL: provider.url,
    RECALL_AI_MODEL: MODEL,
    RECALL_AI_API_KEY: 'provider-secret-e2e',
  });
  const phone = testInfo.project.name === 'phone';
  const context = await browser.newContext({
    baseURL: recall.url,
    ...(phone
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1280, height: 900 } }),
  });
  const page = await context.newPage();
  await addCard(page);
  await connect(page);

  // Off by default: nothing about AI on the practice screen, and nothing sent.
  await page.goto('./');
  await page.getByRole('button', { name: /Start review/ }).click();
  await page.getByLabel('Your answer').fill('It keeps every left row.');
  await page.getByRole('button', { name: /Reveal answer/ }).click();
  await expect(page.getByRole('heading', { name: 'How well did you recall it?' })).toBeVisible();
  await expect(page.getByText('AI feedback')).toHaveCount(0);
  await page.getByRole('button', { name: 'End session' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'End session' }).click();
  await expect(page.getByRole('heading', { name: 'Session ended' })).toBeVisible();

  // Turn it on for this device. Settings names the model and where answers go.
  await page.goto('./#/settings');
  await page.getByRole('radio', { name: /Through my sync server/ }).check();
  await expect(page.locator('#ai').getByText('Ready.', { exact: true })).toBeVisible();
  await expect(page.locator('#ai')).toContainText(MODEL);
  await expect(page.locator('#ai')).toContainText('a model on your own network');
  await expectNoAxeViolations(page, 'settings: AI feedback on');
  await noHorizontalScroll(page);

  // A card needs a rubric the learner has saved. Draft one, review it, save it.
  await page.goto('./#/collection');
  await page
    .getByRole('link', { name: /LEFT JOIN/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Edit card' })).toBeVisible();
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByText('Draft to review')).toBeVisible();
  expect(await readStore(page, 'rubrics')).toHaveLength(0);
  await expect(page.getByLabel('A complete answer…').first()).toHaveValue('Says that every row of the left table is kept');
  await expectNoAxeViolations(page, 'card editor: rubric draft');
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: 'Save rubric' }).click();
  await expect(page.getByText(/Rubric saved/)).toBeVisible();
  expect(await readStore<{ version: number; reviewed: boolean }>(page, 'rubrics')).toMatchObject([
    { version: 1, reviewed: true },
  ]);

  // Practice: nothing is sent on reveal, only when the learner asks.
  const sentBefore = provider.requests.length;
  await page.goto('./');
  await page.getByRole('button', { name: /Start review/ }).click();
  await page.getByLabel('Your answer').fill('GARBLE It keeps every left row.');
  await page.getByRole('button', { name: /Reveal answer/ }).click();
  await expect(page.getByRole('button', { name: 'Get AI feedback' })).toBeVisible();
  await expect(page.locator('#ai-feedback-sends')).toContainText(MODEL);
  expect(provider.requests.length).toBe(sentBefore);
  const scheduleBefore = await readStore(page, 'schedules');

  // A reply that isn't a valid evaluation: a clear message, nothing shown as a grade, rating still available.
  await page.getByRole('button', { name: 'Get AI feedback' }).click();
  await expect(page.getByText('No AI feedback this time')).toBeVisible();
  await expect(page.getByText(/Suggested rating/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Good/ })).toBeEnabled();
  expect(await readStore(page, 'assessments')).toHaveLength(0);
  expect(await readStore(page, 'schedules')).toEqual(scheduleBefore);
  await expect(page.locator('.practice__frozen-text')).toHaveText('GARBLE It keeps every left row.');
  await expectNoAxeViolations(page, 'practice: AI feedback failed');

  // Try again: a checked result, with a suggestion that is only a suggestion.
  await page.getByRole('button', { name: 'Try AI feedback again' }).click();
  await expect(page.locator('.ai-feedback__label')).toContainText('Partially correct');
  await expect(page.locator('.ai-feedback__label')).toContainText('60% of the rubric covered');
  await expect(page.getByText('Suggested rating: Hard.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What was missing' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Hard/ })).toContainText('AI suggestion');
  await expect(page.getByRole('button', { name: /^Good/ })).not.toContainText('AI suggestion');
  expect(await readStore(page, 'schedules')).toEqual(scheduleBefore);
  expect(await readStore(page, 'reviews')).toHaveLength(0);
  await expectNoAxeViolations(page, 'practice: AI feedback shown');
  await noHorizontalScroll(page);
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1280, height: 900 });

  // The result survives a reload, without asking the model again.
  const sentAfterGrade = provider.requests.length;
  await page.reload();
  await expect(page.getByText('Suggested rating: Hard.')).toBeVisible();
  expect(provider.requests.length).toBe(sentAfterGrade);

  // Only the card, rubric, and answer went to the provider, as data, with the server's key.
  const graded = provider.requests.at(-1)!;
  expect(graded.authorization).toBe('Bearer provider-secret-e2e');
  expect(Object.keys(JSON.parse(graded.body.messages[1]!.content)).sort()).toEqual([
    'learnerAnswer',
    'question',
    'referenceAnswer',
    'rubric',
  ]);
  expect(JSON.stringify(graded.body)).not.toContain(KEY);

  // Override: the learner's Good is what gets saved and scheduled.
  await page.getByLabel(/Rating it differently/).fill('I said the NULL part aloud.');
  await page.getByRole('button', { name: /^Good/ }).click();
  await expect(page.getByRole('heading', { name: /Session complete|session/i }).first()).toBeVisible();
  await expect.poll(async () => (await readStore(page, 'reviews')).length).toBe(1);
  const [review] = await readStore<{ id: string; rating: number }>(page, 'reviews');
  expect(review!.rating).toBe(3);
  const [assessment] = await readStore<Record<string, unknown>>(page, 'assessments');
  expect(assessment).toMatchObject({
    id: review!.id,
    label: 'partial',
    score: 0.6,
    suggestedRating: 2,
    finalRating: 3,
    overrideReason: 'I said the NULL part aloud.',
    model: MODEL,
    provider: 'openai-compatible',
  });

  // Progress reports it in its own section, apart from self-ratings.
  await page.goto('./#/progress');
  const section = page.locator('section', { has: page.getByRole('heading', { name: /AI feedback/ }) });
  await expect(section).toContainText('1 answer assessed');
  await expect(section).toContainText('You chose the suggested rating in 0 of 1 rated answers');
  await expect(page.locator('section', { has: page.getByRole('heading', { name: /Self-ratings/ }) })).toContainText(
    '1 of 1 reviews',
  );
  await expectNoAxeViolations(page, 'progress: AI feedback');
  await noHorizontalScroll(page);
  await context.close();
});

test('with no model on the server, practice says so and self-rating works as before', async ({ browser }, testInfo) => {
  const offset = testInfo.workerIndex * 2 + (testInfo.project.name === 'phone' ? 40 : 0);
  recall = await startRecall(4401 + offset, {});
  const context = await browser.newContext({ baseURL: recall.url, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await addCard(page);
  await connect(page);
  await page.goto('./#/settings');
  await page.getByRole('radio', { name: /Through my sync server/ }).check();
  await expect(page.getByText('Not set up on the server.')).toBeVisible();

  await page.goto('./#/collection');
  await page
    .getByRole('link', { name: /LEFT JOIN/ })
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'Draft with AI' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add a criterion' }).click();
  await page.getByLabel('A complete answer…').fill('Says that every left row is kept');
  await page.getByRole('button', { name: 'Save rubric' }).click();
  await expect(page.getByText(/Rubric saved/)).toBeVisible();

  await page.goto('./');
  await page.getByRole('button', { name: /Start review/ }).click();
  await page.getByLabel('Your answer').fill('It keeps every left row.');
  await page.getByRole('button', { name: /Reveal answer/ }).click();
  await expect(page.getByText('Your sync server has no AI model set up.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Get AI feedback' })).toHaveCount(0);
  await page.getByRole('button', { name: /^Good/ }).click();
  await expect.poll(async () => (await readStore(page, 'reviews')).length).toBe(1);
  expect(await readStore(page, 'assessments')).toHaveLength(0);
  await context.close();
});
