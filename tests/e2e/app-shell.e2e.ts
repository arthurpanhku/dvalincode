import { expect, test } from 'playwright/test';

test('loads the DvalinCode app shell', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'DvalinCode' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Home/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Code/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Dvalin/ })).toBeVisible();
});

test('attaches and removes an image in the composer', async ({ page }) => {
  await page.goto('/');
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
