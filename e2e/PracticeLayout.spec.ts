import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1366, height: 768 } });

async function startPracticeGame(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Practice scoring' }).click();

  await expect(page.getByRole('heading', { name: 'Who is starting?' })).toBeVisible();
  const prompt = page.getByLabel('Starting lineups');
  const left = prompt.getByLabel('Ninety Six starters');
  const right = prompt.getByLabel('Greenwood starters');
  for (const player of ['Gibson', 'Jeremy', 'Owen', 'Lachlan']) {
    await left.getByRole('button', { name: `Start ${player}` }).click();
  }
  for (const player of ['Tucker', 'Phillip', 'Efren', 'Valerie']) {
    await right.getByRole('button', { name: `Start ${player}` }).click();
  }
  // The minimized guide quotes the step it is on, and step 1 tells you to choose Start game, so
  // the accessible name has to match exactly to pick the scoresheet's own button out of the two.
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
}

test('practice control row stays on the viewport bottom edge', async ({ page }) => {
  await startPracticeGame(page);

  const scorer = page.locator('.practice-mode > .scorer');
  const body = page.locator('.practice-mode > .scorer > .scorer-body');
  const footer = page.locator('.practice-mode > .scorer > .scorer-footer');
  await expect(footer).toBeVisible();

  // Practice reserves no strip and no column any more; the guide overlaps the empty right end of the
  // two bottom rows instead. Anything reserved here is what used to lift the contextual row clear of
  // the control bar.
  expect(await scorer.evaluate((element) => getComputedStyle(element).paddingBottom)).toBe('0px');
  expect(await body.evaluate((element) => getComputedStyle(element).paddingBottom)).toBe('0px');

  const footerBox = await footer.boundingBox();
  expect(footerBox).not.toBeNull();
  expect(Math.abs((footerBox?.y ?? 0) + (footerBox?.height ?? 0) - 768)).toBeLessThanOrEqual(1);
});

test('the contextual row sits directly on the control bar', async ({ page }) => {
  await startPracticeGame(page);

  const stage = page.locator('.practice-mode .scorer-stage');
  const footer = page.locator('.practice-mode > .scorer > .scorer-footer');
  await expect(stage).toBeVisible();
  await expect(page.getByRole('button', { name: 'No buzz' })).toBeVisible();

  expect(await stage.evaluate((element) => getComputedStyle(element).position)).toBe('sticky');

  const stageBox = await stage.boundingBox();
  const footerBox = await footer.boundingBox();
  expect(stageBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  // Flush: no gap between the bottom of the contextual row and the top of the control bar.
  expect(Math.abs((stageBox?.y ?? 0) + (stageBox?.height ?? 0) - (footerBox?.y ?? 0))).toBeLessThanOrEqual(1);
});

test('a completed game renders the review without live scorer chrome', async ({ page }) => {
  await startPracticeGame(page);

  await page.getByRole('button', { name: 'No buzz' }).click();
  await page.getByRole('button', { name: 'Game', exact: true }).click();
  await page.getByRole('menuitem', { name: 'End game early…' }).click();
  await page.getByLabel('Why is the game ending early?').fill('Layout test');
  await page.getByRole('button', { name: 'End the game now' }).click();

  const completion = page.locator('.scorer-completion');
  await expect(completion).toBeVisible();
  await expect(completion.locator('.scorer-complete-title')).toHaveText('Final score — game ended early');
  await expect(page.locator('.scorer-teams')).toHaveCount(0);
  await expect(page.locator('.scorer-stage')).toHaveCount(0);
  await expect(page.locator('.scorer-keymap')).toHaveCount(0);
  await expect(page.locator('.scorer-rail')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'No buzz' })).toHaveCount(0);
});

