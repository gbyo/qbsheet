import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { validPackage } from '../tests/packages';

interface IQbjAnswerCount {
  number: number;
  answer_type: { value: number };
}

interface IQbjMatchPlayer {
  player: { name: string };
  tossups_heard: number;
  answer_counts: IQbjAnswerCount[];
}

interface IQbjMatchTeam {
  team: { name: string };
  points: number;
  match_players: IQbjMatchPlayer[];
}

interface IQbjMatchQuestion {
  question_number: number;
  buzzes: Array<{ player?: { name: string }; result: { value: number } }>;
  bonus_points?: number;
}

interface IQbjResult {
  tossups_read: number;
  notes?: string;
  match_teams: IQbjMatchTeam[];
  match_questions: IQbjMatchQuestion[];
}

async function openGeneratedGame(page: Page): Promise<void> {
  const packageValue = validPackage();
  packageValue.scorekeeperFormat.players.maximumActive = 2;
  await page.locator('.file-open-input').setInputFiles({
    name: 'browser-torture.qbg',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(packageValue)),
  });

  await expect(page.getByRole('heading', { name: 'Who is starting?' })).toBeVisible();
  const prompt = page.getByLabel('Starting lineups');
  const left = prompt.getByLabel('Ninety Six A starters');
  const right = prompt.getByLabel('Greenwood starters');
  for (const player of ['Sarah Mitchell', 'James Okafor']) {
    await left.getByRole('button', { name: `Start ${player}` }).click();
  }
  for (const player of ['Emma Chen', 'Jordan Blake']) {
    await right.getByRole('button', { name: `Start ${player}` }).click();
  }
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page.getByText('Tossup 1 of 20', { exact: true })).toBeVisible();
}

async function chooseBonus(page: Page, points: number): Promise<void> {
  await page
    .getByLabel('Bonus')
    .getByRole('button', { name: String(points), exact: true })
    .click();
}

async function enableKeyboardScoring(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Game', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Keyboard scoring: off' }).click();
  await expect(page.getByLabel('Keyboard scoring')).toBeVisible();
}

async function pressModifiedKey(page: Page, modifier: 'Alt' | 'Control' | 'Shift', key: string): Promise<void> {
  await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  await page.keyboard.up(modifier);
}

async function openReviewWithKeyboard(page: Page): Promise<void> {
  const gameMenu = page.getByRole('button', { name: 'Game', exact: true });
  await gameMenu.focus();
  await gameMenu.press('ArrowDown');
  const review = page.getByRole('menuitem', { name: 'Full scoresheet review' });
  const menuItems = page.getByRole('menuitem');
  const labels = await menuItems.allTextContents();
  const reviewIndex = labels.findIndex((label) => label.trim() === 'Full scoresheet review');
  expect(reviewIndex).toBeGreaterThanOrEqual(0);
  for (let move = 0; move < reviewIndex; move += 1) await page.keyboard.press('ArrowDown');
  await expect(review).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Full scoresheet review' })).toBeVisible();
}

