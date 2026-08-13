import { expect, test } from '@playwright/test';

test('the about page introduces QBSheet and links to the real product', async ({ page }) => {
  await page.goto('/about/');

  await expect(page).toHaveTitle('QBSheet | Quiz Bowl Scorekeeping');
  await expect(page.getByRole('heading', { level: 1, name: 'The simpler way to keep score.' })).toBeVisible();
  await expect(page.getByRole('img', { name: /QBSheet scoring a tied practice game/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Built for real tournament rooms' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Use it your way' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Not just for tournaments' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open and straightforward' })).toBeVisible();

  const openLinks = page.getByRole('link', { name: 'Open QBSheet' });
  await expect(openLinks).toHaveCount(3);
  await expect(openLinks.first()).toHaveAttribute('href', '../');
  await expect(page.getByRole('link', { name: 'View on GitHub' }).first()).toHaveAttribute(
    'href',
    'https://github.com/gbyo/qbsheet',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
});

test.describe('on a mobile screen', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the about page stays readable without horizontal overflow', async ({ page }) => {
    await page.goto('/about/');

    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
      true,
    );
  });
});

test('the scorer welcome screen offers a quiet path to About', async ({ page }) => {
  await page.goto('/');

  const aboutLink = page.getByRole('link', { name: 'About QBSheet' });
  await expect(aboutLink).toBeVisible();
  await expect(aboutLink).toHaveAttribute('href', 'about/');
});
