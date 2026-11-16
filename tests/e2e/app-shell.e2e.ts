import { expect, test } from 'playwright/test';
import { E2E_TOKEN, appUrl } from './token';

test('loads the DvalinCode app shell', async ({ page }) => {
  await page.goto(appUrl);

  await expect(page.getByRole('heading', { name: 'DvalinCode' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Chat/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Code/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Dvalin/ })).toBeVisible();
  // The token is traded for a cookie and does not linger in the address bar.
  await expect(page).toHaveURL(/\/$/);
});

test('asks for the access token when the link has none', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Access token required' })).toBeVisible();

  await page.getByRole('textbox', { name: 'Access token' }).fill('not-the-token-0123456789');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toContainText('does not match');

  // Pasting the whole launch link works as well as the bare token.
  await page.getByRole('textbox', { name: 'Access token' }).fill(`http://localhost:3921/?token=${E2E_TOKEN}`);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('heading', { name: 'DvalinCode' })).toBeVisible();
});

test('attaches and removes an image in the composer', async ({ page }) => {
  await page.goto(appUrl);
  await page.getByRole('button', { name: 'Add files and commands' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach images' }).click();
  await (await chooser).setFiles({
    name: 'diagram.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHBsAAAAASUVORK5CYII=', 'base64'),
  });
  const remove = page.getByRole('button', { name: 'Remove diagram.png' });
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(remove).toHaveCount(0);
});
