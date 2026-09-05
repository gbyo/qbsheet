import { expect, test } from '@playwright/test';

const homepageLogo = '.welcome-shell .shell-brand-logo';

test('homepage logo unlocks the rainbow secret after seven clicks', async ({ page }) => {
  await page.goto('/');
  const logo = page.locator(homepageLogo);
  await expect(logo).toBeVisible();

  for (let click = 0; click < 7; click += 1) await logo.click();

  await expect(page.getByRole('dialog', { name: 'You found it.' })).toBeVisible();
  await expect(logo).toHaveAttribute('data-home-rainbow', 'true');
  await expect(page.getByText(/Secrets discovered on this device/)).toBeVisible();
});

test('pressing and holding the homepage logo unlocks the same secret', async ({ page }) => {
  await page.goto('/');
  const logo = page.locator(homepageLogo);
  await expect(logo).toBeVisible();

  await logo.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
  });
  await expect(page.getByRole('dialog', { name: 'You found it.' })).toBeVisible();
  await expect(logo).toHaveAttribute('data-home-rainbow', 'true');
  await logo.dispatchEvent('pointerup', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
  });
});

test('moving off the homepage logo cancels a pending hold unlock', async ({ page }) => {
  await page.goto('/');
  const logo = page.locator(homepageLogo);
  await expect(logo).toBeVisible();

  const box = await logo.boundingBox();
  if (!box) throw new Error('Homepage logo has no bounding box');

  await logo.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  });
  await page.locator('body').dispatchEvent('pointermove', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: 1,
    clientY: 1,
  });

  await page.waitForTimeout(1000);
  await expect(page.getByRole('dialog', { name: 'You found it.' })).toHaveCount(0);
  await expect(logo).not.toHaveAttribute('data-home-rainbow', 'true');
});
