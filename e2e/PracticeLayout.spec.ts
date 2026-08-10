import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1366, height: 768 } });

async function startPracticeGame(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Practice scoring' }).click();

  await expect(page.getByRole('heading', { name: 'Who is starting?' })).toBeVisible();
  for (const player of ['Gibson', 'Jeremy', 'Owen', 'Lachlan', 'Tucker', 'Sam', 'Efren', 'Valerie']) {
    await page.getByLabel(player, { exact: true }).check();
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
