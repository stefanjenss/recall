// Render PNG app icons from public/icon.svg with the bundled Chromium.
// Usage: node scripts/render-icons.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const svg = await readFile(new URL('../public/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size] of [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await writeFile(new URL(`../public/${name}`, import.meta.url), await page.screenshot({ type: 'png' }));
}
await browser.close();
console.log('Icons written to public/');
