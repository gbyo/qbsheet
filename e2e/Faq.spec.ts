/**
 * The questions page as a browser receives it.
 *
 * This page is the one most likely to be read by somebody who arrived from a search engine rather than
 * from the product page, so being served as complete HTML matters more here than anywhere: a reader who
 * lands on a question and gets a blank page has been failed at the only moment they were asking.
 *
 * It is also the longest document on the site, which makes the viewport loop the place a sixteen-row
 * definition list would be caught pushing the layout sideways.
 */
import { expect, test, type Page } from '@playwright/test';

/** Whether the document fits its own viewport. A sideways scrollbar on a phone is a defect. */
async function fits(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
}

test('the questions page answers the four groups', async ({ page }) => {
  await page.goto('/about/faq/');

  await expect(page).toHaveTitle('Frequently asked questions | QBSheet');
  await expect(page.getByRole('heading', { level: 1, name: 'Frequently asked questions' })).toBeVisible();
  for (const heading of [
    'Devices and browsers',
    'Formats and scoring',
    'Files and storage',
    'Licensing and support',
  ]) {
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }

  expect(await fits(page)).toBe(true);
});

test('the product page reaches it from the footer, and it comes back', async ({ page }) => {
  await page.goto('/about/');

  // The header carries the products — scorer, director, live. Every content page, this one included,
  // hangs off the footer navigation, so that is the route a reader actually has to it.
  await page
    .getByRole('navigation', { name: 'Footer navigation' })
    .getByRole('link', { name: 'FAQ' })
    .click();
  await expect(page).toHaveURL(/\/about\/faq\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Frequently asked questions' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Footer navigation' })
    .getByRole('link', { name: 'About' })
    .click();
  await expect(page).toHaveURL(/\/about\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'The simpler way to keep score.' })).toBeVisible();
});

test('an answer can send the reader to the page that expands it', async ({ page }) => {
  await page.goto('/about/faq/');

  await page.getByRole('link', { name: 'What is stored and transmitted' }).click();
  await expect(page).toHaveURL(/\/about\/privacy\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the page is served as complete HTML', async ({ page }) => {
    await page.goto('/about/faq/');

    await expect(page.getByRole('heading', { level: 1, name: 'Frequently asked questions' })).toBeVisible();
    // A search engine sends people to one answer, so the answers themselves have to be in the markup.
    await expect(page.getByText('Does QBSheet support our format?')).toBeVisible();
    await expect(page.getByText(/QBSheet defines no format of its own/)).toBeVisible();
    await expect(page.getByText(/Nothing\. QBSheet is free software under the GNU AGPL/)).toBeVisible();
  });
});

for (const width of [1280, 900, 820, 768, 680, 390, 320]) {
  test(`the layout fits a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/about/faq/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    await expect(page.locator('.about-faq-list > div')).toHaveCount(16);
    expect(await fits(page)).toBe(true);
  });
}
