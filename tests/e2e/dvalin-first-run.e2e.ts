import { expect, test, type Page } from 'playwright/test';

/**
 * The first run a new user actually sees: open Dvalin, let it discover engines,
 * and act. A broken service round-trip or unreadable controls both fail here
 * silently in manual testing, so they are asserted explicitly.
 */

async function openDvalinPanel(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /^Dvalin/ }).click();
  await expect(page.getByRole('heading', { name: 'Dvalin security workspace' })).toBeVisible();
}

type LowContrastText = { text: string; ratio: number };

/**
 * Every visible, enabled text node in the app measured against its composited
 * background, WCAG AA (4.5:1).
 *
 * Two details this must get right, because getting either wrong is what let an
 * invisible control ship: colors are resolved through a canvas (the theme tokens
 * compute to `oklch()`, which cannot be read as rgb channels), and the effective
 * opacity of every ancestor is folded in (`opacity` never shows up in a computed
 * `color`, so a faded container reads as full contrast otherwise).
 *
 * Disabled controls are exempt — WCAG excludes inactive controls — as are
 * fully transparent ones, which are hover-reveal affordances.
 */
async function lowContrastText(page: Page): Promise<LowContrastText[]> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    type RGBA = { r: number; g: number; b: number; a: number };
    type RGB = { r: number; g: number; b: number };

    const toRGBA = (value: string): RGBA => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r: r!, g: g!, b: b!, a: a! / 255 };
    };
    const over = (fg: RGBA, bg: RGB): RGB => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
    });
    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const luminance = (c: RGB) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);

    const effectiveOpacity = (el: Element) => {
      let opacity = 1;
      for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
        opacity *= Number.parseFloat(getComputedStyle(n).opacity || '1');
      }
      return opacity;
    };
    const backgroundOf = (el: Element): RGB => {
      const layers: RGBA[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const style = getComputedStyle(n);
        const color = toRGBA(style.backgroundColor);
        if (color.a > 0) layers.push({ ...color, a: color.a * Number.parseFloat(style.opacity || '1') });
      }
      let out: RGB = document.documentElement.classList.contains('light')
        ? { r: 255, g: 255, b: 255 }
        : { r: 10, g: 10, b: 10 };
      for (let i = layers.length - 1; i >= 0; i--) out = over(layers[i]!, out);
      return out;
    };

    const failures: Array<{ text: string; ratio: number }> = [];
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el || seen.has(el)) continue;
      seen.add(el);

      const box = el.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue;
      if ((el.closest('button') as HTMLButtonElement | null)?.disabled) continue;

      const opacity = effectiveOpacity(el);
      if (opacity === 0) continue;

      const background = backgroundOf(el);
      const raw = toRGBA(getComputedStyle(el).color);
      const foreground = over({ ...raw, a: raw.a * opacity }, background);
      const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      const ratio = (lighter! + 0.05) / (darker! + 0.05);
      if (ratio < 4.5) failures.push({ text: text.slice(0, 40), ratio: Number(ratio.toFixed(2)) });
    }
    return failures.sort((a, b) => a.ratio - b.ratio);
  });
}

test('discovers detection engines on the first Dvalin run', async ({ page }) => {
  await openDvalinPanel(page);

  // Proves the web → API round-trip: engines are reported by the server, not hardcoded.
  await page.getByText('Evidence configuration', { exact: true }).click();
  await expect(page.getByText('Detection engines', { exact: true })).toBeVisible();
  await expect(page.getByText('Dvalin Built-in')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scan project' })).toBeVisible();
});

test('tells a first-time user what to do before scanning', async ({ page }) => {
  await openDvalinPanel(page);

  // No project is selected on a first run, so the panel must say so rather than
  // leaving a disabled button with no explanation.
  await expect(page.getByText('Select a project folder before starting a security run.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scan project' })).toBeDisabled();
});

test('separates scanning from remediation when no model is configured', async ({ page }) => {
  await openDvalinPanel(page);

  // Scanning is local and must stay available; only the agent-driven steps need
  // a provider, and they say so instead of failing at send time.
  await expect(page.getByText('Remediation and verification need a model', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fix selected findings' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Verify remediation' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Publish draft PR' })).toBeDisabled();
});

for (const theme of ['light', 'dark'] as const) {
  test(`keeps every Dvalin control readable in the ${theme} theme`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('dvalincode-theme', value), theme);
    await openDvalinPanel(page);

    // Regression guard for a whole class of bug, not one control: the UI was
    // authored dark-first, so in the light theme the panel's primary action sat
    // at 1.06:1 and the sidebar's "New security run" at 1.13:1 — both invisible.
    expect(await lowContrastText(page)).toEqual([]);
  });
}
