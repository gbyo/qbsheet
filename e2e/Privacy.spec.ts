/**
 * The privacy page as a browser receives it.
 *
 * The usual three properties, plus one this page cares about more than the others do. A privacy page
 * is a URL somebody forwards to a school or a district, and the person who opens it is the least
 * likely of any reader here to be running the kind of browser the site was developed against. Being
 * served as complete HTML — including the disclosure section rather than only the absences — is the
 * whole of that guarantee.
 *
 * The page is reached from the footer rather than the header, so that is the navigation tested.
 */
import { expect, test, type Page } from '@playwright/test';

/** Whether the document fits its own viewport. A sideways scrollbar on a phone is a defect. */
async function fits(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

test('the privacy page describes what QBSheet does with data', async ({ page }) => {
  await page.goto('/about/privacy/');

  await expect(page).toHaveTitle('Privacy | QBSheet');
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Data not collected' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Data stored on the device' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Data sent by a connected room' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Requests to the web server' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verifying this page' })).toBeVisible();

  expect(await fits(page)).toBe(true);
});

test('the footer reaches it from the product page, and it comes back', async ({ page }) => {
  await page.goto('/about/');

  const footer = page.getByRole('navigation', { name: 'Footer navigation' });
  await footer.getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveURL(/\/about\/privacy\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Footer navigation' }).getByRole('link', { name: 'About' }).click();
  await expect(page).toHaveURL(/\/about\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'The simpler way to keep score.' })).toBeVisible();
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the page is served as complete HTML, disclosure included', async ({ page }) => {
    await page.goto('/about/privacy/');

    await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'No analytics' })).toBeVisible();
    // The two things that are sent, which is the half of the page it would be easier to omit.
    await expect(page.getByText(/scorekeeper's name/)).toBeVisible();
    await expect(page.getByText(/an opaque per-device identifier/)).toBeVisible();
    // And the sentence that keeps the hosting claim honest.
    await expect(page.getByText(/web servers commonly log requests/)).toBeVisible();
  });
});

for (const width of [1280, 900, 820, 768, 680, 390, 320]) {
  test(`the layout fits a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/about/privacy/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    await expect(page.locator('.about-assurance-grid > article')).toHaveCount(4);
    expect(await fits(page)).toBe(true);
  });
}
