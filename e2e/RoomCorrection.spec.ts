/**
 * A room whose setup stops matching the room, driven the whole way through a real browser.
 *
 * The unit tests prove the engine allows what a director allowed and refuses everything else. What
 * they cannot prove is the part that actually decides whether a scorekeeper can use this at four in
 * the afternoon: that the route out is where the block happened, that the dialog swapping views
 * leaves focus somewhere sensible, and — the one that matters most — that a correction written
 * through the real store is still there after the tab dies.
 *
 * So this is one long test, for the reason `ManualGame.spec` is: the interesting failures are all at
 * the joins. A correction that applies in memory and does not survive a reload is a working feature
 * in every unit test and a lost game in the gym.
 */
import { expect, test, type Page } from '@playwright/test';
import { chooseScoringLayout } from './support/scoringLayout';

test.use({ viewport: { width: 1366, height: 768 } });

/** A practice game with one timeout per team and a four-tossup regulation. */
async function createGame(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Create game' }).click();
  await expect(page.getByRole('heading', { name: 'Create a game' })).toBeVisible();

  await page.getByLabel('Game label').fill('Correction practice');
  await page.getByLabel('Left team name').fill('Ninety Six');
  await page.getByLabel('Right team name').fill('Greenwood');
  await page.getByLabel('Ninety Six players').fill('Sarah\nJames');
  await page.getByLabel('Greenwood players').fill('Emma\nJordan');
  await page.getByLabel('Tossups in regulation').fill('4');
  await page.getByLabel('Players playing at once').fill('2');

  // The room-procedure options are behind their own disclosure, which is exactly where they belong:
  // a practice game does not need them, and this one does.
  await page.locator('summary#manual-options-heading').click();
  await page.getByLabel('Timeouts per team').fill('1');

  await page.getByRole('button', { name: 'Start game' }).click();
  await chooseScoringLayout(page);
}

/** Open a control wherever it lives — the footer, or the Game menu. */
async function openControl(page: Page, name: string): Promise<void> {
  const footer = page.getByRole('button', { name, exact: true });
  if ((await footer.count()) > 0 && (await footer.first().isVisible())) {
    await footer.first().click();
    return;
  }
  await page.getByRole('button', { name: 'Game', exact: true }).click();
  await page.getByRole('menuitem', { name }).click();
}

test('a director’s ruling and a corrected team name both survive the tab dying', async ({ page }) => {
  await page.goto('/');
  await createGame(page);

  // Both rosters fit on the floor, so nobody is asked who is starting.
  await expect(page.getByText('Tossup 1 of 4', { exact: true })).toBeVisible();

  // --- an ordinary game shows none of this ---------------------------------------------------

  await page.getByRole('button', { name: 'Game', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Game details' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Correct scoring rules/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // --- the room spends its only timeout ---------------------------------------------------------

  await openControl(page, 'Timeout');
  const timeoutDialog = page.getByRole('dialog', { name: 'Timeout' });
  await expect(timeoutDialog.getByRole('button', { name: /Allowed another one/ })).toHaveCount(0);
  await timeoutDialog.getByRole('button', { name: /Ninety Six/ }).click();
  await openControl(page, 'Resume play');

  // --- and the director allows a second one -----------------------------------------------------

  await openControl(page, 'Timeout');
  await page.getByRole('button', { name: /Allowed another one/ }).click();
  await page.getByRole('button', { name: 'We were told we could, this once' }).click();

  // The dialog swapped views, so focus has to land in the field this screen exists for.
  await expect(page.getByLabel('Why')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Record this ruling' })).toBeDisabled();
  await page.getByLabel('Why').fill('Director ruled the first timeout did not count');
  await page.getByRole('button', { name: 'Record this ruling' }).click();

  await openControl(page, 'Timeout');
  await expect(
    page.getByRole('dialog', { name: 'Timeout' }).getByRole('button', { name: /Ninety Six/ }),
  ).toBeEnabled();
  await page.keyboard.press('Escape');

  // --- and the bracket had the team name wrong --------------------------------------------------

  await openControl(page, 'Game details');
  const details = page.getByRole('dialog', { name: 'Game details' });
  await expect(details).toContainText('An extra timeout for Ninety Six');
  await details.getByRole('button', { name: 'Correct…' }).first().click();

  await expect(page.getByLabel('Team name')).toBeFocused();
  await page.getByLabel('Team name').fill('Ninety Six A');
  await page.getByRole('button', { name: 'Save' }).click();

  // The scoresheet comes back naming the corrected team, and says what happened rather than
  // claiming the game was recovered.
  await expect(page.getByText('Team name: Ninety Six → Ninety Six A')).toBeVisible();
  await expect(page.getByLabel('Ninety Six A score')).toBeVisible();

  // --- lose the tab -----------------------------------------------------------------------------

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unfinished game' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();

  await expect(page.getByLabel('Ninety Six A score')).toBeVisible();
  await openControl(page, 'Game details');
  const reopened = page.getByRole('dialog', { name: 'Game details' });
  await expect(reopened).toContainText('Ninety Six A');
  await expect(reopened).toContainText('Director ruled the first timeout did not count');
  await page.keyboard.press('Escape');

  // --- and the game still finishes and exports --------------------------------------------------

  // One converted tossup, so the round is decided rather than tied into overtime.
  await page.getByRole('button', { name: 'Sarah Correct', exact: true }).click();
  await page.getByLabel('Bonus').getByRole('button', { name: '30', exact: true }).click();
  for (let tossup = 2; tossup <= 4; tossup += 1) {
    await page.getByRole('button', { name: 'No buzz' }).click();
  }
  await page.getByLabel('Final score confirmed with both teams').check();
  await page.getByRole('button', { name: 'Submit result' }).click();
  await expect(page.getByRole('heading', { name: 'Final' })).toBeVisible();
});
