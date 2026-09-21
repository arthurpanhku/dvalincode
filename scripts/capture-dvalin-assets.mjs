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
 *   1. A running Dvalin UI. By default this is `npm run dev:all` at 5173;
 *      set DVALINCODE_CAPTURE_URL to capture a native-app server instead.
 *   2. The workspace to scan is the project the app currently has open. The app
 *      picks the most recent session's cwd, so the simplest way to point it at a
 *      demo project is one headless turn there first:
 *      `echo "hi" | npx tsx src/index.ts run - --cwd <project> --mode chat`
 *
 * Usage:
 *   node scripts/capture-dvalin-assets.mjs out.png            # scan, then capture
 *   node scripts/capture-dvalin-assets.mjs out.png --builtin-only
 *   DVALINCODE_CAPTURE_URL=http://127.0.0.1:53704 \
 *   DVALINCODE_CAPTURE_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
 *     node scripts/capture-dvalin-assets.mjs out.png --builtin-only
 *   node scripts/capture-dvalin-assets.mjs out.png --session  # also load the
 *                                                             # newest remediation
 *                                                             # run into the thread
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const out = process.argv[2];
const withSession = process.argv.includes('--session');
const builtinOnly = process.argv.includes('--builtin-only');
const appUrl = process.env.DVALINCODE_CAPTURE_URL ?? 'http://localhost:5173';
const browserExecutable = process.env.DVALINCODE_CAPTURE_BROWSER;
const viewportWidth = Number.parseInt(process.env.DVALINCODE_CAPTURE_WIDTH ?? '1440', 10);
const viewportHeight = Number.parseInt(process.env.DVALINCODE_CAPTURE_HEIGHT ?? '1100', 10);
if (!out) {
  console.error('usage: node scripts/capture-dvalin-assets.mjs <out.png> [--session] [--builtin-only]');
  process.exit(1);
}

const browser = await chromium.launch(browserExecutable ? { executablePath: browserExecutable } : undefined);
const page = await browser.newPage({
  viewport: { width: viewportWidth, height: viewportHeight },
  deviceScaleFactor: 2,
});

await page.addInitScript(() => localStorage.setItem('dvalincode-theme', 'light'));
await page.goto(appUrl);

await page.getByRole('button', { name: 'Dvalin', exact: true }).click();
await page.getByRole('heading', { name: 'Dvalin security workspace' }).waitFor();

if (withSession) {
  await page.getByText('Remediation complete').first().click();
  await page.waitForTimeout(1500);
}

if (builtinOnly) {
  // Keep smoke-test captures deterministic and network-independent. The UI
  // still lists every discovered engine, while only the local built-in scanner
  // is selected for this run.
  await page.getByText('Evidence configuration', { exact: true }).click();
  for (const name of ['Disable Semgrep CE', 'Disable Trivy', 'Disable OSV-Scanner']) {
    const toggle = page.getByRole('button', { name });
    if (await toggle.count()) await toggle.click();
  }
  await page.getByText('Evidence configuration', { exact: true }).click();
}

await page.getByRole('button', { name: 'Scan project' }).click();
// The external engines take a while; wait for the button to settle back.
await page.getByRole('button', { name: 'Re-run security scan' }).waitFor({ timeout: 180_000 });

// Wait until both evidence sections have rendered before capturing them.
await page.getByRole('region', { name: 'Verification status' }).waitFor();
await page.getByText('Scanner coverage', { exact: true }).waitFor();
await page.waitForTimeout(600);

const outputPath = resolve(out);
await mkdir(dirname(outputPath), { recursive: true });
await page.screenshot({ path: outputPath });
console.log(`captured ${outputPath} from ${appUrl}`);
await browser.close();
