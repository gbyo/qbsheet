/**
 * Where the substitution control sits, and how loudly it says so.
 *
 * Both claims here are layout, which is why they are in a real browser: jsdom loads no stylesheet, so
 * the unit suite can see the glyph but not where it lands or what it looks like.
 *
 * The control belongs to the name and has to stay against it. It spent a previous life parked at the
 * far end of the row, against the rulings — a fifth target beside +10 for a thumb to find while a
 * reader was still talking. The name growing to fill the row is what put it there, so the test
 * measures the gap rather than trusting the rule that closed it.
 */
import { expect, test } from '@playwright/test';
import { validPackage } from '../tests/packages';

test('the substitution control sits against the name, unbordered, with the rulings still flush right', async ({
  page,
}) => {
  await page.goto('/');
  const packageValue = validPackage();
  packageValue.scorekeeperFormat.players.maximumActive = 2;
  await page.locator('.file-open-input').setInputFiles({
    name: 'sub-control.qbg',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(packageValue)),
  });
  await expect(page.getByRole('heading', { name: 'Who is starting?' })).toBeVisible();
  for (const player of ['Sarah Mitchell', 'James Okafor', 'Emma Chen', 'Jordan Blake']) {
    await page.getByLabel(player, { exact: true }).check();
  }
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page.getByText('Tossup 1 of 20', { exact: true })).toBeVisible();

  const row = page.locator('li.scorer-player').first();
  const control = row.getByRole('button', { name: 'Substitute for Sarah Mitchell' });
  const controlBox = (await control.boundingBox())!;
  const answersBox = (await row.locator('.scorer-answers').boundingBox())!;
  const rowBox = (await row.boundingBox())!;

  /*
   * Against the name means against the text, not against the name's box. The control is the name's
   * next sibling, so the gap between the two boxes is the row gap whatever the layout does — a name
   * stretched to fill the row simply carries the control out to the rulings with it. So measure where
   * the glyph actually stops, which is what somebody looking at the sheet sees.
   */
  const textRight = await row.locator('.scorer-player-name').evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getBoundingClientRect().right;
  });
  expect(controlBox.x - textRight).toBeLessThanOrEqual(12);
  // And still a target a finger can hit, which is the thing an unbordered glyph most easily loses.
  expect(controlBox.width).toBeGreaterThanOrEqual(28);
  expect(controlBox.height).toBeGreaterThanOrEqual(28);
  // The rulings keep the right edge, so their columns line up down the sheet.
  expect(Math.abs(answersBox.x + answersBox.width - (rowBox.x + rowBox.width))).toBeLessThanOrEqual(1);

  // A glyph in the accent colour, not a bordered box competing with the rulings beside it.
  const look = await control.evaluate((element) => {
    const computed = getComputedStyle(element);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--room-accent').trim();
    const probe = document.createElement('span');
    probe.style.color = accent;
    document.body.appendChild(probe);
    const accentRgb = getComputedStyle(probe).color;
    probe.remove();
    return { borderStyle: computed.borderStyle, color: computed.color, accentRgb };
  });
  expect(look.borderStyle).toBe('none');
  expect(look.color).toBe(look.accentRgb);
});
