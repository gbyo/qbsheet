/**
 * The live bonus, in a browser that actually lays it out.
 *
 * jsdom will happily agree that four columns fit in three hundred pixels. This is the check that
 * they do: a bouncing bonus opens on a grid of part outcomes above the control bar, which reads as
 * columns under the two team names on a scorer's screen and folds into blocks of full-width buttons
 * on a phone. Either way nothing may leave the panel sideways, and — the thing that matters most at
 * a table — the rows may not move between one press and the next, because the scorekeeper's finger
 * is already on its way to the next one.
 */
import { expect, test, type Page } from '@playwright/test';
import { validPackage } from '../tests/packages';
import { chooseScoringLayout } from './support/scoringLayout';

const opponent = 'Greenwood Consolidated Regional';

async function openBounceGame(page: Page): Promise<void> {
  const packageValue = validPackage();
  packageValue.scorekeeperFormat.players.maximumActive = 2;
  packageValue.scorekeeperFormat.bonus.bounceBack = true;
  // A long name is the case that breaks a row of fixed columns.
  packageValue.right.name = opponent;

  await page.goto('/');
  await page.locator('.file-open-input').setInputFiles({
    name: 'bonus-parts.qbg',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(packageValue)),
  });

  await chooseScoringLayout(page);
  await expect(page.getByRole('heading', { name: 'Who is starting?' })).toBeVisible();
  const prompt = page.getByLabel('Starting lineups');
  for (const player of ['Sarah Mitchell', 'James Okafor']) {
    await prompt
      .getByLabel('Ninety Six A starters')
      .getByRole('button', { name: `Start ${player}` })
      .click();
  }
  for (const player of ['Emma Chen', 'Jordan Blake']) {
    await prompt
      .getByLabel(`${opponent} starters`)
      .getByRole('button', { name: `Start ${player}` })
      .click();
  }
  await page.getByRole('button', { name: 'Start game' }).click();
  await page.getByRole('button', { name: 'Sarah Mitchell 10', exact: true }).click();
  await expect(page.getByLabel('Bonus')).toBeVisible();
}

/** The panel, and the widest thing inside the part grid, measured against each other. */
async function partLayout(page: Page) {
  return page.getByLabel('Bonus').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const rows = Array.from(element.querySelectorAll('.scorer-part-row')).map((row) => {
      const box = row.getBoundingClientRect();
      const buttons = Array.from(row.querySelectorAll('button')).map((button) =>
        button.getBoundingClientRect(),
      );
      return {
        // Layout position, deliberately not the painted one: a few pixels of rise on the row that
        // has just become active is the intended acknowledgement. What must not move is where the
        // row actually is, because that is what the next press is aimed at.
        layoutTop: (row as HTMLElement).offsetTop,
        right: box.right,
        buttonRight: Math.max(...buttons.map((button) => button.right)),
        buttonWidth: Math.min(...buttons.map((button) => button.width)),
        buttonHeight: Math.min(...buttons.map((button) => button.height)),
        // Where each button sits, so a wide row and a folded one can be told apart.
        tops: buttons.map((button) => Math.round(button.top)),
        widths: buttons.map((button) => Math.round(button.width)),
      };
    });
    return {
      left: bounds.left,
      right: bounds.right,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      rows,
    };
  });
}

