import { expect, test } from 'playwright/test';

test('loads the DvalinCode app shell', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'DvalinCode' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cowork', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
});
