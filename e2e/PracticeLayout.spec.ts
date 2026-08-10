import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1366, height: 768 } });

test('practice control row stays on the viewport bottom edge', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Practice scoring' }).click();

  await expect(page.getByRole('heading', { name: 'Who is starting?' })).toBeVisible();
  for (const player of ['Gibson', 'Jeremy', 'Owen', 'Lachlan', 'Tucker', 'Sam', 'Efren', 'Valerie']) {
    await page.getByLabel(player, { exact: true }).check();
  }
  // The minimized guide quotes the step it is on, and step 1 tells you to choose Start game, so
  // the accessible name has to match exactly to pick the scoresheet's own button out of the two.
  await page.getByRole('button', { name: 'Start game', exact: true }).click();

  const scorer = page.locator('.practice-mode > .scorer');
  const body = page.locator('.practice-mode > .scorer > .scorer-body');
  const footer = page.locator('.practice-mode > .scorer > .scorer-footer');
  await expect(footer).toBeVisible();

  expect(await scorer.evaluate((element) => getComputedStyle(element).paddingBottom)).toBe('0px');
  expect(await body.evaluate((element) => getComputedStyle(element).paddingBottom)).toBe('126px');

  const footerBox = await footer.boundingBox();
  expect(footerBox).not.toBeNull();
  expect(Math.abs((footerBox?.y ?? 0) + (footerBox?.height ?? 0) - 768)).toBeLessThanOrEqual(1);
});
