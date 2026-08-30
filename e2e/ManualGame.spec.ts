/**
 * A practice game, created and scored in a real browser.
 *
 * This is the workflow the feature exists for, driven the whole way through in one test: type two
 * teams and their rules into the front door, pick starters, score, lose the tab mid-game, come back,
 * finish, and leave — without ever touching a file, a server, or a tournament.
 *
 * The reason it is one long test rather than several short ones is that the interesting failures are
 * all at the joins. A manual definition that scores correctly but does not survive a reload, or
 * survives a reload but will not let the room off the completion screen, is a working feature in
 * every unit test and a broken one in the gym.
 */
import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1366, height: 768 } });

const leftRoster = ['Sarah', 'James', 'Alex', 'Chris', 'Robin'];
const rightRoster = ['Emma', 'Jordan'];

async function fillSetupForm(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Create game' }).click();
  await expect(page.getByRole('heading', { name: 'Create a game' })).toBeVisible();

  await page.getByLabel('Game label').fill(label);
  await page.getByLabel('Left team name').fill('Ninety Six');
  await page.getByLabel('Right team name').fill('Greenwood');
  await page.getByLabel('Ninety Six players').fill(leftRoster.join('\n'));
  await page.getByLabel('Greenwood players').fill(rightRoster.join('\n'));

  // Two non-default rules: a power that does not exist by default, and a short regulation so the
  // game can actually be played out. Both have to be visible in the scorer afterwards.
  await page.getByLabel('Power (blank for none)').fill('15');
  await page.getByLabel('Tossups in regulation').fill('4');
  await page.getByLabel('Players playing at once').fill('4');
}

async function chooseStarters(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Who is starting?' })).toBeVisible();
  const prompt = page.getByLabel('Starting lineups');
  const left = prompt.getByLabel('Ninety Six starters');
  for (const player of ['Sarah', 'James', 'Alex', 'Chris']) {
    await left.getByRole('button', { name: `Start ${player}` }).click();
  }
  // Greenwood has two players and a floor of four, so it was settled without being asked.
  await expect(prompt.getByLabel('Greenwood starters')).toContainText('Lineup set automatically');
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
}

/**
 * Rule a tossup for one player.
 *
 * By the ruling's own name rather than its short label — the accessible name is "Sarah Power", which
 * is also the assertion that the answer type the form created came through with a label on it.
 */
async function scorePlayer(page: Page, playerName: string, ruling: string): Promise<void> {
  await page.getByRole('button', { name: `${playerName} ${ruling}`, exact: true }).click();
}

