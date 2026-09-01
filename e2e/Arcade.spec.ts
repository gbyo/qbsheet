/**
 * The arcade in a real browser, which is where most of its claims can actually be checked.
 *
 * jsdom has no canvas, no layout, no service worker and no network, so the unit suites can prove the
 * rules, the lifecycle and the keyboard isolation and nothing about whether the thing is playable.
 * This file covers the rest: that the board is drawn at a real size, that a real Space key flaps
 * without scrolling the dialog, that the whole arcade fits a phone, that dark mode reaches the
 * pixels, and — the one that matters for a school Chromebook — that nothing is fetched from off this
 * origin, ever.
 */
import { expect, test, type Page } from '@playwright/test';
import { chooseScoringLayout } from './support/scoringLayout';

/** Open the arcade the way Settings does, from the front door. */
async function openArcadeFromSettings(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('heading', { name: 'Arcade' })).toBeVisible();
  await settings.getByRole('button', { name: 'Play' }).click();
  await expect(settings).toBeHidden();
  await expect(page.getByRole('button', { name: /QBBird/ })).toBeVisible();
}

/** The board's painted size, and whether anything was actually painted on it. */
async function boardState(page: Page, label: RegExp) {
  return page.getByLabel(label).evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();
    const context = canvas.getContext('2d');
    const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
    // Whether more than one colour is present. A canvas that was never drawn on is uniform.
    let distinct = 0;
    let previous = -1;
    for (let index = 0; pixels && index < pixels.length; index += 4000) {
      const value = pixels[index] * 65536 + pixels[index + 1] * 256 + pixels[index + 2];
      if (value !== previous) distinct += 1;
      previous = value;
    }
    return {
      cssWidth: Math.round(box.width),
      cssHeight: Math.round(box.height),
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      distinct,
      // The average brightness, which is how the dark-mode assertion below tells the two apart.
      brightness:
        pixels === undefined
          ? 0
          : Array.from({ length: 200 }, (_unused, step) => pixels[step * 400] ?? 0).reduce(
              (total, value) => total + value,
              0,
            ) / 200,
    };
  });
}

/** A cheap fingerprint of what is currently painted, for telling one frame from another. */
async function boardSignature(page: Page, label: RegExp): Promise<string> {
  return page.getByLabel(label).evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (pixels === undefined) return '';
    let signature = '';
    for (let index = 0; index < pixels.length; index += 2003) signature += pixels[index].toString(36);
    return signature;
  });
}

test('the picker offers both games, and each one draws a real board', async ({ page }) => {
  await openArcadeFromSettings(page);

  const dialog = page.getByRole('dialog', { name: 'Arcade' });
  await expect(dialog.getByRole('button', { name: /QBBird/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Snake/ })).toBeVisible();

  await page.getByRole('button', { name: /QBBird/ }).click();
  await expect(page.getByRole('dialog', { name: 'QBBird' })).toBeVisible();

  const bird = await boardState(page, /QBBird play area/);
  expect(bird.cssWidth).toBeGreaterThan(120);
  expect(bird.cssHeight).toBeGreaterThan(160);
  // Sized for the display it is on rather than for CSS pixels, and drawn on.
  expect(bird.backingWidth).toBeGreaterThanOrEqual(bird.cssWidth);
  expect(bird.distinct).toBeGreaterThan(3);
  // The aspect ratio the physics is designed in, whatever the layout did. See `arcadeCanvas`.
  expect(bird.cssWidth / bird.cssHeight).toBeCloseTo(320 / 440, 1);

  await page.getByRole('button', { name: 'Back to Arcade' }).click();
  await page.getByRole('button', { name: /Snake/ }).click();

  const snake = await boardState(page, /Snake play area/);
  expect(snake.distinct).toBeGreaterThan(3);
  expect(snake.cssWidth / snake.cssHeight).toBeCloseTo(4 / 3, 1);
});

test('Space flaps the bird and does not scroll the dialog it is inside', async ({ page }) => {
  await openArcadeFromSettings(page);
  await page.getByRole('button', { name: /QBBird/ }).click();

  const board = page.getByLabel(/QBBird play area/);
  await board.click();
  await expect(board).toBeFocused();

  const scrollBefore = await page
    .getByRole('dialog', { name: 'QBBird' })
    .evaluate((element) => element.scrollTop);

  await page.keyboard.press('Space');
  // The game is running now, which the button says before any score does.
  await expect(page.getByRole('button', { name: 'Flap' })).toBeVisible();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');

  const scrollAfter = await page
    .getByRole('dialog', { name: 'QBBird' })
    .evaluate((element) => element.scrollTop);
  expect(scrollAfter).toBe(scrollBefore);

  // It is genuinely running: the board is not the same picture it was a moment ago.
  const first = await boardSignature(page, /QBBird play area/);
  await page.waitForTimeout(400);
  const second = await boardSignature(page, /QBBird play area/);
  expect(second).not.toBe(first);

  // And the score is readable as text, not only as pixels.
  await expect(page.locator('.arcade-score-label', { hasText: 'Score' })).toBeVisible();
});

