/**
 * Dragging a player into the chair they are actually sitting in, in a browser that has pointers.
 *
 * jsdom can prove the wiring — that a gesture of two seats commits that order and writes no event —
 * because the arithmetic is extracted and unit tested. What it cannot prove is the gesture: every
 * rectangle in jsdom is zero by zero, so the threshold, the measured seat pitch, the pointer capture
 * and the seat the tile is actually over are all fictions there. They are real here.
 *
 * The claims are the ones a scorekeeper would notice going wrong: a player lands where they were
 * dropped, the numbers follow, a short movement is still a press rather than a drag, and nothing a
 * drag does reaches the score.
 */
import { expect, test, type Page } from '@playwright/test';
import { validPackage } from '../tests/packages';
import { chooseScoringLayout } from './support/scoringLayout';

/** Open a four-a-side game straight into the table layout. */
async function openTableGame(page: Page): Promise<void> {
  const packageValue = validPackage({
    left: {
      name: 'Ninety Six A',
      players: [{ name: 'Gibson' }, { name: 'Maycie' }, { name: 'Jeremy' }, { name: 'Phillip' }],
    },
  });
  packageValue.scorekeeperFormat.players.maximumActive = 4;
  await page.goto('/');
  await page.locator('.file-open-input').setInputFiles({
    name: 'table-arrange.qbg',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(packageValue)),
  });

  await chooseScoringLayout(page, 'Table');
  await expect(page.getByText('Tossup 1 of 20', { exact: true })).toBeVisible();
  await expect(page.locator('.scorer-table-view')).toBeVisible();
}

/** The names along one team's table, left to right. */
async function chairs(page: Page, teamName: string): Promise<string[]> {
  return page.getByRole('region', { name: teamName }).locator('.scorer-table-player-name').allTextContents();
}

async function seatNumbers(page: Page, teamName: string): Promise<string[]> {
  return page.getByRole('region', { name: teamName }).locator('.scorer-table-player-seat').allTextContents();
}

/**
 * Carry one player onto another's chair with a real pointer.
 *
 * Moved in steps rather than in one jump, because that is what a hand does and because a single
 * enormous move would not exercise the threshold the gesture starts at. The path follows whichever
 * way the table is actually drawn, which is the whole reason this file is in a browser: a jsdom
 * rectangle has no idea which axis it is on.
 */
async function dragOnto(page: Page, teamName: string, playerName: string, target: string): Promise<void> {
  const team = page.getByRole('region', { name: teamName });
  const from = team.getByRole('button', { name: new RegExp(`^${playerName}, seat `) });
  const to = team.getByRole('button', { name: new RegExp(`^${target}, seat `) });
  const start = await from.boundingBox();
  const finish = await to.boundingBox();
  expect(start).not.toBeNull();
  expect(finish).not.toBeNull();
  const startX = (start?.x ?? 0) + (start?.width ?? 0) / 2;
  const startY = (start?.y ?? 0) + (start?.height ?? 0) / 2;
  const finishX = (finish?.x ?? 0) + (finish?.width ?? 0) / 2;
  const finishY = (finish?.y ?? 0) + (finish?.height ?? 0) / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(startX + ((finishX - startX) * step) / 8, startY + ((finishY - startY) * step) / 8);
  }
  await page.mouse.up();
}

test('a player is dragged into a different chair, and the table keeps the new order', async ({ page }) => {
  await openTableGame(page);
  await page.getByRole('button', { name: 'Arrange table' }).click();

  await dragOnto(page, 'Ninety Six A', 'Phillip', 'Gibson');

  await expect(
    page.getByRole('region', { name: 'Ninety Six A' }).locator('.scorer-table-player'),
  ).toHaveCount(4);
  expect(await chairs(page, 'Ninety Six A')).toEqual(['Phillip', 'Gibson', 'Maycie', 'Jeremy']);
  // The numbers are positional, so they stay 1..4 and describe the new order.
  expect(await seatNumbers(page, 'Ninety Six A')).toEqual(['1', '2', '3', '4']);

  // And it is the one seat order: leaving arrangement and looking at the scoresheet shows the same.
  await page.getByRole('button', { name: 'Done arranging' }).click();
  await page.getByRole('radio', { name: 'Scoresheet', exact: true }).click();
  expect(
    await page.getByRole('region', { name: 'Ninety Six A' }).locator('.scorer-player-name').allTextContents(),
  ).toEqual(['Phillip', 'Gibson', 'Maycie', 'Jeremy']);
});

