/* eslint-disable */
import { chromium } from 'playwright';
import { copyFile, mkdir, rm } from 'node:fs/promises';
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
  // — sweep through three modes —
  let i = 0;
  await page.click('button[title^="Code"]');
  await wait(400);
  for (let j = 0; j < 6; j++) { await frame(page, 'modes', i++); await wait(300); }

  await page.click('button[title^="Chat"]');
  await wait(400);
  for (let j = 0; j < 6; j++) { await frame(page, 'modes', i++); await wait(300); }

  await page.click('button[title^="Cowork"]');
  await wait(400);
  for (let j = 0; j < 6; j++) { await frame(page, 'modes', i++); await wait(300); }

  await page.click('button[title^="Code"]');
  await wait(400);
  for (let j = 0; j < 6; j++) { await frame(page, 'modes', i++); await wait(300); }
}

async function captureSlash(page) {
  // Switch to Code mode first
  await page.click('button[title^="Code"]');
  await wait(300);

  let i = 0;
  for (let j = 0; j < 3; j++) { await frame(page, 'slash', i++); await wait(200); }

  await page.click('textarea');
  await wait(200);
  await page.keyboard.type('/', { delay: 150 });
  await wait(500);
  for (let j = 0; j < 4; j++) { await frame(page, 'slash', i++); await wait(250); }

  await page.keyboard.type('g', { delay: 200 });
  await wait(400);
  for (let j = 0; j < 4; j++) { await frame(page, 'slash', i++); await wait(250); }

  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await wait(300);

  // @ mention
  await page.keyboard.type('@', { delay: 200 });
  await wait(800);
  for (let j = 0; j < 4; j++) { await frame(page, 'slash', i++); await wait(250); }

  await page.keyboard.type('pack', { delay: 150 });
  await wait(500);
  for (let j = 0; j < 4; j++) { await frame(page, 'slash', i++); await wait(250); }

  // Clean up
  await page.keyboard.press('Escape');
  for (let j = 0; j < 10; j++) await page.keyboard.press('Backspace');
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1.5,
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await wait(1500);

  console.log('▶ capturing mode switching…');
  await captureModes(page);

  console.log('▶ capturing slash / @ dropdowns…');
  await captureSlash(page);

  await browser.close();

  console.log('▶ encoding GIFs with ffmpeg…');
  for (const name of ['modes', 'slash']) {
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

  // Also keep a hero PNG (first frame of modes)
  await copyFile(path.join(TMP, 'modes-000.png'), path.join(OUT, 'hero.png'));

  // Clean up frame folder
  await rm(TMP, { recursive: true, force: true });

  console.log('✓ assets/ ready');
}

main().catch((e) => { console.error(e); process.exit(1); });
