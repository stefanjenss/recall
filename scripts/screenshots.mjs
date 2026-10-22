// Capture the documentation screenshots from a running build.
//   npm run build && npx vite preview --port 4173 &   (then)   node scripts/screenshots.mjs
// Uses only real interactions: starter cards, a short session, a reflection.
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const BASE = process.env.RECALL_URL ?? 'http://localhost:4173/';
const OUT = new URL('../docs/screenshots/', import.meta.url);
await mkdir(OUT, { recursive: true });

// A plausible typed attempt for whichever starter card comes up.
const SAMPLE_ATTEMPTS = {
  'testing effect': 'Pulling an answer out of memory strengthens it more than rereading it does.',
  index: 'Reads that filter on the column get faster, but every write has to update the index too.',
  idempotent: 'Running it twice gives the same result as running it once, so retries are safe.',
  customer: 'A LEFT JOIN from customers to orders. Customers with no orders still appear, with NULLs.',
  spacing: 'Some forgetting makes the next recall harder, and harder recall builds a stronger memory.',
  blocked: 'Blocked repeats one kind of problem; interleaved mixes them so you learn to pick the method.',
};

// The start of each starter card's correct option, so the quick-check shot can show a miss next to the right answer.
const CORRECT_OPTIONS = {
  'testing effect': 'Pulling information out of memory',
  index: 'Faster reads on that column in exchange for extra storage',
  idempotent: 'Running it again',
  customer: 'LEFT JOIN customers',
  spacing: 'Some forgetting',
  blocked: 'Blocked feels more productive',
};

const browser = await chromium.launch();
const viewports = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

for (const [label, options] of Object.entries(viewports)) {
  const context = await browser.newContext({ ...options, timezoneId: 'America/New_York' });
  const page = await context.newPage();
  const shot = (name, fullPage = false) => page.screenshot({ path: new URL(`${label}-${name}.png`, OUT).pathname, fullPage });

  await page.goto(BASE);
  await page.getByRole('button', { name: 'Add six starter cards' }).click();
  await page.getByText(/Added 6 starter cards/).waitFor();
  await page.getByRole('button', { name: 'Dismiss message' }).click();

  // Review three cards so Progress has real data, then capture Today mid-way.
  await page.getByRole('radio', { name: '5' }).check();
  await page.getByRole('button', { name: /Start review/ }).click();
  const ratings = [/^Good/, /^Again/, /^Easy/];
  for (const rating of ratings) {
    await page.getByRole('button', { name: /Reveal answer/ }).click();
    await page.getByRole('button', { name: rating }).click();
  }
  await page.getByText(`Card ${ratings.length + 1} of 5`).waitFor();
  const question = await page.locator('.practice__question').innerText();
  const attempt = Object.entries(SAMPLE_ATTEMPTS).find(([key]) => question.toLowerCase().includes(key))?.[1] ?? '';
  await page.getByRole('textbox', { name: 'Your answer' }).fill(attempt);
  await page.getByRole('radio', { name: 'Somewhat' }).check();
  await page.locator('.practice__question').click();
  await shot('practice');
  await page.getByRole('button', { name: /Reveal answer/ }).click();
  await page.getByRole('heading', { name: 'Answer', exact: true }).waitFor();
  await shot('answer', label === 'mobile');
  await page.getByRole('button', { name: /^Good/ }).click();
  await page.getByRole('button', { name: 'End session' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'End session' }).click();
  await page
    .getByLabel(/What will you take from this session/)
    .fill('Spacing feels slower than cramming, but the second recall was noticeably easier.');
  await page.getByRole('button', { name: 'Save reflection' }).click();
  await page.getByText('Reflection saved.').waitFor();
  await shot('session-summary', true);

  await page.goto(BASE);
  await page.locator('main h1').waitFor();
  await shot('today', true);
  await page.goto(`${BASE}#/collection`);
  await page.locator('.card-row').first().waitFor();
  await shot('collection', true);
  await page.goto(`${BASE}#/progress`);
  await page.locator('.activity').waitFor();
  await shot('progress', true);
  await page.goto(`${BASE}#/add/import`);
  await page.locator('main h1').waitFor();
  await shot('import', true);

  // A quick check on a card that is still due, picking a wrong option to show both marks.
  await page.goto(BASE);
  await page.getByRole('radio', { name: /Quick check/ }).check();
  await page.getByRole('button', { name: /Start quick check/ }).click();
  await page.getByRole('heading', { name: 'Choose the best answer' }).waitFor();
  await page.locator('.practice__question').click();
  await shot('quick-check');
  const prompt = (await page.locator('.practice__question').innerText()).toLowerCase();
  const right = Object.entries(CORRECT_OPTIONS).find(([key]) => prompt.includes(key))?.[1] ?? '';
  const choiceTexts = await page.locator('button.choice .choice__text').allInnerTexts();
  await page
    .locator('button.choice')
    .nth(
      Math.max(
        0,
        choiceTexts.findIndex((o) => !o.startsWith(right)),
      ),
    )
    .click();
  await page.getByRole('heading', { name: 'Full answer' }).waitFor();
  await shot('quick-check-result', label === 'mobile');
  await context.close();
}

await browser.close();
console.log('Screenshots written to docs/screenshots/');