test('the other team is not somewhere a player can be dropped', async ({ page }) => {
  await openTableGame(page);
  await page.getByRole('button', { name: 'Arrange table' }).click();

  const team = page.getByRole('region', { name: 'Ninety Six A' });
  const gibson = team.getByRole('button', { name: /^Gibson, seat / });
  const opponent = page.getByRole('region', { name: 'Greenwood' });
  const start = await gibson.boundingBox();
  const across = await opponent.boundingBox();
  const startX = (start?.x ?? 0) + (start?.width ?? 0) / 2;
  const startY = (start?.y ?? 0) + (start?.height ?? 0) / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(startX + (((across?.x ?? 0) + 40 - startX) * step) / 8, startY);
  }
  await page.mouse.up();

  // Carried off the end of his own table, Gibson stops at the end of his own table.
  expect(await chairs(page, 'Ninety Six A')).toEqual(['Maycie', 'Jeremy', 'Phillip', 'Gibson']);
  expect(await chairs(page, 'Greenwood')).toEqual(['Emma Chen', 'Jordan Blake', 'Morgan Ellis']);
});

test('a press that barely moves is a press, not a drag', async ({ page }) => {
  await openTableGame(page);
  await page.getByRole('button', { name: 'Arrange table' }).click();
  const before = await chairs(page, 'Ninety Six A');

  const handle = page
    .getByRole('region', { name: 'Ninety Six A' })
    .getByRole('button', { name: /^Maycie, seat / });
  const box = await handle.boundingBox();
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Under the threshold: a resting hand on a touchscreen, or a trackpad that twitched.
  await page.mouse.move(x + 3, y);
  await page.mouse.up();

  expect(await chairs(page, 'Ninety Six A')).toEqual(before);
});

test('arranging the table changes nothing about the game', async ({ page }) => {
  await openTableGame(page);
  await page.getByRole('button', { name: 'Gibson' }).click();
  await page.getByRole('button', { name: 'Gibson 10', exact: true }).click();
  await page.getByLabel('Bonus').getByRole('button', { name: '20', exact: true }).click();
  await expect(page.getByLabel('Ninety Six A score')).toHaveText('30');

  await page.getByRole('button', { name: 'Arrange table' }).click();
  await dragOnto(page, 'Ninety Six A', 'Phillip', 'Gibson');
  await page.getByRole('button', { name: 'Done arranging' }).click();

  // The score, the question and the history are all where they were: a table is furniture.
  await expect(page.getByLabel('Ninety Six A score')).toHaveText('30');
  await expect(page.getByText('Tossup 2 of 20', { exact: true })).toBeVisible();
  expect(await chairs(page, 'Ninety Six A')).toEqual(['Phillip', 'Gibson', 'Maycie', 'Jeremy']);
});

/**
 * The same table, from the end of the room.
 *
 * A browser is the only place this can be checked at all: the claim is that the seats are laid out
 * one above another and that a gesture down that column moves somebody, and both halves are geometry.
 */
test.describe('a table that runs downwards', () => {
  async function faceDownTheTables(page: Page): Promise<void> {
    await page.getByRole('radio', { name: 'Down', exact: true }).click();
    await expect(page.locator('.scorer-table-view')).toHaveAttribute('data-orientation', 'down');
  }

  test('the seats are stacked rather than strung out', async ({ page }) => {
    await openTableGame(page);
    await faceDownTheTables(page);

    const seats = page.getByRole('region', { name: 'Ninety Six A' }).locator('.scorer-table-seat');
    const boxes = await seats.evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { top: box.top, left: box.left };
      }),
    );
    expect(boxes).toHaveLength(4);
    for (let seat = 1; seat < boxes.length; seat += 1) {
      // Each one below the last, and all of them in the same column.
      expect(boxes[seat].top).toBeGreaterThan(boxes[seat - 1].top);
      expect(Math.abs(boxes[seat].left - boxes[0].left)).toBeLessThanOrEqual(1);
    }
    // And the two teams are still beside each other, because they still are in the room.
    const left = await page.getByRole('region', { name: 'Ninety Six A' }).boundingBox();
    const right = await page.getByRole('region', { name: 'Greenwood' }).boundingBox();
    expect(right?.x ?? 0).toBeGreaterThan(left?.x ?? 0);
  });

  test('a player is dragged down the column into a different chair', async ({ page }) => {
    await openTableGame(page);
    await faceDownTheTables(page);
    await page.getByRole('button', { name: 'Arrange table' }).click();

    await dragOnto(page, 'Ninety Six A', 'Phillip', 'Gibson');

    expect(await chairs(page, 'Ninety Six A')).toEqual(['Phillip', 'Gibson', 'Maycie', 'Jeremy']);
    expect(await seatNumbers(page, 'Ninety Six A')).toEqual(['1', '2', '3', '4']);
  });

  test('scoring from it is the scoring it always was', async ({ page }) => {
    await openTableGame(page);
    await faceDownTheTables(page);

    await page.getByRole('button', { name: 'Maycie', exact: true }).click();
    await page.getByRole('button', { name: 'Maycie 15', exact: true }).click();
    await page.getByLabel('Bonus').getByRole('button', { name: '20', exact: true }).click();

    await expect(page.getByLabel('Ninety Six A score')).toHaveText('35');
    await expect(page.getByText('Tossup 2 of 20', { exact: true })).toBeVisible();
  });
});
