/**
 * The tournaments page as a browser receives it.
 *
 * Same three properties every page here is checked for: that it is served as HTML rather than
 * assembled by a script, that it is reachable rather than orphaned, and that its relative paths resolve
 * from two directories deep — a unit test can assert the `href` strings, but only a navigation proves
 * they land somewhere.
 *
 * The fourth is this page's own. Its workflow is four stages rather than three, and four side by side
 * is the widest sequence on the site, so the viewport loop is where a fourth stage overflowing would be
 * caught.
 */
import { expect, test, type Page } from '@playwright/test';

/** Whether the document fits its own viewport. A sideways scrollbar on a phone is a defect. */
async function fits(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
}

test('the tournaments page explains running QBSheet across rooms', async ({ page }) => {
  await page.goto('/about/tournaments/');

  await expect(page).toHaveTitle('QBSheet for tournaments | QBSheet');
  await expect(page.getByRole('heading', { level: 1, name: 'QBSheet for tournaments' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'QBSheet and tournament control' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'A connected round' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connection failures' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Requirements' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Scoring without a connection' })).toBeVisible();

  expect(await fits(page)).toBe(true);
});

test('the product page reaches it from the footer, and it comes back', async ({ page }) => {
  await page.goto('/about/');

  // The header carries the products; the content pages are reached from the footer navigation.
  const nav = page.getByRole('navigation', { name: 'Footer navigation' });
  await nav.getByRole('link', { name: 'Tournaments' }).click();
  await expect(page).toHaveURL(/\/about\/tournaments\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'QBSheet for tournaments' })).toBeVisible();

  // Back up one directory, not two. This catches a path written as though from `about/`.
  await page
    .getByRole('navigation', { name: 'Footer navigation' })
    .getByRole('link', { name: 'About' })
    .click();
  await expect(page).toHaveURL(/\/about\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'The simpler way to keep score.' })).toBeVisible();
});

test('it reaches its sibling pages sideways', async ({ page }) => {
  await page.goto('/about/tournaments/');

  await page.getByRole('link', { name: 'What scoring a game involves' }).click();
  await expect(page).toHaveURL(/\/about\/scoring\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Scoring with QBSheet' })).toBeVisible();
});

test('the scorer is two directories up', async ({ page }) => {
  await page.goto('/about/tournaments/');

  // `Scorer` is the header's way into the application, and from here it has to climb two directories.
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Scorer' })
    .click();
  await expect(page.getByRole('link', { name: 'About QBSheet' })).toBeVisible();
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the page is served as complete HTML', async ({ page }) => {
    await page.goto('/about/tournaments/');

    await expect(page.getByRole('heading', { level: 1, name: 'QBSheet for tournaments' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Pair' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Network loss during a round' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Read the specification' })).toHaveAttribute(
      'href',
      'https://github.com/gbyo/qbsheet/blob/main/docs/QBTCP.md',
    );
  });
});

for (const width of [1280, 900, 820, 768, 680, 390, 320]) {
  test(`the layout fits a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/about/tournaments/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    // Four stages, which is one more than the grid was first written for.
    await expect(page.locator('.about-stages > li')).toHaveCount(4);
    await expect(page.locator('.about-assurance-grid > article')).toHaveCount(4);
    expect(await fits(page)).toBe(true);
  });
}
