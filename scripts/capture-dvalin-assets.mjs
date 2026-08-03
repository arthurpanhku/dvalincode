/**
 * Capture the Dvalin README screenshots from a real run.
 *
 * The README claims its scan images are unedited captures of the real
 * application. This is the script that produces them, so that claim is
 * reproducible rather than asserted — see assets/ASSET_PROVENANCE.md.
 *
 * It drives the running dev UI exactly as a user would: open Dvalin, run the
 * scanner suite against the configured project, and screenshot the result.
 * Whatever the engines report is what lands in the image; nothing is staged.
 *
 * Prerequisites:
 *   1. `npm run dev:all` (backend on 3001, Vite on 5173).
 *   2. The workspace to scan is the project the app currently has open. The app
 *      picks the most recent session's cwd, so the simplest way to point it at a
 *      demo project is one headless turn there first:
 *      `echo "hi" | npx tsx src/index.ts run - --cwd <project> --mode chat`
 *
 * Usage:
 *   node scripts/capture-dvalin-assets.mjs out.png            # scan, then capture
 *   node scripts/capture-dvalin-assets.mjs out.png --session  # also load the
 *                                                             # newest remediation
 *                                                             # run into the thread
 */
import { chromium } from 'playwright';

const out = process.argv[2];
const withSession = process.argv.includes('--session');
if (!out) {
  console.error('usage: node scripts/capture-dvalin-assets.mjs <out.png> [--session]');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

await page.addInitScript(() => localStorage.setItem('dvalincode-theme', 'light'));
await page.goto('http://localhost:5173');

await page.getByRole('button', { name: /^Dvalin/ }).click();
await page.getByRole('heading', { name: 'Dvalin security workspace' }).waitFor();

if (withSession) {
  await page.getByText('Remediation complete').first().click();
  await page.waitForTimeout(1500);
}

await page.getByRole('button', { name: 'Scan project' }).click();
// The external engines take a while; wait for the button to settle back.
await page.getByRole('button', { name: 'Re-run security scan' }).waitFor({ timeout: 180_000 });

// Frame the two sections these images exist to show.
await page.evaluate(() => {
  const panel = document.querySelector('aside[aria-label="Dvalin status"]');
  const header = [...panel.querySelectorAll('*')].find(el => el.textContent.trim() === 'Security health');
  panel.scrollTop = header.closest('section').offsetTop - panel.offsetTop - 10;
});
await page.waitForTimeout(600);

await page.screenshot({ path: out });
console.log(`captured ${out}`);
await browser.close();