test('the guide is a wide panel that keeps clear of the contextual row controls', async ({ page }) => {
  await startPracticeGame(page);

  const coach = page.locator('.practice-coach');
  // 1366px is wider than the 1051px the guide opens itself at, so it is already showing.
  await expect(coach).toBeVisible();

  const coachBox = await coach.boundingBox();
  expect(coachBox).not.toBeNull();
  // Wider than it is tall is the whole point of the shape.
  expect(coachBox?.width ?? 0).toBeGreaterThan(coachBox?.height ?? 0);

  const noBuzzBox = await page.getByRole('button', { name: 'No buzz' }).boundingBox();
  expect(noBuzzBox).not.toBeNull();
  // Overlapping the empty end of the bottom rows is allowed; reaching their controls is not.
  expect(coachBox?.x ?? 0).toBeGreaterThan((noBuzzBox?.x ?? 0) + (noBuzzBox?.width ?? 0));
});

/**
 * A short screen is an ordinary tournament device, not an edge case.
 *
 * A 1366×600 or 1024×600 laptop lid is what a school hands a scorekeeper, and on one of those the
 * guide used to sit on top of the right-hand team's rulings — the exact controls the steps spend
 * their time telling somebody to press. The panel shortening is the fix; Minimize is a preference,
 * and a layout that depends on it is a layout that is wrong until somebody notices.
 */
for (const size of [
  { width: 1366, height: 600 },
  { width: 1024, height: 600 },
]) {
  test(`the guide keeps clear of the rulings on a ${size.width}×${size.height} screen`, async ({ page }) => {
    await page.setViewportSize(size);
    await startPracticeGame(page);

    // Below 1051px the guide opens minimized, which is a preference and not the clearance.
    const collapsed = page.locator('.practice-coach-collapsed');
    if (await collapsed.count()) await collapsed.click();

    const coach = page.locator('.practice-coach');
    await expect(coach).toBeVisible();

    const coachBox = await coach.boundingBox();
    const rulings = page.locator('.scorer-team').last().locator('.scorer-player').last().locator('.scorer-answers');
    const rulingsBox = await rulings.boundingBox();
    expect(coachBox).not.toBeNull();
    expect(rulingsBox).not.toBeNull();

    const overlapsHorizontally =
      (coachBox?.x ?? 0) < (rulingsBox?.x ?? 0) + (rulingsBox?.width ?? 0) &&
      (rulingsBox?.x ?? 0) < (coachBox?.x ?? 0) + (coachBox?.width ?? 0);
    if (overlapsHorizontally) {
      expect((rulingsBox?.y ?? 0) + (rulingsBox?.height ?? 0)).toBeLessThanOrEqual(coachBox?.y ?? 0);
    }

    // Shortened, not shrunk to nothing: the step it is on still has to be readable.
    expect(coachBox?.height ?? 0).toBeGreaterThanOrEqual(120);
  });
}

test('the phone guide stays above the control bar when a warning adds a row', async ({ page }) => {
  await startPracticeGame(page);
  await page.getByRole('button', { name: 'Minimize practice guide' }).click();
  await page.setViewportSize({ width: 390, height: 844 });

  const footer = page.locator('.practice-mode > .scorer > .scorer-footer');
  const collapsedCoach = page.locator('.practice-coach-collapsed');
  await expect(collapsedCoach).toBeVisible();
  const compactFooterHeight = await footer.evaluate((element) => element.getBoundingClientRect().height);

  // A converted tossup is unfinished until its bonus is recorded, which puts the real scorer warning
  // onto the footer's second grid row at phone width.
  await page.getByRole('button', { name: 'Gibson Power' }).click();
  await expect(page.locator('.scorer-footer-warning')).toHaveText('Question 1 is not finished.');
  await expect
    .poll(async () => footer.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(compactFooterHeight);

  const footerBox = await footer.boundingBox();
  const collapsedBox = await collapsedCoach.boundingBox();
  expect(footerBox).not.toBeNull();
  expect(collapsedBox).not.toBeNull();
  expect((collapsedBox?.y ?? 0) + (collapsedBox?.height ?? 0)).toBeLessThanOrEqual(footerBox?.y ?? 0);

  await collapsedCoach.click();
  const coach = page.locator('.practice-coach');
  await expect(coach).toBeVisible();
  const coachBox = await coach.boundingBox();
  expect(coachBox).not.toBeNull();
  expect((coachBox?.y ?? 0) + (coachBox?.height ?? 0)).toBeLessThanOrEqual(footerBox?.y ?? 0);
});
