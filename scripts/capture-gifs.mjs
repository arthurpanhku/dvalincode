/* eslint-disable */
import { chromium } from 'playwright';
import { mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const URL = process.env.URL ?? 'http://localhost:5173';
const OUT = path.join(process.cwd(), 'assets');
const TMP = path.join(OUT, '.frames');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function frame(page, name, n) {
  const file = path.join(TMP, `${name}-${String(n).padStart(3, '0')}.png`);
  await page.screenshot({ path: file });
  return file;
}

async function captureModes(page) {
  // Sweep through the three v0.14 workspaces.
  let i = 0;
  for (const name of ['Home', 'Code', 'Dvalin']) {
    await page.getByRole('button', { name, exact: true }).click();
    await wait(400);
    for (let j = 0; j < 8; j++) {
      await frame(page, 'modes', i++);
      await wait(250);
    }
  }
}

async function main() {
  // Only the frame scratch dir is recreated — assets/ also holds the logo,
  // real Dvalin case captures, and ASSET_PROVENANCE.md, which must survive re-runs.
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  // PW_CHANNEL=chrome uses the locally installed Chrome instead of a
  // downloaded Playwright browser.
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1.5,
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await wait(1500);

  // Load the most recent session (if any) so the thread has content.
  try {
    await page.click('text=express-rate-limit', { timeout: 3000 });
    await wait(800);
  } catch {
    // fresh install — capture the welcome state instead
  }

  console.log('▶ capturing mode switching…');
  await captureModes(page);

  await browser.close();

  console.log('▶ encoding current workspace GIF with ffmpeg…');
  for (const name of ['modes']) {
    const palette = path.join(TMP, `${name}-palette.png`);
    execFileSync('ffmpeg', [
      '-y',
      '-framerate',
      '4',
      '-i',
      path.join(TMP, `${name}-%03d.png`),
      '-vf',
      'palettegen=max_colors=128',
      palette,
    ], { stdio: 'inherit' });
    execFileSync('ffmpeg', [
      '-y',
      '-framerate',
      '4',
      '-i',
      path.join(TMP, `${name}-%03d.png`),
      '-i',
      palette,
      '-lavfi',
      'paletteuse',
      '-loop',
      '0',
      path.join(OUT, `${name}.gif`),
    ], { stdio: 'inherit' });
  }

  // Clean up frame folder
  await rm(TMP, { recursive: true, force: true });

  console.log('✓ assets/ ready');
}

main().catch((e) => { console.error(e); process.exit(1); });
