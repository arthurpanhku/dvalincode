import { expect, test } from 'playwright/test';

test('loads the DvalinCode app shell', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'DvalinCode' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Home/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Code/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Dvalin/ })).toBeVisible();
});
