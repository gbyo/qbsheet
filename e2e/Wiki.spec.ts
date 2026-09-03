/**
 * The wiki as a browser receives it.
 *
 * Three things live only here. That a wiki article is served as complete HTML, which matters more for
 * this section than any other: these pages are looked up by somebody with a problem, often from a
 * search engine, sometimes on a venue network that is barely working.
 *
 * That the relative paths resolve from three directories deep. `about/wiki/<page>/` is the deepest
 * document the site has, and a unit test can only assert the strings — a navigation proves they land.
 *
 * And that a cross-page anchor actually arrives at its section rather than at the top of a long page,
 * which needs a browser resolving a fragment against real heading identifiers.
 */
import { expect, test, type Page } from '@playwright/test';

/** Whether the document fits its own viewport. A sideways scrollbar on a phone is a defect. */
async function fits(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
}

test('the site navigation enters the wiki at its own front page', async ({ page }) => {
  await page.goto('/about/');

  // There is no index page above the articles. The wiki's `Home` is its front page, so that is what
  // the navigation entry has to reach — and a link to `about/wiki/` would be served by nothing.
  await page
    .getByRole('navigation', { name: 'Footer navigation' })
    .getByRole('link', { name: 'Wiki' })
    .click();
  await expect(page).toHaveURL(/\/about\/wiki\/home\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'QBSheet' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Wiki navigation' })
    .getByRole('link', { name: 'Start here' })
    .click();
  await expect(page).toHaveURL(/\/about\/wiki\/start-here\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Start here' })).toBeVisible();
  expect(await fits(page)).toBe(true);
});

test('a wiki page renders its synced content', async ({ page }) => {
  await page.goto('/about/wiki/troubleshooting/');

  await expect(page).toHaveTitle('Troubleshooting | QBSheet wiki');
  await expect(page.getByRole('heading', { level: 1, name: 'Troubleshooting' })).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'The browser will not save anything' }),
  ).toBeVisible();
  expect(await fits(page)).toBe(true);
});

test('the edit link points at the GitHub editor for that page', async ({ page }) => {
  await page.goto('/about/wiki/start-here/');

  const edit = page.getByRole('link', { name: /^Edit on GitHub/ });
  await expect(edit).toBeVisible();
  await expect(edit).toHaveAttribute('href', 'https://github.com/gbyo/qbsheet/wiki/Start-here/_edit');
  await expect(edit).toHaveAttribute('target', '_blank');
});

test('a cross-page anchor arrives at its section', async ({ page }) => {
  await page.goto('/about/wiki/start-here/');

  // Scoped to the article, because the contents rail also has a Troubleshooting link and that one
  // carries no fragment. The link under test is the one written inside the page's own prose.
  //
  // Written by an author against the anchor GitHub generated, so this is the assertion that the
  // identifiers this build emits agree with GitHub's.
  await page.locator('.about-wiki-prose').getByRole('link', { name: 'Troubleshooting' }).first().click();
  await expect(page).toHaveURL(/\/about\/wiki\/troubleshooting\/#the-browser-will-not-save-anything$/);
  const heading = page.locator('#the-browser-will-not-save-anything');
  await expect(heading).toBeVisible();
});

test('the site navigation resolves from three directories deep', async ({ page }) => {
  await page.goto('/about/wiki/start-here/');

  await page
    .getByRole('navigation', { name: 'Footer navigation' })
    .getByRole('link', { name: 'FAQ' })
    .click();
  await expect(page).toHaveURL(/\/about\/faq\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Frequently asked questions' })).toBeVisible();
});

test('the product pages resolve from three directories deep', async ({ page }) => {
  await page.goto('/about/wiki/start-here/');

  // An article is the deepest document on the site, so it is where a product link written against
  // the wrong depth fails first. Both of these are `../../` from here, not `../` and not the
  // deployment root.
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await nav.getByRole('link', { name: 'Director' }).click();
  await expect(page).toHaveURL(/\/about\/director\/$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Tournament control that stays with you.' }),
  ).toBeVisible();

  await page.goto('/about/wiki/start-here/');
  await nav.getByRole('link', { name: 'QBLive' }).click();
  await expect(page).toHaveURL(/\/about\/qblive\/$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Follow the tournament as it happens.' }),
  ).toBeVisible();
});

test('the scorer is three directories up from a wiki page', async ({ page }) => {
  await page.goto('/about/wiki/start-here/');

  // Three `../`, from the deepest document on the site. `Scorer` is the header's link into the
  // application and the one whose depth an article gets wrong first.
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Scorer' })
    .click();
  await expect(page.getByRole('link', { name: 'About QBSheet' })).toBeVisible();
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('a wiki page is served as complete HTML', async ({ page }) => {
    await page.goto('/about/wiki/qbtcp-for-implementers/');

    // The longest page in the wiki, with the tables and fenced blocks that a Markdown renderer is
    // most likely to have dropped.
    await expect(page.getByRole('heading', { level: 1, name: 'QBTCP for implementers' })).toBeVisible();
    await expect(page.locator('.about-wiki-prose table').first()).toBeVisible();
    await expect(page.locator('.about-wiki-prose pre').first()).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Wiki navigation' })).toBeVisible();
  });
});

for (const width of [1280, 900, 820, 768, 680, 390, 320]) {
  test(`the layout fits a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    // The page with the widest tables, which is where a documentation layout overflows if it will.
    await page.goto('/about/wiki/qbtcp-for-implementers/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Wiki navigation' })).toBeVisible();
    expect(await fits(page)).toBe(true);
  });
}
