import { test, expect } from '@playwright/test';

test('Director opens on the operational overview', async ({ page }) => {
  await page.goto('/director.html');

  await expect(page).toHaveTitle('QBSheet Director');
  await expect(page.getByRole('heading', { level: 1, name: 'Spring Invitational' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Round 6 of 11' })).toBeVisible();
  await expect(page.getByText('One room needs attention')).toBeVisible();
});

test('Director navigation keeps the results inbox actionable', async ({ page }) => {
  await page.goto('/director.html');

  await page.getByRole('button', { name: /^Results/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Results inbox' })).toBeVisible();
  await expect(page.locator('.director-result-row')).toHaveCount(3);

  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.locator('.director-result-row')).toHaveCount(2);
  await expect(page.getByRole('status')).toContainText('Room 107 accepted.');
});
