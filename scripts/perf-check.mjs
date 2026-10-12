// Rough responsiveness check with a large synthetic collection.
//   npm run build && npx vite preview --port 4173 &   (then)   node scripts/perf-check.mjs [cards] [reviews]
// Restores a generated backup through Settings, then times common interactions
// end to end (including Playwright overhead, so real numbers are a bit lower).
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const BASE = process.env.RECALL_URL ?? 'http://localhost:4173/';
const CARDS = Number(process.argv[2] ?? 5000);
const REVIEWS = Number(process.argv[3] ?? 20000);
const DAY = 86_400_000;
const now = Date.now();

const topics = Array.from({ length: 12 }, (_, i) => `Topic ${String.fromCharCode(65 + i)}`);
const cards = [];
const schedules = [];
for (let i = 0; i < CARDS; i++) {
  const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  cards.push({
    id,
    topic: topics[i % topics.length],
    question: `Question ${i}: explain concept ${i} and when you would apply it in a real system?`,
    answer: `Answer ${i}. The key idea, followed by an example that makes it concrete.`,
    kind: ['recall', 'apply', 'compare', 'explain'][i % 4],
    source: null,
    contentVersion: 1,
    createdAt: now - 200 * DAY,
    updatedAt: now - 200 * DAY,
    deletedAt: null,
  });
  const reviewed = i % 3 !== 0;
  schedules.push({
    cardId: id,
    dueAt: now + ((i % 40) - 10) * DAY,
    intervalDays: reviewed ? (i % 60) + 1 : 0,
    ease: 2.5,
    reviewCount: reviewed ? 3 : 0,
    lapseCount: 0,
    paused: i % 50 === 0,
    schedulerVersion: 'recall-sm2-v1',
    stateVersion: reviewed ? 3 : 0,
    lastReviewedAt: reviewed ? now - 5 * DAY : null,
  });
}
const reviews = Array.from({ length: REVIEWS }, (_, i) => {
  const card = cards[i % CARDS];
  const snap = { dueAt: now, intervalDays: 1, ease: 2.5, reviewCount: 1, lapseCount: 0, stateVersion: 1 };
  return {
    id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    cardId: card.id,
    cardVersion: 1,
    sessionId: null,
    response: '',
    confidence: ['unsure', 'somewhat', 'confident', null][i % 4],
    rating: (i % 4) + 1,
    before: snap,
    after: { ...snap, stateVersion: 2 },
    schedulerVersion: 'recall-sm2-v1',
    startedAt: now - (i % 180) * DAY,
    revealedAt: null,
    committedAt: now - (i % 180) * DAY,
    snapshot: { topic: card.topic, question: card.question, answer: card.answer, kind: card.kind, source: null },
  };
});

const dir = await mkdtemp(join(tmpdir(), 'recall-perf-'));
const file = join(dir, 'backup.json');
await writeFile(
  file,
  JSON.stringify({
    format: 'recall-backup',
    formatVersion: 1,
    exportedAt: new Date(now).toISOString(),
    schedulerVersion: 'recall-sm2-v1',
    data: { cards, schedules, reviews, sessions: [], reflections: [], rubrics: [], assessments: [], preferences: null },
  }),
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const timings = [];
async function time(label, fn) {
  const start = performance.now();
  await fn();
  timings.push([label, Math.round(performance.now() - start)]);
}

await page.goto(`${BASE}#/settings`);
await time('validate backup file (dry run)', async () => {
  await page.getByLabel('Choose a backup file (.json)').setInputFiles(file);
  await page.getByRole('dialog', { name: 'Replace this workspace?' }).waitFor();
});
await time('restore (atomic replace + reload)', async () => {
  await page.getByRole('button', { name: 'Replace with backup' }).click();
  await page.getByText(/Restored/).waitFor();
});
await time('cold load of Today (page reload)', async () => {
  await page.reload();
  await page.locator('.due-figure__number').waitFor();
});
await time('navigate Today → Collection (first 100 rows)', async () => {
  await page.locator('.sidebar .nav__link', { hasText: 'Collection' }).click();
  await page.locator('.card-row').first().waitFor();
});
await time('search the collection', async () => {
  await page.getByLabel('Search').fill('concept 4321');
  await page.getByText('1 matching card').waitFor();
});
await time('clear search', async () => {
  await page.getByLabel('Search').fill('');
  await page.getByText(`${CARDS} cards`, { exact: true }).waitFor();
});
await time('filter by topic', async () => {
  await page.getByLabel('Topic', { exact: true }).selectOption('Topic C');
  await page.getByText(/matching cards/).waitFor();
});
await time('filter by status: due now', async () => {
  await page.getByLabel('Status').selectOption('due');
  await page.getByText(/matching card/).waitFor();
});
await time('navigate to Progress', async () => {
  await page.locator('.sidebar .nav__link', { hasText: 'Progress' }).click();
  await page.locator('.activity').waitFor();
});
await time('start a 20-card session', async () => {
  await page.locator('.sidebar .nav__link', { hasText: 'Today' }).click();
  await page.getByRole('button', { name: /Start review/ }).click();
  await page.getByRole('button', { name: /Reveal answer/ }).waitFor();
});
await page.waitForTimeout(1500); // a learner reads the question before revealing
await time('reveal + rate (commit) → next card', async () => {
  await page.getByRole('button', { name: /Reveal answer/ }).click();
  await page.getByRole('button', { name: /^Good/ }).click();
  await page.getByText('Card 2 of 20').waitFor();
});

await browser.close();
console.log(`\n${CARDS} cards, ${REVIEWS} reviews — Chromium ${chromium.name()}, ${process.platform}\n`);
for (const [label, ms] of timings) console.log(`${String(ms).padStart(6)} ms  ${label}`);