test('the arcade fetches nothing from off this origin, and nothing at all once it is open', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173')) external.push(request.url());
  });

  await openArcadeFromSettings(page);

  /*
   * From here, nothing the arcade does may be a data request.
   *
   * Not "no requests at all": the first bold glyph a game draws can still pull one of the
   * application's own IBM Plex weights off this origin, and that file is an ordinary build asset the
   * service worker precaches like every other. What must never happen is the arcade *asking a server
   * for something* — a score, a level, a sprite — so the assertion is about the kind of request.
   */
  const dataRequests: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'fetch' || request.resourceType() === 'xhr') {
      dataRequests.push(request.url());
    }
  });

  await page.getByRole('button', { name: /QBBird/ }).click();
  await page.getByLabel(/QBBird play area/).click();
  await page.keyboard.press('Space');
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Back to Arcade' }).click();
  await page.getByRole('button', { name: /Snake/ }).click();
  await page.getByLabel(/Snake play area/).click();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(600);

  expect(external).toEqual([]);
  expect(dataRequests).toEqual([]);
});

test('a game reached from the scoresheet leaves the scoresheet exactly as it was', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create game' }).click();
  await page.getByLabel('Game label').fill('Arcade break');
  await page.getByLabel('Left team name').fill('Ninety Six');
  await page.getByLabel('Right team name').fill('Greenwood');
  await page.getByLabel('Ninety Six players').fill('Sarah\nJames');
  await page.getByLabel('Greenwood players').fill('Emma\nJordan');
  await page.getByLabel('Players playing at once').fill('2');
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await chooseScoringLayout(page);

  // Score one tossup, so there is something on the sheet that could be disturbed.
  await page.getByRole('button', { name: 'Sarah Correct', exact: true }).click();
  const sheet = page.locator('.scorer-teams').first();
  await expect(sheet).toBeVisible();
  // The scoresheet acknowledges a ruling for a few seconds. Let that clear before the snapshot, so
  // the comparison is between two settled sheets rather than between one mid-acknowledgement and one
  // after it timed out — which is a difference the arcade had nothing to do with.
  await expect(page.getByText('Sarah Correct recorded.')).toBeHidden();
  const before = await sheet.innerText();

  await page.getByRole('button', { name: 'Game' }).click();
  await page.getByRole('menuitem', { name: 'Take a break…' }).click();
  await page.getByRole('button', { name: /Snake/ }).click();
  const board = page.getByLabel(/Snake play area/);
  await board.click();
  await page.getByRole('button', { name: 'Start' }).click();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(700);
  await page.keyboard.press('Escape');

  await expect(page.getByRole('dialog', { name: 'Snake' })).toBeHidden();

  // The scoresheet is on screen and unchanged: the same totals, the same rosters, the same question.
  await expect(sheet).toBeVisible();
  expect(await sheet.innerText()).toBe(before);
});

test.describe('dark mode', () => {
  test('the board is drawn in the appearance the scorekeeper chose', async ({ page }) => {
    await openArcadeFromSettings(page);
    await page.getByRole('button', { name: /Snake/ }).click();
    const light = await boardState(page, /Snake play area/);

    await page.getByRole('button', { name: 'Back to Arcade' }).click();
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Settings' }).click();
    // The radio itself is `visually-hidden`; the label is what a person presses. See `ChoiceRow`.
    await page.getByRole('dialog', { name: 'Settings' }).getByText('Dark', { exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Play' }).click();
    await page.getByRole('button', { name: /Snake/ }).click();
    const dark = await boardState(page, /Snake play area/);

    // Not "a different colour somewhere" — the whole board is darker, which is the only thing that
    // would be true of a canvas actually reading the tokens rather than hard-coding them.
    expect(dark.brightness).toBeLessThan(light.brightness - 40);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test('the arcade fits the viewport and the controls stay reachable', async ({ page }) => {
    await openArcadeFromSettings(page);
    await page.getByRole('button', { name: /QBBird/ }).click();

    const dialog = page.getByRole('dialog', { name: 'QBBird' });
    const layout = await dialog.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    });
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(320);
    expect(layout.top).toBeGreaterThanOrEqual(0);
    expect(layout.bottom).toBeLessThanOrEqual(568);
    // No sideways scrollbar inside the dialog, which is what a board too wide for a phone produces.
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);

    const board = await boardState(page, /QBBird play area/);
    expect(board.cssWidth).toBeLessThanOrEqual(320);
    expect(board.cssWidth / board.cssHeight).toBeCloseTo(320 / 440, 1);

    // The way out and the way to play are both on screen without scrolling for them.
    await expect(page.getByRole('button', { name: 'Start' })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Back to Arcade' })).toBeInViewport();
  });
});
