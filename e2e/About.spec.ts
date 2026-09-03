/**
 * The product page as a browser actually receives it.
 *
 * Three properties here cannot be checked anywhere else. That the page is served as HTML rather than
 * assembled by a script, which is the whole point of prerendering it and is invisible to a unit test.
 * That a reader who asked for less movement is given the finished composition immediately rather than a
 * page of invisible blocks. And that nothing overflows sideways at the widths the layout changes at,
 * which is a property of the real stylesheet and of nothing else.
 */
import { expect, test, type Page } from '@playwright/test';

/** Whether the document fits its own viewport. A sideways scrollbar on a phone is a defect. */
async function fits(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
}

test('the about page introduces QBSheet and links to the real product', async ({ page }) => {
  await page.goto('/about/');

  await expect(page).toHaveTitle('QBSheet | Quiz Bowl Scorekeeping');
  await expect(page.getByRole('heading', { level: 1, name: 'The simpler way to keep score.' })).toBeVisible();
  await expect(page.getByRole('img', { name: /QBSheet scoring a tied practice game/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Built around how you actually score' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Made for tournament day' })).toBeVisible();
  await expect(page.getByRole('heading', { name: "Your games aren't locked into QBSheet." })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready to score?' })).toBeVisible();

  const openLinks = page.getByRole('link', { name: 'Open QBSheet' });
  await expect(openLinks).toHaveCount(2);
  await expect(openLinks.first()).toHaveAttribute('href', '../');
  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(primaryNavigation.getByRole('link')).toHaveCount(4);
  await expect(primaryNavigation.getByRole('link', { name: 'Scorer' })).toHaveAttribute('href', '../');
  // Both product entries are pages on this site. Director is not deployed here at all, and QBLive
  // is served from somebody else's origin, so the navigation offers the pages that explain them
  // rather than jumping at an application this deployment does not contain.
  await expect(primaryNavigation.getByRole('link', { name: 'Director' })).toHaveAttribute(
    'href',
    './director/',
  );
  await expect(primaryNavigation.getByRole('link', { name: 'QBLive' })).toHaveAttribute('href', './qblive/');
  await expect(page.getByRole('link', { name: 'View on GitHub' }).first()).toHaveAttribute(
    'href',
    'https://github.com/gbyo/qbsheet',
  );
  expect(await fits(page)).toBe(true);
});

test('the about page introduces the product family and routes to both pages', async ({ page }) => {
  await page.goto('/about/');

  await expect(page.getByRole('heading', { name: 'Three parts of a tournament day.' })).toBeVisible();
  await page.getByRole('link', { name: 'About Director' }).click();
  await expect(page).toHaveURL(/\/about\/director\/$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Tournament control that stays with you.' }),
  ).toBeVisible();

  await page.goto('/about/');
  await page.getByRole('link', { name: 'About QBLive' }).click();
  await expect(page).toHaveURL(/\/about\/qblive\/$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Follow the tournament as it happens.' }),
  ).toBeVisible();
});

test('the workflow reads as three ordered stages once it has been scrolled to', async ({ page }) => {
  await page.goto('/about/');

  const stages = page.locator('.about-stages > li');
  await expect(stages).toHaveCount(3);
  await stages.first().scrollIntoViewIfNeeded();

  // The reveal is one-time and driven by an IntersectionObserver, so the assertion is that the stages
  // end up visible — not that they were hidden at some particular moment.
  for (const [index, idea] of [
    'Start with a game.',
    'Score the game.',
    'Keep the finished result.',
  ].entries()) {
    await expect(stages.nth(index).getByText(idea)).toBeVisible();
  }
  await expect(page.locator('.about-stages')).not.toHaveAttribute('data-reveal', 'pending');
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the page is served as complete HTML', async ({ page }) => {
    await page.goto('/about/');

    // Every section, from a document that ran no script. This is what prerendering buys and it is the
    // assertion that fails the moment somebody puts the page back behind a client-side mount.
    await expect(
      page.getByRole('heading', { level: 1, name: 'The simpler way to keep score.' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Built around how you actually score' })).toBeVisible();
    await expect(page.getByText('Start with a game.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Made for tournament day' })).toBeVisible();
    await expect(page.getByRole('heading', { name: "Your games aren't locked into QBSheet." })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Read the protocol overview' })).toHaveAttribute(
      'href',
      'https://github.com/gbyo/qbsheet/blob/main/docs/QBTCP.md',
    );

    // The largest paint is in the markup, where the preload scanner finds it before any script runs.
    await expect(page.getByRole('img', { name: /QBSheet scoring a tied practice game/ })).toBeVisible();
  });
});

test.describe('with reduced motion', () => {
  test('nothing is hidden and nothing is animated', async ({ page }) => {
    // Emulated explicitly rather than through `test.use({ reducedMotion })`, which does not reach the
    // page under this project's context options. It has to be set before the navigation, because the
    // question is what `reveal.ts` decides as the document loads.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/about/');

    // No block is ever marked pending, so there is no state in which the page is incomplete.
    await expect(page.locator('[data-reveal]')).toHaveCount(0);

    for (const heading of ['Built around how you actually score', 'Made for tournament day']) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
    await expect(page.getByText('Keep the finished result.')).toBeVisible();

    // The hero's entrance and the workflow's rules are both inside `prefers-reduced-motion:
    // no-preference`, so this device is given the finished composition with no transform on it.
    expect(
      await page.evaluate(() => {
        const heading = document.querySelector('#about-title');
        const rule = document.querySelector('.about-stages > li');
        return {
          heading: heading === null ? null : getComputedStyle(heading).animationName,
          opacity: heading === null ? null : getComputedStyle(heading).opacity,
          rule: rule === null ? null : getComputedStyle(rule, '::before').transform,
        };
      }),
    ).toEqual({ heading: 'none', opacity: '1', rule: 'none' });
  });
});

for (const width of [1280, 900, 820, 768, 680, 390, 320]) {
  test(`the layout fits a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/about/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    // Both new grids have to collapse rather than push the document sideways.
    await expect(page.locator('.about-stages > li')).toHaveCount(3);
    await expect(page.locator('.about-assurance-grid > article')).toHaveCount(4);
    expect(await fits(page)).toBe(true);
  });
}

test('the scorer welcome screen offers a quiet path to About', async ({ page }) => {
  await page.goto('/');

  const aboutLink = page.getByRole('link', { name: 'About QBSheet' });
  await expect(aboutLink).toBeVisible();
  await expect(aboutLink).toHaveAttribute('href', 'about/');
});

/**
 * The two product pages, as a browser receives them.
 *
 * The property that matters most is the negative one, and it can only be checked here: the deployed
 * website has no Director application on it. `/director.html` was a real URL in the previous build,
 * and a reader who bookmarked it or found it in a search result must now get a 404 from the static
 * host rather than a tournament-control screen that cannot run a tournament.
 */
test.describe('the product pages', () => {
  test('the Director page explains a desktop application and never offers to open one', async ({ page }) => {
    await page.goto('/about/director/');

    await expect(page).toHaveTitle('QBSheet Director | QBSheet');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Tournament control that stays with you.' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Director is a desktop application.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Set up, run, collect, publish' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Local control, by design' })).toBeVisible();
    await expect(page.locator('.about-stages > li')).toHaveCount(4);

    const download = page.getByRole('link', { name: /^Download Director/ });
    await expect(download).toHaveCount(2);
    await expect(download.first()).toHaveAttribute('href', 'https://github.com/gbyo/qbsheet/releases');
    await expect(page.getByRole('link', { name: /Open Director/ })).toHaveCount(0);

    const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
    await expect(primaryNavigation.getByRole('link', { name: 'Director' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(primaryNavigation.getByRole('link', { name: 'Scorer' })).toHaveAttribute('href', '../../');
    expect(await fits(page)).toBe(true);
  });

  test('the QBLive page explains the public view and opens the real application', async ({ page }) => {
    await page.goto('/about/qblive/');

    await expect(page).toHaveTitle('QBLive | QBSheet');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Follow the tournament as it happens.' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Where QBLive fits' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Five screens, one tournament' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Public, and careful about it' })).toBeVisible();

    const open = page.getByRole('link', { name: /^Open QBLive/ });
    await expect(open).toHaveCount(2);
    for (const attribute of [
      ['href', 'https://live.qbsheet.com/'],
      ['target', '_blank'],
      ['rel', 'noopener noreferrer'],
    ] as const) {
      await expect(open.first()).toHaveAttribute(attribute[0], attribute[1]);
    }

    const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
    await expect(primaryNavigation.getByRole('link', { name: 'QBLive' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(primaryNavigation.getByRole('link', { name: 'Director' })).toHaveAttribute(
      'href',
      '../director/',
    );
    expect(await fits(page)).toBe(true);
  });

  test.describe('without JavaScript', () => {
    test.use({ javaScriptEnabled: false });

    test('both pages are served as complete HTML', async ({ page }) => {
      await page.goto('/about/director/');
      await expect(page.getByRole('heading', { name: 'Director is a desktop application.' })).toBeVisible();
      await expect(page.getByText('Plan the tournament.')).toBeVisible();

      await page.goto('/about/qblive/');
      await expect(page.getByRole('heading', { name: 'Where QBLive fits' })).toBeVisible();
      await expect(page.getByText('Read-only, and unauthenticated')).toBeVisible();
    });
  });

  for (const path of ['/about/director/', '/about/qblive/']) {
    for (const width of [1280, 900, 820, 768, 390, 320]) {
      test(`${path} fits a ${width}px viewport`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);

        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
        expect(await fits(page)).toBe(true);
      });
    }
  }
});
