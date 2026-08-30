/**
 * The scoring page as a browser receives it.
 *
 * Served as HTML rather than assembled by a script, reachable rather than orphaned, and resolving from
 * two directories deep — the same three properties every page here is checked for, and none of them
 * visible to a unit test.
 */
import { expect, test, type Page } from '@playwright/test';

/** Whether the document fits its own viewport. A sideways scrollbar on a phone is a defect. */
async function fits(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
}

test('the scoring page explains the job to somebody who has not done it', async ({ page }) => {
  await page.goto('/about/scoring/');

  await expect(page).toHaveTitle('Scoring with QBSheet | QBSheet');
  await expect(page.getByRole('heading', { level: 1, name: 'Scoring with QBSheet' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Scoring a tossup' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Corrections and recovery' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Guided practice' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Finishing a game' })).toBeVisible();

  expect(await fits(page)).toBe(true);
});

test('the product page reaches it from the header, and it comes back', async ({ page }) => {
  await page.goto('/about/');

  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Scoring' })
    .click();
  await expect(page).toHaveURL(/\/about\/scoring\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Scoring with QBSheet' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Footer navigation' })
    .getByRole('link', { name: 'About' })
    .click();
  await expect(page).toHaveURL(/\/about\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'The simpler way to keep score.' })).toBeVisible();
});

test('the practice call to action opens the scorer', async ({ page }) => {
  await page.goto('/about/scoring/');

  // Two directories up, and the assertion is that it lands on the real application rather than a 404.
  await page.getByRole('link', { name: 'Open the practice game' }).click();
  await expect(page.getByRole('link', { name: 'About QBSheet' })).toBeVisible();
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the page is served as complete HTML', async ({ page }) => {
    await page.goto('/about/scoring/');

    await expect(page.getByRole('heading', { level: 1, name: 'Scoring with QBSheet' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Record the answer' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Local recovery' })).toBeVisible();
    // The keyboard bindings are the part somebody would actually come back to read.
    await expect(page.getByText('Ctrl/⌘ + Shift + Z', { exact: true })).toBeVisible();
  });
});

for (const width of [1280, 900, 820, 768, 680, 390, 320]) {
  test(`the layout fits a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/about/scoring/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    await expect(page.locator('.about-stages > li')).toHaveCount(3);
    await expect(page.locator('.about-assurance-grid > article')).toHaveCount(4);
    // The key names are set `nowrap`, so this is the width at which they would push the page sideways.
    expect(await fits(page)).toBe(true);
  });
}
