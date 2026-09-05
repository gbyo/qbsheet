import { expect, test, type Page } from '@playwright/test';
import { chooseScoringLayout } from './support/scoringLayout';

async function startGame(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create game' }).click();
  await page.getByLabel('Game label').fill('Quietly peculiar');
  await page.getByLabel('Left team name').fill('Ninety Six');
  await page.getByLabel('Right team name').fill('Greenwood');
  await page.getByLabel('Ninety Six players').fill('Sarah Mitchell\nJames Robinson');
  await page.getByLabel('Greenwood players').fill('Emma Turner\nJordan Lee');
  await page.getByLabel('Players playing at once').fill('2');
  await page.getByLabel('Power (blank for none)').fill('15');
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await chooseScoringLayout(page);
}

async function command(page: Page, value: string) {
  await page.waitForTimeout(20);
  await page.keyboard.press('?');
  const input = page.getByRole('combobox', { name: 'Command' });
  await expect(input).toBeFocused();
  await input.fill(value);
  await input.press('Enter');
}

test('logo discovery, commands, games, and DVD stay outside scoring', async ({ page }) => {
  await startGame(page);
  const gameBefore = await page.evaluate(() =>
    Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes('game'))),
  );
  const logo = page.getByRole('button', { name: 'QBSheet', exact: true });
  for (let click = 0; click < 7; click += 1) await logo.click();
  await expect(page.getByRole('dialog', { name: 'You found it.' })).toBeVisible();
  await expect(page.locator('.scorer-brand-logo')).toHaveAttribute('data-rainbow', 'true');
  await page.getByRole('button', { name: 'Close dialog' }).click();

  await command(page, 'stats');
  await expect(page.getByText(/Secrets discovered on this device/)).toBeVisible();
  await page.keyboard.press('Escape');
  await command(page, 'qbbird');
  await expect(page.getByLabel(/QBBird play area/)).toBeVisible();
  await page.keyboard.press('Escape');
  await command(page, 'snake');
  await expect(page.getByLabel(/Snake play area/)).toBeVisible();
  await page.keyboard.press('Escape');

  await command(page, 'dvd');
  await expect(page.getByRole('button', { name: 'Exit DVD mode' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Exit DVD mode' })).toHaveCount(0);
  await command(page, 'dvd');
  await page.getByRole('button', { name: 'Exit DVD mode' }).click({ force: true });

  const gameAfter = await page.evaluate(() =>
    Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes('game'))),
  );
  expect(gameAfter).toEqual(gameBefore);
});

test('pressing and holding the logo unlocks on pointer devices', async ({ page }) => {
  await startGame(page);
  const logo = page.getByRole('button', { name: 'QBSheet', exact: true });
  await logo.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
  });
  await expect(page.getByRole('dialog', { name: 'You found it.' })).toBeVisible();
  await logo.dispatchEvent('pointerup', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
  });
});

test('power decorates the committed score without replaying the ordinary roll animation', async ({ page }) => {
  await startGame(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'Sarah Mitchell Power', exact: true }).click();
  const powerReaction = page.locator('.score-reaction[data-power="true"]');
  const scoreValue = page.getByLabel('Ninety Six score').locator('.scorer-team-score-value');
  await expect(powerReaction).toContainText('15');
  await expect(powerReaction).toHaveCount(0);
  expect(await scoreValue.evaluate((element) => getComputedStyle(element).animationName)).not.toBe(
    'scorer-score-roll-up',
  );
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByLabel('Ninety Six score')).toContainText('0');
});

test('question mark does not hijack typing and reduced motion makes DVD static', async ({ page }) => {
  await startGame(page);
  await page.locator('.scorer').evaluate((scorer) => {
    const field = document.createElement('input');
    field.id = 'secret-typing-test';
    scorer.append(field);
    field.focus();
  });
  const input = page.locator('#secret-typing-test');
  await page.keyboard.type('?');
  expect(await input.evaluate((field) => (field as HTMLInputElement).value)).toBe('?');
  await expect(page.getByRole('dialog', { name: 'A little detour' })).toHaveCount(0);
  await input.evaluate((field) => field.remove());

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await command(page, 'dvd');
  const overlay = page.locator('.dvd-overlay');
  await expect(overlay).toHaveAttribute('data-reduced-motion', 'true');
  const first = await page.getByRole('button', { name: 'Exit DVD mode' }).boundingBox();
  await page.waitForTimeout(150);
  expect(await page.getByRole('button', { name: 'Exit DVD mode' }).boundingBox()).toEqual(first);
  await page.getByRole('button', { name: 'Exit DVD mode' }).click({ force: true });
  await page.getByRole('button', { name: 'Sarah Mitchell Power', exact: true }).click();
  const lightning = page.locator('.score-lightning');
  await expect(lightning).toHaveCount(1);
  expect(await lightning.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
});
