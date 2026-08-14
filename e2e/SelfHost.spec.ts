/**
 * The self-hosting page as a browser receives it, which is where three of its properties live.
 *
 * That it is served as HTML rather than assembled by a script, same as the product page and for the
 * same reason. That it is reachable from the product page at all, because a page nothing links to is
 * a page nobody reads. And that its relative paths are written from two directories deep: the unit
 * test can assert the `href` strings, but only a real navigation proves they resolve.
 */
import { expect, test, type Page } from '@playwright/test';

/** Whether the document fits its own viewport. A sideways scrollbar on a phone is a defect. */
async function fits(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

test('the self-hosting page explains what hosting QBSheet involves', async ({ page }) => {
  await page.goto('/about/self-host/');

  await expect(page).toHaveTitle('Host QBSheet yourself | QBSheet');
  await expect(page.getByRole('heading', { level: 1, name: 'Host QBSheet yourself' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Three steps, and then the same three steps again' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What you don’t have to run' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Somewhere to put it' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Serve it over HTTPS' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready to host it?' })).toBeVisible();

  expect(await fits(page)).toBe(true);
});

test('the product page links to it from the header', async ({ page }) => {
  await page.goto('/about/');

  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Self-host' }).click();
  await expect(page).toHaveURL(/\/about\/self-host\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Host QBSheet yourself' })).toBeVisible();
});

test('the product page links to it and it links back', async ({ page }) => {
  await page.goto('/about/');

  await page.getByRole('link', { name: 'Read the self-hosting guide' }).click();
  await expect(page).toHaveURL(/\/about\/self-host\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Host QBSheet yourself' })).toBeVisible();

  // Back up one directory, not two. This is the assertion that catches a path written from `about/`.
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'About' }).click();
  await expect(page).toHaveURL(/\/about\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'The simpler way to keep score.' })).toBeVisible();
});

test('the scorer is two directories up from the self-hosting page', async ({ page }) => {
  await page.goto('/about/self-host/');

  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Open QBSheet' }).click();
  await expect(page.getByRole('link', { name: 'About QBSheet' })).toBeVisible();
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the page is served as complete HTML', async ({ page }) => {
    await page.goto('/about/self-host/');

    // Every section, from a document that ran no script.
    await expect(page.getByRole('heading', { level: 1, name: 'Host QBSheet yourself' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Build' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What you don’t have to run' })).toBeVisible();
    await expect(page.getByText('browsers only install one on a secure origin')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Read the license' })).toHaveAttribute(
      'href',
      'https://github.com/gbyo/qbsheet/blob/main/LICENSE',
    );
  });
});

for (const width of [1280, 900, 820, 768, 680, 390, 320]) {
  test(`the layout fits a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/about/self-host/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('.about-stages > li')).toHaveCount(3);
    await expect(page.locator('.about-assurance-grid > article')).toHaveCount(4);
    // The commands are set `nowrap`, so this is the width at which that would push the page sideways.
    expect(await fits(page)).toBe(true);
  });
}