test('production keyboard scoring records seat rulings, bonuses, and safe focus boundaries', async ({ page }) => {
  await page.goto('/');
  await openGeneratedGame(page);
  await enableKeyboardScoring(page);

  // A real dialog and its real textarea own their printable keys. The seat listener must not score
  // through either focus boundary.
  await page.getByRole('button', { name: 'Game', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Notes' }).click();
  const notes = page.getByRole('dialog', { name: 'Notes' });
  const noteField = page.locator('#scorer-note-text');
  await expect(notes).toBeVisible();
  await noteField.focus();
  await page.keyboard.press('1');
  await page.keyboard.press('c');
  await expect(noteField).toHaveValue('1c');
  await expect(page.getByText('Tossup 1 of 20', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(notes).toBeHidden();
  await page.locator('body').click({ position: { x: 8, y: 8 } });

  // Ctrl+1 is deliberately not a seat. It remains available to Chrome/ChromeOS, and the C that
  // follows has no armed seat to complete, so Q1 stays live.
  await pressModifiedKey(page, 'Control', '1');
  await page.keyboard.press('c');
  await expect(page.getByLabel('Ninety Six A score')).toHaveText('0');

  // 1 and 2 are the first and second left seats. Both sequences use the production document listener.
  await page.keyboard.press('1');
  await page.keyboard.press('c');
  await expect(page.getByLabel('Ninety Six A score')).toHaveText('10');
  await expect(page.getByLabel('Bonus')).toBeVisible();
  // The bonus digit is the number of parts, so two parts — 20 points here — is 2.
  await page.keyboard.press('2');
  await expect(page.getByText('Tossup 2 of 20', { exact: true })).toBeVisible();

  await page.keyboard.press('2');
  await page.keyboard.press('p');
  await expect(page.getByLabel('Ninety Six A score')).toHaveText('45');
  await page.keyboard.press('1');
  await expect(page.getByText('Tossup 3 of 20', { exact: true })).toBeVisible();

  // 5 is the first right seat. Its negative leaves the other team eligible, so Space then records the
  // unanswered remainder and advances to the next tossup.
  await page.keyboard.press('5');
  await page.keyboard.press('n');
  await expect(page.getByLabel('Greenwood score')).toHaveText('-5');
  await page.keyboard.press('Space');
  await expect(page.getByText('Tossup 4 of 20', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Ninety Six A score')).toHaveText('55');

  await openReviewWithKeyboard(page);
  const review = page.getByRole('dialog', { name: 'Full scoresheet review' });
  await expect(review).toContainText('Ninety Six A 55');
  await expect(review).toContainText('Greenwood -5');

  const questions = review.locator('.scorer-review-list > li');
  await expect(questions).toHaveCount(3);
  await expect(questions.filter({ hasText: 'Q1' })).toContainText('Sarah Mitchell +10');
  await expect(questions.filter({ hasText: 'Q1' })).toContainText('Bonus 20');
  await expect(questions.filter({ hasText: 'Q2' })).toContainText('James Okafor +15');
  await expect(questions.filter({ hasText: 'Q2' })).toContainText('Bonus 10');
  await expect(questions.filter({ hasText: 'Q3' })).toContainText('Emma Chen -5');
  await expect(questions.filter({ hasText: 'Q3' })).toContainText('No buzz');
});

test('a real scorer session survives fast input, reload, correction, completion, and export', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });

  await page.goto('/');
  await openGeneratedGame(page);

  // A hurried double-click must still record one tossup, not two events or two questions.
  await page.getByRole('button', { name: 'Sarah Mitchell 15', exact: true }).dblclick();
  await expect(page.getByLabel('Ninety Six A score')).toHaveText('15');
  await expect(page.getByLabel('Bonus')).toBeVisible();
  await chooseBonus(page, 20);
  await expect(page.getByText('Tossup 2 of 20', { exact: true })).toBeVisible();

  // The primary scoring path also has to work without a pointer.
  await page.getByRole('button', { name: 'Emma Chen 10', exact: true }).press('Enter');
  await chooseBonus(page, 10);
  await page.locator('body').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('Space');
  await expect(page.getByText('Tossup 4 of 20', { exact: true })).toBeVisible();

  await expect(page.getByLabel('Ninety Six A score')).toHaveText('35');
  await expect(page.getByLabel('Greenwood score')).toHaveText('20');

  // This is a full document reload, not a React remount: IndexedDB and the recovery journal must win.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unfinished game' })).toBeVisible();
  await expect(page.getByText('Q3', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByText('Tossup 4 of 20', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Ninety Six A score')).toHaveText('35');
  await expect(page.getByLabel('Greenwood score')).toHaveText('20');

  // Walk the actual ARIA menu with the keyboard, then correct a historical player, ruling, and bonus atomically.
  await openReviewWithKeyboard(page);
  const questionTwo = page.locator('.scorer-review-list > li').filter({ hasText: 'Q2' });
  await questionTwo.getByRole('button', { name: 'Edit question' }).click();
  await page.getByLabel('Player', { exact: true }).selectOption({ label: 'Jordan Blake' });
  // A format with four or fewer rulings renders them as a segmented group, not a select.
  await page
    .getByRole('group', { name: 'Ruling', exact: true })
    .getByRole('button', { name: 'Power (+15)', exact: true })
    .click();
  await page.getByRole('group', { name: 'Bonus points' }).getByRole('button', { name: '20' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('dialog', { name: 'Full scoresheet review' }).getByRole('button', { name: 'Close' }).click();

  await expect(page.getByLabel('Greenwood score')).toHaveText('35');
  await page.getByRole('button', { name: 'Game', exact: true }).click();
  await page.getByRole('menuitem', { name: 'End game early…' }).click();
  await page.getByLabel('Why is the game ending early?').fill('Browser torture test completed');
  await page.getByRole('button', { name: 'End the game now' }).click();

  await expect(page.locator('.scorer-complete-title')).toHaveText('Final score — game ended early');
  await expect(page.getByLabel('Final score confirmed with both teams')).not.toBeChecked();
  await page.getByLabel('Final score confirmed with both teams').check();
  await page.getByRole('button', { name: 'Submit result' }).click();
  await expect(page.getByRole('heading', { name: 'Final' })).toBeVisible();

  const downloadStarted = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download QBJ' }).click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toBe('R07_Room-204_Ninety-Six-A_vs_Greenwood.qbj');
  const downloadedPath = await download.path();
  if (!downloadedPath) throw new Error('Chromium did not expose the downloaded QBJ path.');
  const qbj = JSON.parse(await readFile(downloadedPath, 'utf8')) as IQbjResult;

  expect(qbj.tossups_read).toBe(3);
  expect(qbj.match_teams.map((team) => team.points)).toEqual([35, 35]);
  expect(qbj.notes).toContain('Browser torture test completed');
  const secondQuestion = qbj.match_questions.find((question) => question.question_number === 2);
  expect(secondQuestion).toMatchObject({
    buzzes: [{ player: { name: 'Jordan Blake' }, result: { value: 15 } }],
    bonus_points: 20,
  });
  expect(qbj.match_questions[0].buzzes).toHaveLength(1);
  const greenwood = qbj.match_teams.find((team) => team.team.name === 'Greenwood');
  const jordan = greenwood?.match_players.find((player) => player.player.name === 'Jordan Blake');
  expect(jordan?.answer_counts).toContainEqual({ number: 1, answer_type: { value: 15 } });
  await expect(page.getByRole('button', { name: 'Done' })).toBeEnabled();
  expect(browserErrors).toEqual([]);
});
