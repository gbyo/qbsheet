/**
 * The bonus part editor, in a browser that actually lays it out.
 *
 * jsdom will happily agree that four columns fit in three hundred pixels. This is the check that
 * they do: the part rows are a grid of outcome buttons per part, and on a Chromebook they read as
 * columns under the two team names while on a phone-width dialog they fold into blocks. Either way
 * nothing may leave the dialog sideways, because a correction control the scorekeeper cannot reach
 * is a correction that does not happen.
 */
import { expect, test, type Page } from '@playwright/test';
import { validPackage } from '../tests/packages';
import { chooseScoringLayout } from './support/scoringLayout';

async function openGameWithBouncebacks(page: Page): Promise<void> {
  const packageValue = validPackage();
  packageValue.scorekeeperFormat.players.maximumActive = 2;
  packageValue.scorekeeperFormat.bonus.bounceBack = true;
  // A long name is the case that breaks a row of fixed columns.
  packageValue.right.name = 'Greenwood Consolidated Regional';

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
      .getByLabel('Greenwood Consolidated Regional starters')
      .getByRole('button', { name: `Start ${player}` })
      .click();
  }
  await page.getByRole('button', { name: 'Start game' }).click();
}

/** The dialog, and the widest thing inside the part editor, measured against each other. */
async function partEditorLayout(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Edit Question 1' });
  return dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const rows = Array.from(element.querySelectorAll('.scorer-question-part')).map((row) => {
      const box = row.getBoundingClientRect();
      const buttons = Array.from(row.querySelectorAll('button')).map((button) =>
        button.getBoundingClientRect(),
      );
      return {
        left: box.left,
        right: box.right,
        buttonRight: Math.max(...buttons.map((button) => button.right)),
        buttonWidth: Math.min(...buttons.map((button) => button.width)),
        // Stacked once the rows fold: every button starts on the same left edge.
        stacked: buttons.every((button) => Math.abs(button.left - buttons[0].left) < 1),
      };
    });
    return {
      left: bounds.left,
      right: bounds.right,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      headingVisible:
        element.querySelector('.scorer-question-part-head') !== null
          ? getComputedStyle(element.querySelector('.scorer-question-part-head') as Element).display !==
            'none'
          : false,
      rows,
    };
  });
}

/** Score the bonus as totals, which a bouncing format now reaches through its own way out. */
async function recordBonusTotals(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sarah Mitchell 10', exact: true }).click();
  const bonus = page.getByLabel('Bonus');
  await bonus.getByRole('button', { name: 'Enter totals instead' }).click();
  await bonus.getByRole('button', { name: 'Ninety Six A, 20 points' }).click();
  await bonus.getByRole('button', { name: 'Greenwood Consolidated Regional, 10 points' }).click();
}

async function openPartEditor(page: Page): Promise<void> {
  await recordBonusTotals(page);

  await page.getByRole('button', { name: 'Review question 1' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Question 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit by part' }).click();
  await expect(page.getByRole('group', { name: 'Bonus part 1 outcome' })).toBeVisible();
}

test('the part editor lays out as columns on a scorer screen and as blocks on a narrow one', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openGameWithBouncebacks(page);
  await openPartEditor(page);

  const wide = await partEditorLayout(page);
  expect(wide.rows).toHaveLength(3);
  expect(wide.headingVisible).toBe(true);
  // Columns, not a stack, and nothing hanging off the side of the dialog.
  for (const row of wide.rows) {
    expect(row.stacked).toBe(false);
    expect(row.buttonRight).toBeLessThanOrEqual(row.right + 1);
    // Wide enough to be pressed rather than aimed at.
    expect(row.buttonWidth).toBeGreaterThan(44);
  }
  expect(wide.scrollWidth).toBeLessThanOrEqual(wide.clientWidth);
  expect(wide.left).toBeGreaterThanOrEqual(0);
  expect(wide.right).toBeLessThanOrEqual(1366);

  // The same editor in a phone-width dialog: each part becomes a block, and its buttons name their
  // own team now that the column heading has gone.
  await page.setViewportSize({ width: 360, height: 740 });
  const narrow = await partEditorLayout(page);
  expect(narrow.headingVisible).toBe(false);
  for (const row of narrow.rows) {
    expect(row.stacked).toBe(true);
    expect(row.buttonRight).toBeLessThanOrEqual(row.right + 1);
  }
  expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth);
  expect(narrow.left).toBeGreaterThanOrEqual(0);
  expect(narrow.right).toBeLessThanOrEqual(360);

  await expect(
    page.getByRole('button', { name: 'Bonus part 2 bounced back to Greenwood Consolidated Regional' }),
  ).toContainText('Greenwood Consolidated Regional');

  // And it still works down there: answering all three parts commits the breakdown.
  await page.getByRole('button', { name: 'Bonus part 1 to Ninety Six A' }).click();
  await page
    .getByRole('button', { name: 'Bonus part 2 bounced back to Greenwood Consolidated Regional' })
    .click();
  await page.getByRole('button', { name: 'Bonus part 3 to Ninety Six A' }).click();
  await expect(
    page.getByText('Ninety Six A +20 · Greenwood Consolidated Regional +10 bounceback'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByLabel('Ninety Six A score')).toHaveText('30');
  await expect(page.getByLabel('Greenwood Consolidated Regional score')).toHaveText('10');
});
