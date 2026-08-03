import { expect, test, type Page } from 'playwright/test';

/**
 * The first run a new user actually sees: open Dvalin, let it discover engines,
 * and act. A broken service round-trip or an unreadable primary action both fail
 * here silently in manual testing, so they are asserted explicitly.
 */

async function openDvalinPanel(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /^Dvalin/ }).click();
  await expect(page.getByRole('heading', { name: 'Dvalin security workspace' })).toBeVisible();
}

/**
 * WCAG relative luminance of the panel text against its composited background.
 * Colors are resolved through a canvas because the theme tokens compute to
 * oklch(), which cannot be parsed as rgb() channels.
 */
async function contrastOfButton(page: Page, label: string): Promise<number> {
  return page.evaluate(name => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const toRGBA = (value: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    type RGB = { r: number; g: number; b: number };
    const over = (fg: { r: number; g: number; b: number; a: number }, bg: RGB): RGB => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
    });
    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const luminance = (c: RGB) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);

    const button = [...document.querySelectorAll('button')].find(el => el.textContent?.trim() === name);
    if (!button) throw new Error(`button "${name}" not found`);

    const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
    for (let node: Element | null = button; node; node = node.parentElement) {
      const color = toRGBA(getComputedStyle(node).backgroundColor);
      if (color.a > 0) layers.push(color);
    }
    let background: RGB = document.documentElement.classList.contains('light')
      ? { r: 255, g: 255, b: 255 }
      : { r: 10, g: 10, b: 10 };
    for (let i = layers.length - 1; i >= 0; i--) background = over(layers[i]!, background);

    const foreground = over(toRGBA(getComputedStyle(button).color), background);
    const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (lighter! + 0.05) / (darker! + 0.05);
  }, label);
}

test('discovers detection engines on the first Dvalin run', async ({ page }) => {
  await openDvalinPanel(page);

  // Proves the web → API round-trip: engines are reported by the server, not hardcoded.
  await expect(page.getByText('Detection engines')).toBeVisible();
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
  await expect(page.getByText('Remediation needs a model')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fix selected findings' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Verify remediation' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Publish draft PR' })).toBeDisabled();
});

for (const theme of ['light', 'dark'] as const) {
  test(`keeps the primary Dvalin action readable in the ${theme} theme`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('dvalincode-theme', value), theme);
    await openDvalinPanel(page);

    // Regression guard: the panel was authored dark-first, and in the light theme
    // this button rendered emerald-200 on an emerald tint at 1.06:1 — invisible.
    expect(await contrastOfButton(page, 'Scan project')).toBeGreaterThanOrEqual(4.5);
  });
}