test('the live part grid is columns on a scorer screen and blocks on a narrow one', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openBounceGame(page);

  const wide = await partLayout(page);
  expect(wide.rows).toHaveLength(3);
  for (const row of wide.rows) {
    // One line: the three answers side by side under the part number.
    expect(new Set(row.tops).size).toBe(1);
    expect(row.buttonRight).toBeLessThanOrEqual(row.right + 1);
    // Wide enough to be pressed rather than aimed at.
    expect(row.buttonWidth).toBeGreaterThan(44);
  }
  expect(wide.scrollWidth).toBeLessThanOrEqual(wide.clientWidth);
  expect(wide.left).toBeGreaterThanOrEqual(0);
  expect(wide.right).toBeLessThanOrEqual(1366);

  /*
   * The same prompt in a phone-width window.
   *
   * The two teams pair up on one line and the answer that is neither takes the line below. One
   * button per line was the obvious fold and the wrong one: nine stacked buttons made the panel
   * taller than the phone and pushed its own Record off the bottom of the screen.
   */
  await page.setViewportSize({ width: 360, height: 740 });
  const narrow = await partLayout(page);
  for (const row of narrow.rows) {
    const [controlling, opponent, noPoints] = row.tops;
    expect(opponent).toBe(controlling);
    expect(noPoints).toBeGreaterThan(controlling);
    // And it spans both of them rather than sitting under one.
    expect(row.widths[2]).toBeGreaterThan(row.widths[0] + row.widths[1]);
    expect(row.buttonRight).toBeLessThanOrEqual(row.right + 1);
    // Still a touch target, not a sliver.
    expect(row.buttonHeight).toBeGreaterThanOrEqual(40);
  }
  expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth);
  expect(narrow.left).toBeGreaterThanOrEqual(0);
  expect(narrow.right).toBeLessThanOrEqual(360);

  /*
   * The panel stays inside the contextual row that holds it.
   *
   * That row is a flex item of the column the sheet is laid out in, and its own content is centred
   * — so when it was allowed to shrink below what it was showing, a bonus taller than the squashed
   * box escaped in both directions and painted over the roster with nothing behind it. A tall
   * prompt has to make the sheet scroll instead, which is what the body is a scroller for.
   */
  const containment = await page.evaluate(() => {
    const stage = document.querySelector('.scorer-stage') as HTMLElement;
    const prompt = document.querySelector('.scorer-bonus-prompt') as HTMLElement;
    const stageBox = stage.getBoundingClientRect();
    const promptBox = prompt.getBoundingClientRect();
    return {
      overflowAbove: Math.round(stageBox.top - promptBox.top),
      overflowBelow: Math.round(promptBox.bottom - stageBox.bottom),
    };
  });
  expect(containment.overflowAbove).toBeLessThanOrEqual(0);
  expect(containment.overflowBelow).toBeLessThanOrEqual(0);

  /*
   * There is nothing here that a width can take away. The team is written on the button itself at
   * both sizes, so which of the two is the bounce never depends on a heading — the panel used to
   * carry one, and it was the only part of it that a narrow screen folded out of sight.
   */
  for (const width of [1366, 360]) {
    await page.setViewportSize({ width, height: 740 });
    await expect(page.getByRole('button', { name: `Part 2 to ${opponent}, 10 points` })).toContainText(
      opponent,
    );
    await expect(page.getByRole('button', { name: 'Part 2 to Ninety Six A, 10 points' })).toContainText(
      'Ninety Six A',
    );
  }
});

test('answering the parts records one bonus without the rows moving under the pointer', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openBounceGame(page);

  const before = await partLayout(page);

  await page.getByRole('button', { name: 'Part 1 to Ninety Six A, 10 points' }).click();
  await expect(page.getByText('Ninety Six A 10 ·')).toBeVisible();

  // The whole point of the metaphor: part 2 and part 3 are exactly where they were.
  const after = await partLayout(page);
  expect(after.rows.map((row) => row.layoutTop)).toEqual(before.rows.map((row) => row.layoutTop));

  await page.getByRole('button', { name: `Part 2 to ${opponent}, 10 points` }).click();
  await page.getByRole('button', { name: 'No points on part 3' }).click();

  /*
   * Answering every part does not write the bonus. The panel is still up, showing what is about to
   * be recorded, and Record has taken the focus — so the key that finishes a bonus is Enter,
   * without a shortcut having had to be invented for it.
   */
  const record = page.getByRole('button', { name: 'Record bonus' });
  await expect(record).toBeFocused();
  await expect(page.getByLabel('Ninety Six A score')).toHaveText('10');

  await page.keyboard.press('Enter');

  await expect(page.getByLabel('Bonus')).toBeHidden();
  await expect(page.getByLabel('Ninety Six A score')).toHaveText('20');
  await expect(page.getByLabel(`${opponent} score`)).toHaveText('10');
});