test('a practice game is created, scored, reloaded, finished and kept', async ({ page }) => {
  await page.goto('/');

  await fillSetupForm(page, 'Tuesday practice');
  await page.getByRole('button', { name: 'Start game' }).click();

  await chooseStarters(page);

  // The entered regulation length is the one being played.
  await expect(page.getByText('Tossup 1 of 4', { exact: true })).toBeVisible();

  // A power exists because it was typed in, and is worth what was typed in.
  await scorePlayer(page, 'Sarah', 'Power');
  await page.getByLabel('Bonus').getByRole('button', { name: '30', exact: true }).click();
  await expect(page.getByLabel('Ninety Six score')).toHaveText('45');
  await expect(page.getByText('Tossup 2 of 4', { exact: true })).toBeVisible();

  // Lose the tab mid-game. Nothing about this game came from a file or a server, so this is the only
  // copy there is.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unfinished game' })).toBeVisible();
  await expect(page.getByText('Ninety Six vs Greenwood')).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();

  // The score, the rules and the position in the game all came back.
  await expect(page.getByLabel('Ninety Six score')).toHaveText('45');
  await expect(page.getByText('Tossup 2 of 4', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sarah Power', exact: true })).toBeVisible();

  for (let tossup = 2; tossup <= 4; tossup += 1) {
    await page.getByRole('button', { name: 'No buzz' }).click();
  }

  await expect(page.getByLabel('Final score confirmed with both teams')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy game for tournament spreadsheet' })).toBeVisible();
  await page.getByRole('button', { name: 'Copy game for tournament spreadsheet' }).click();
  await expect(page.locator('.scorer-spreadsheet-copy')).toContainText('NEW BLANK TAB');
  await expect(page.locator('.scorer-spreadsheet-copy')).toContainText('A1');
  await page.getByLabel('Final score confirmed with both teams').check();
  await page.getByRole('button', { name: 'Submit result' }).click();

  await expect(page.getByRole('heading', { name: 'Final' })).toBeVisible();
  await expect(page.locator('.final-row').first()).toContainText('45');
  await expect(page.locator('.final-row').nth(1)).toContainText('0');

  // Nobody is waiting for this file, so nothing is demanded before the screen can be left. The
  // optional exports stay out of the way until somebody asks for them.
  const copy = page.locator('details.final-copy-details');
  await expect(copy).toBeVisible();
  await expect(copy.locator('summary')).toHaveText('Download or export a copy');
  await expect(copy).not.toHaveAttribute('open', '');
  await expect(copy.getByRole('button', { name: 'Download QBJ copy' })).toBeHidden();
  await copy.locator('summary').click();
  await expect(copy).toHaveAttribute('open', '');
  await expect(copy).toContainText('This result is saved on this device.');
  await expect(copy.getByRole('button', { name: 'Download QBJ copy' })).toBeVisible();
  await expect(copy.getByRole('button', { name: 'Download Excel scoresheet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'I uploaded the result' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Done' })).toBeEnabled();

  // A finished result must remain editable. Return to the scorer, verify the completed review is
  // still the active presentation, then submit it again so the original exit path remains covered.
  await page.getByRole('button', { name: 'Back to scorekeeper' }).click();
  await expect(page.locator('.scorer-completion')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Full scoresheet review' })).toBeVisible();
  await page.getByLabel('Final score confirmed with both teams').check();
  await page.getByRole('button', { name: 'Submit result' }).click();
  await expect(page.getByRole('heading', { name: 'Final' })).toBeVisible();

  await page.getByRole('button', { name: 'Done' }).click();

  await expect(page.getByRole('heading', { name: 'Start scoring' })).toBeVisible();
  const recent = page
    .locator('.shell-section')
    .filter({ has: page.getByRole('heading', { name: 'Recent' }) });
  await expect(recent).toContainText('Tuesday practice');
  await expect(recent).toContainText('Ninety Six');
});

test('a second practice between the same two teams is a second game', async ({ page }) => {
  await page.goto('/');

  await fillSetupForm(page, 'First practice');
  await page.getByRole('button', { name: 'Start game' }).click();
  await chooseStarters(page);
  await scorePlayer(page, 'Sarah', 'Power');
  await page.getByLabel('Bonus').getByRole('button', { name: '30', exact: true }).click();
  await expect(page.getByLabel('Ninety Six score')).toHaveText('45');

  for (let tossup = 2; tossup <= 4; tossup += 1) {
    await page.getByRole('button', { name: 'No buzz' }).click();
  }
  await page.getByLabel('Final score confirmed with both teams').check();
  await page.getByRole('button', { name: 'Submit result' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'Start scoring' })).toBeVisible();

  // The same teams, the same rules, the same afternoon. This is a different game.
  await fillSetupForm(page, 'Second practice');
  await page.getByRole('button', { name: 'Start game' }).click();

  // Not offered as a resume, and not stopped as an already-completed game.
  await expect(page.getByText('This game is already saved on this device.')).toHaveCount(0);
  await expect(page.getByText('This game has already been completed on this device.')).toHaveCount(0);

  await chooseStarters(page);
  await expect(page.getByLabel('Ninety Six score')).toHaveText('0');
  await expect(page.getByText('Tossup 1 of 4', { exact: true })).toBeVisible();

  // And the first one is still on the device, untouched.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unfinished game' })).toBeVisible();
  const recent = page
    .locator('.shell-section')
    .filter({ has: page.getByRole('heading', { name: 'Recent' }) });
  await expect(recent).toContainText('First practice');
});

/**
 * A refused submission, and whether anybody can read the refusal.
 *
 * Start game is always pressable, and a form that will not start says why next to the fields that
 * caused it and moves focus onto the first such complaint. That whole design is worth nothing if the
 * complaint is behind something. The action bar at the foot of this form is sticky, so it floats
 * over the end of the page, and the browser's own "scroll this into view" does not know it is there:
 * it brings the error block only just onto the screen, which is exactly where the bar is. What the
 * scorekeeper then sees is a primary button that did nothing — which is the failure the focus move
 * was added to prevent, arriving by a different route.
 *
 * Checked in a real browser because there is nothing to check anywhere else: the fix is the reserved
 * space a browser leaves when it scrolls, and jsdom neither lays out nor scrolls.
 */
test('a refused Start game leaves the complaint where it can be read', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create game' }).click();
  await expect(page.getByRole('heading', { name: 'Create a game' })).toBeVisible();

  const errors = page.locator('.shell-errors').first();
  const bar = page.locator('.manual-actions');

  // Each refusal re-runs the focus move, so this can be asked more than once of the same form.
  const refuse = async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole('button', { name: 'Start game' }).click();
    await expect(errors).toContainText('Enter a name for the left team.');
    // The form put the cursor on it, which is the behaviour the visibility below has to hold up.
    await expect(errors).toBeFocused();

    const errorBox = await errors.boundingBox();
    const barBox = await bar.boundingBox();
    if (!errorBox || !barBox) throw new Error('The error block and the action bar should both be laid out.');
    return { errorBox, barBox };
  };

  const flat = await refuse();
  // Every line of it, not just the first: four complaints scrolled to the bottom edge lose the last
  // two under the bar, and the last two are as load-bearing as the first.
  expect(flat.errorBox.y).toBeGreaterThanOrEqual(0);
  expect(flat.errorBox.y + flat.errorBox.height).toBeLessThanOrEqual(flat.barBox.y);

  /*
   * And again on a handset whose gesture bar takes the bottom of the viewport, which is where a
   * clearance written as a flat number comes apart: the bar grows by the inset and the reserved
   * space does not, so the last line of the complaint ends up back underneath it.
   *
   * env(safe-area-inset-bottom) cannot be driven from a test, so the foot both rules are derived
   * from is overridden instead. 48px is past the ~34px a phone with a home indicator reports, so a
   * bar measured at the old flat 84px is comfortably too short here.
   */
  await page.addStyleTag({ content: '.manual-shell { --manual-actions-foot: 48px; }' });

  const inset = await refuse();
  expect(inset.barBox.height).toBeGreaterThan(84);
  expect(inset.errorBox.y).toBeGreaterThanOrEqual(0);
  expect(inset.errorBox.y + inset.errorBox.height).toBeLessThanOrEqual(inset.barBox.y);
});
