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
  await expect(page.getByRole('region', { name: 'Bonus' })).toBeVisible();
}

/** The panel, and the widest thing inside the part grid, measured against each other. */
async function partLayout(page: Page) {
  return page.getByRole('region', { name: 'Bonus' }).evaluate((element) => {
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
        // Stacked once the rows fold: every button starts on the same left edge.
        stacked: buttons.every((button) => Math.abs(button.left - buttons[0].left) < 1),
      };
    });
    const head = element.querySelector('.scorer-part-head');
    return {
      left: bounds.left,
      right: bounds.right,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      headingVisible: head !== null ? getComputedStyle(head).display !== 'none' : false,
      rows,
    };
  });
}

test('the live part grid is columns on a scorer screen and blocks on a narrow one', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openBounceGame(page);

  const wide = await partLayout(page);
  expect(wide.rows).toHaveLength(3);
  expect(wide.headingVisible).toBe(true);
  for (const row of wide.rows) {
    expect(row.stacked).toBe(false);
    expect(row.buttonRight).toBeLessThanOrEqual(row.right + 1);
    // Wide enough to be pressed rather than aimed at.
    expect(row.buttonWidth).toBeGreaterThan(44);
  }
  expect(wide.scrollWidth).toBeLessThanOrEqual(wide.clientWidth);
  expect(wide.left).toBeGreaterThanOrEqual(0);
  expect(wide.right).toBeLessThanOrEqual(1366);

  // The same prompt in a phone-width window: each part becomes a block, and its buttons name their
  // own team now that the column heading has gone.
  await page.setViewportSize({ width: 360, height: 740 });
  const narrow = await partLayout(page);
  expect(narrow.headingVisible).toBe(false);
  for (const row of narrow.rows) {
    expect(row.stacked).toBe(true);
    expect(row.buttonRight).toBeLessThanOrEqual(row.right + 1);
    // Still a touch target, not a sliver.
    expect(row.buttonHeight).toBeGreaterThanOrEqual(40);
  }
  expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth);
  expect(narrow.left).toBeGreaterThanOrEqual(0);
  expect(narrow.right).toBeLessThanOrEqual(360);

  await expect(page.getByRole('button', { name: `Part 2 to ${opponent}, 10 points` })).toContainText(
    opponent,
  );
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

  // Recorded on the last press, with no Record button in between, and the room already moved on.
  await expect(page.getByRole('region', { name: 'Bonus' })).toBeHidden();
  await expect(page.getByLabel('Ninety Six A score')).toHaveText('20');
  await expect(page.getByLabel(`${opponent} score`)).toHaveText('10');
});
