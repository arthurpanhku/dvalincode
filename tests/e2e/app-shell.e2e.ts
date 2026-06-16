import { expect, test } from 'playwright/test';

test('loads the DvalinCode app shell', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'DvalinCode' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Chat/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Cowork/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Code/ })).toBeVisible();
});
