import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function createTournament(page: Page) {
  await page.goto('/director.html');
  await expect(page.getByRole('heading', { level: 2, name: 'Create or open a tournament' })).toBeVisible();
  await page.getByLabel('Tournament name').fill('Local Invitational');
  await page.getByLabel('Venue').fill('Main building');
  await page.getByLabel('Organizer').fill('Director');
  await page.getByRole('button', { name: 'Create tournament' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Local Invitational' })).toBeVisible();
}

test('Director starts with an empty, persisted tournament workspace', async ({ page }) => {
  await page.goto('/director.html');

  await expect(page).toHaveTitle('QBSheet Director');
  await expect(page.getByRole('heading', { level: 2, name: 'Create or open a tournament' })).toBeVisible();

  await page.getByLabel('Tournament name').fill('Spring Invitational');
  await page.getByRole('button', { name: 'Create tournament' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Spring Invitational' })).toBeVisible();
  await expect(page.getByText('No rooms have been added yet.')).toBeVisible();
});

test('Director layout keeps panel, table, status, and narrow-window contracts', async ({ page }) => {
  await createTournament(page);

  const navigation = page.locator('nav[aria-label="Tournament sections"]');
  await navigation.getByRole('button', { name: 'Teams', exact: true }).click();
  await page.getByRole('button', { name: 'Add team' }).click();

  const teamForm = page.locator('.director-form-panel').first();
  await expect(teamForm.locator('.director-panel-body')).toBeVisible();
  await expect(teamForm.locator('.director-panel-footer')).toBeVisible();
  const teamFormInsets = await teamForm.evaluate((panel) => {
    const panelBox = panel.getBoundingClientRect();
    const grid = panel.querySelector('.director-form-grid')?.getBoundingClientRect();
    const action = panel.querySelector('.director-panel-footer .director-button')?.getBoundingClientRect();
    if (!grid || !action) throw new Error('Expected a form grid and footer action.');
    return {
      gridLeft: grid.left - panelBox.left,
      gridRight: panelBox.right - grid.right,
      actionLeft: action.left - panelBox.left,
      actionRight: panelBox.right - action.right,
    };
  });
  expect(teamFormInsets.gridLeft).toBeGreaterThanOrEqual(12);
  expect(teamFormInsets.gridRight).toBeGreaterThanOrEqual(12);
  expect(teamFormInsets.actionLeft).toBeGreaterThanOrEqual(12);
  expect(teamFormInsets.actionRight).toBeGreaterThanOrEqual(12);

  await page.getByLabel('Display name').fill('Northview A');
  await page.getByLabel('School / organization').fill('Northview');
  await page.getByRole('button', { name: 'Save team' }).click();

  const tableContract = await page
    .locator('.director-table')
    .first()
    .evaluate((table) => {
      const wrap = table.parentElement;
      const firstCell = table.querySelector('th, td');
      const lastCell = table.querySelector('tr > :last-child');
      if (!wrap || !firstCell || !lastCell) throw new Error('Expected a Director table.');
      const firstCellStyle = getComputedStyle(firstCell);
      const lastCellStyle = getComputedStyle(lastCell);
      return {
        borderCollapse: getComputedStyle(table).borderCollapse,
        overflowX: getComputedStyle(wrap).overflowX,
        firstCellPadding: Number.parseFloat(firstCellStyle.paddingLeft),
        lastCellPadding: Number.parseFloat(lastCellStyle.paddingRight),
      };
    });
  expect(tableContract.borderCollapse).toBe('collapse');
  expect(tableContract.overflowX).toBe('auto');
  expect(tableContract.firstCellPadding).toBeGreaterThanOrEqual(16);
  expect(tableContract.lastCellPadding).toBeGreaterThanOrEqual(16);

  await navigation.getByRole('button', { name: 'Rooms & staff', exact: true }).click();
  await page.getByRole('button', { name: 'Add room' }).click();
  const roomForm = page.locator('.director-form-panel').first();
  await expect(roomForm.locator('.director-panel-body')).toBeVisible();
  await expect(roomForm.locator('.director-panel-footer')).toBeVisible();
  await page.getByLabel('Room name').fill('Room 101');
  await page.getByRole('button', { name: 'Save room' }).click();
  await expect(page.locator('.director-filter-tabs')).toBeVisible();
  await expect(page.locator('.director-server-status')).toHaveAttribute('data-status', 'unavailable');

  await page.setViewportSize({ width: 520, height: 720 });
  await navigation.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(documentWidth).toBeLessThanOrEqual(521);
});

test('Director runs a local tournament slice and reopens its result', async ({ page }) => {
  await createTournament(page);

  await page
    .locator('nav[aria-label="Tournament sections"]')
    .getByRole('button', { name: 'Teams', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add team' }).click();
  await page.getByLabel('Display name').fill('Northview A');
  await page.getByLabel('School / organization').fill('Northview');
  await page.getByRole('button', { name: 'Save team' }).click();
  await page.getByRole('button', { name: 'Add team' }).click();
  await page.getByLabel('Display name').fill('Riverside A');
  await page.getByLabel('School / organization').fill('Riverside');
  await page.getByRole('button', { name: 'Save team' }).click();
  await expect(page.getByText('Northview A', { exact: true })).toBeVisible();
  await expect(page.getByText('Riverside A', { exact: true })).toBeVisible();

  await page
    .locator('nav[aria-label="Tournament sections"]')
    .getByRole('button', { name: 'Rooms & staff', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add room' }).click();
  await page.getByLabel('Room name').fill('Room 101');
  await page.getByRole('button', { name: 'Save room' }).click();

  await page
    .locator('nav[aria-label="Tournament sections"]')
    .getByRole('button', { name: 'Packets', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add packet' }).click();
  await page.getByLabel('Packet name').fill('Set A');
  await page.getByRole('button', { name: 'Save packet' }).click();

  await page
    .locator('nav[aria-label="Tournament sections"]')
    .getByRole('button', { name: 'Format', exact: true })
    .click();
  await page.getByRole('button', { name: 'Generate next round' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tournament control' })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare', exact: true }).click();
  await page.getByRole('button', { name: 'Release', exact: true }).click();

  await page
    .locator('nav[aria-label="Tournament sections"]')
    .getByRole('button', { name: /Results/ })
    .click();
  await page.getByRole('button', { name: 'Enter result' }).click();
  const scores = page.locator('input[type="number"]');
  await scores.nth(0).fill('210');
  await scores.nth(1).fill('180');
  await page.getByRole('button', { name: 'Accept manual result' }).click();

  await page
    .locator('nav[aria-label="Tournament sections"]')
    .getByRole('button', { name: 'Standings & stats', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 2, name: '2 teams' })).toBeVisible();
  await expect(page.getByText('Northview A', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Local Invitational' })).toBeVisible();
  await page
    .locator('nav[aria-label="Tournament sections"]')
    .getByRole('button', { name: 'Standings & stats', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 2, name: '2 teams' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '210', exact: true }).first()).toBeVisible();
});
