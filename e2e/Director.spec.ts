import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { assignmentDocument } from '../tests/qbjDocuments';

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

test('Director accepts a QBJ document even when its upload is named .json', async ({ page }) => {
  await page.goto('/director.html');
  await expect(page.getByRole('heading', { level: 2, name: 'Create or open a tournament' })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: 'tournament.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(assignmentDocument())),
  });

  await expect(page.getByRole('heading', { level: 1, name: 'Spring Invitational' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('QBJ tournament imported');
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
  await page.getByLabel('Accessibility notes').fill('Step-free entrance');
  await page.getByLabel('Directions').fill('East stairwell');
  await page.getByLabel('Room notes').fill('Bring the spare buzzer.');
  await page.getByRole('button', { name: 'Save room' }).click();
  await expect(page.getByText('Step-free entrance', { exact: true })).toBeVisible();
  await expect(page.getByText('East stairwell', { exact: true })).toBeVisible();
  await expect(page.getByText('Bring the spare buzzer.', { exact: true })).toBeVisible();
  await expect(page.locator('.director-filter-tabs')).toBeVisible();
  await expect(page.locator('.director-server-status')).toHaveAttribute('data-status', 'unavailable');
  await page.getByRole('tab', { name: /Offline/ }).click();
  await expect(page.getByText('No rooms match this filter.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show all rooms' }).click();
  await expect(page.getByText('Room 101', { exact: true })).toBeVisible();

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
  await page.getByLabel('Tiebreaker packet').check();
  await page.getByLabel('Notes').fill('Keep sealed until needed.');
  await page.getByRole('button', { name: 'Save packet' }).click();
  await expect(page.getByText('Tiebreaker', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Set A' }).click();
  const packetEditor = page.locator('.director-table-edit-row');
  await packetEditor.getByLabel('Packet name').fill('Set A final');
  await packetEditor.getByLabel('Notes').fill('Ready for the final round.');
  await packetEditor.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Set A final', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View details for Set A final' }).click();
  await expect(page.getByText('Ready for the final round.', { exact: true })).toBeVisible();

  await page
    .locator('nav[aria-label="Tournament sections"]')
    .getByRole('button', { name: 'Format', exact: true })
    .click();
  await page.getByRole('button', { name: 'Generate next round' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tournament control' })).toBeVisible();
  const navigation = page.locator('nav[aria-label="Tournament sections"]');
  await navigation.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare round', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Release assignments', exact: true })).toBeVisible();
  await navigation.getByRole('button', { name: 'Tournament', exact: true }).click();
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

test('Director edits scoring rules without persisting an incomplete numeric field', async ({ page }) => {
  await createTournament(page);

  const navigation = page.locator('nav[aria-label="Tournament sections"]');
  await navigation.getByRole('button', { name: 'Format', exact: true }).click();

  const bonusValue = page.getByLabel('Bonus value');
  await expect(bonusValue).toHaveValue('10');
  await bonusValue.fill('12');
  await bonusValue.blur();
  await expect(bonusValue).toHaveValue('12');

  const tossupValue = page.getByLabel('Tossup value');
  await tossupValue.fill('');
  await tossupValue.blur();
  await expect(page.getByRole('status').last()).toContainText('Tossup value must be a number.');

  await page.reload();
  await navigation.getByRole('button', { name: 'Format', exact: true }).click();
  await expect(page.getByLabel('Bonus value')).toHaveValue('12');
  await expect(page.getByLabel('Tossup value')).toHaveValue('10');
});

test('Director configures phases, advancement, and standings order', async ({ page }) => {
  await createTournament(page);

  const navigation = page.locator('nav[aria-label="Tournament sections"]');
  await navigation.getByRole('button', { name: 'Format', exact: true }).click();

  await page.getByLabel('Phase name').first().fill('Preliminary rankings');
  await page.getByLabel('Phase type').first().selectOption('preliminary');
  await page.getByLabel('Use an advancement rule').check();
  await page.getByLabel('Qualifiers from phase').fill('1');
  await page.getByLabel('Allow director override for unresolved ties').check();
  await page.getByRole('button', { name: 'Save phase settings' }).click();
  await expect(page.getByText('Preliminary rankings phase settings updated.')).toBeVisible();

  await page.getByRole('button', { name: 'Move Overall record up' }).click();
  await expect(page.getByRole('status')).toContainText('Overall record moved up');
  await expect(page.getByRole('button', { name: 'Move Overall record down' })).toBeVisible();

  await page.getByRole('button', { name: 'Add phase' }).click();
  const phaseForm = page.locator('.director-phase-add-form');
  await phaseForm.getByLabel('Phase name').fill('Playoffs');
  await phaseForm.getByLabel('Phase type').selectOption('playoff');
  await phaseForm.getByRole('button', { name: 'Save phase' }).click();
  await expect(page.getByText('Playoffs', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use', exact: true }).click();
  await expect(page.getByLabel('Phase name').first()).toHaveValue('Playoffs');
  await expect(page.getByLabel('Phase type').first()).toHaveValue('playoff');

  await page.reload();
  await navigation.getByRole('button', { name: 'Format', exact: true }).click();
  await expect(page.getByLabel('Phase name').first()).toHaveValue('Playoffs');
  await expect(page.getByText('Preliminary rankings', { exact: true })).toBeVisible();
});

test('Director supports keyboard search, inline edits, and audited result review', async ({ page }) => {
  await createTournament(page);

  const navigation = page.locator('nav[aria-label="Tournament sections"]');
  await navigation.getByRole('button', { name: 'Teams', exact: true }).click();
  await page.getByRole('button', { name: 'Add team' }).click();
  await page.getByLabel('Display name').fill('Northview A');
  await page.getByLabel('School / organization').fill('Northview High');
  await page.getByLabel('Notes').fill('Late check-in requested.');
  await page.getByRole('button', { name: 'Save team' }).click();
  await page.getByRole('button', { name: 'Add team' }).click();
  await page.getByLabel('Display name').fill('Riverside A');
  await page.getByLabel('School / organization').fill('Riverside High');
  await page.getByRole('button', { name: 'Save team' }).click();

  const search = page.getByPlaceholder('Search teams, rooms, games');
  await search.fill('Northview');
  await search.press('ArrowDown');
  await expect(search).toHaveAttribute('aria-activedescendant', 'director-search-result-0');
  await search.press('Enter');
  await expect(search).toHaveValue('');
  await expect(page.getByRole('heading', { level: 1, name: 'Teams' })).toBeVisible();

  await page.getByRole('button', { name: 'Edit Northview A' }).click();
  const teamEditor = page.locator('.director-table-edit-row');
  await teamEditor.getByLabel('Display name').fill('Northview B');
  await teamEditor.getByLabel('Team letter').fill('B');
  await teamEditor.getByLabel('Notes').fill('Seeded from the registration desk.');
  await teamEditor.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Northview B', { exact: true })).toBeVisible();
  await expect(page.getByText('Seeded from the registration desk.', { exact: true })).toBeVisible();

  const northviewRow = page.locator('tr').filter({ hasText: 'Northview B' }).first();
  await northviewRow.getByText('0 players', { exact: true }).click();
  await page.getByLabel('Add player to Northview B').fill('Ada Lovelace');
  await northviewRow.getByLabel('Captain').check();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await northviewRow.getByRole('button', { name: 'Edit Ada Lovelace' }).click();
  const playerEditor = page.locator('.director-roster-player-edit');
  await playerEditor.getByLabel('Roster number').fill('07');
  await playerEditor.getByLabel('Notes').fill('Late arrival.');
  await playerEditor.getByRole('button', { name: 'Save player' }).click();
  await expect(northviewRow).toContainText('Roster 07');
  await expect(northviewRow).toContainText('Late arrival.');
  await northviewRow.getByRole('button', { name: 'Remove Ada Lovelace from Northview B' }).click();
  await expect(northviewRow).toContainText('0 active · 1 inactive');
  await northviewRow.getByRole('button', { name: 'Restore Ada Lovelace to Northview B' }).click();
  await expect(northviewRow).toContainText('1 player');

  await navigation.getByRole('button', { name: 'Format', exact: true }).click();
  await page.getByRole('button', { name: 'Generate next round' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tournament control' })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare', exact: true }).click();
  await page.getByRole('button', { name: 'Release', exact: true }).click();

  await navigation.getByRole('button', { name: /Results/ }).click();
  await page.getByRole('button', { name: 'Enter result' }).click();
  const scores = page.locator('input[type="number"]');
  await scores.nth(0).fill('210');
  await scores.nth(1).fill('180');
  await page.getByRole('button', { name: 'Accept manual result' }).click();

  await page.getByRole('button', { name: 'Correct result' }).click();
  const correction = page.locator('.director-result-action-panel').first();
  await correction.locator('input[type="number"]').nth(0).fill('');
  await correction.getByRole('button', { name: 'Save correction' }).click();
  await expect(correction).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Corrected scores must be finite whole numbers.');
  await correction.locator('input[type="number"]').nth(0).fill('215');
  await correction.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.locator('.director-score-cell').filter({ hasText: '215–180' }).last()).toBeVisible();

  await page.getByRole('button', { name: 'Open protest' }).click();
  const protest = page.locator('.director-result-action-panel').first();
  await protest.getByLabel('Description').fill('Verify the tossup ruling.');
  await protest.getByRole('button', { name: 'Open protest', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Protests' })).toBeVisible();
  const ruling = page.locator('.director-protest-ruling').first();
  await ruling.getByLabel('Ruling').fill('Ruling confirmed by the director.');
  await ruling.getByRole('button', { name: 'Rule protest' }).click();
  await expect(page.locator('.director-protest-row').first()).toContainText('ruled');
});

test('Director opens every indexed search entity at its exact operational target', async ({ page }) => {
  await createTournament(page);
  const navigation = page.locator('nav[aria-label="Tournament sections"]');

  await navigation.getByRole('button', { name: 'Teams', exact: true }).click();
  await page.getByRole('button', { name: 'Add team' }).click();
  await page.getByLabel('Display name').fill('Northview A');
  await page.getByLabel('School / organization').fill('Northview High');
  await page.getByRole('button', { name: 'Save team' }).click();
  await page.getByRole('button', { name: 'Add team' }).click();
  await page.getByLabel('Display name').fill('Riverside A');
  await page.getByRole('button', { name: 'Save team' }).click();

  const northviewRow = page.locator('tr').filter({ hasText: 'Northview A' }).first();
  await northviewRow.getByText('0 players', { exact: true }).click();
  await page.getByLabel('Add player to Northview A').fill('Ada Lovelace');
  await northviewRow.getByRole('button', { name: 'Add', exact: true }).click();

  await navigation.getByRole('button', { name: 'Rooms & staff', exact: true }).click();
  await page.getByRole('button', { name: 'Add room' }).click();
  await page.getByLabel('Room name').fill('Room 101');
  await page.getByRole('button', { name: 'Save room' }).click();

  await navigation.getByRole('button', { name: 'Packets', exact: true }).click();
  await page.getByRole('button', { name: 'Add packet' }).click();
  await page.getByLabel('Packet name').fill('Set A');
  await page.getByRole('button', { name: 'Save packet' }).click();

  const search = page.getByPlaceholder('Search teams, rooms, games');
  const select = async (query: string, resultText: string | RegExp) => {
    await search.fill(query);
    const result = page.getByRole('option').filter({ hasText: resultText }).first();
    await expect(result).toBeVisible();
    await result.click();
    await expect(search).toHaveValue('');
  };

  await select('Northview A', 'Northview A');
  const selectedTeam = page
    .locator('tr[data-director-navigation-id]')
    .filter({ hasText: 'Northview A' })
    .first();
  await expect(selectedTeam).toHaveClass(/is-navigation-target/);
  await expect(selectedTeam.locator('[data-director-navigation-focus]')).toBeFocused();

  await select('Ada Lovelace', 'Ada Lovelace');
  const selectedPlayer = page
    .locator('li[data-director-navigation-id]')
    .filter({ hasText: 'Ada Lovelace' })
    .first();
  await expect(selectedPlayer).toHaveClass(/is-navigation-target/);
  await expect(selectedPlayer).toBeFocused();
  await expect(northviewRow.locator('details')).toHaveAttribute('open', '');

  await select('Room 101', 'Room 101');
  const selectedRoom = page
    .locator('tr[data-director-navigation-id]')
    .filter({ hasText: 'Room 101' })
    .first();
  await expect(selectedRoom).toHaveClass(/is-navigation-target/);
  await expect(selectedRoom.locator('[data-director-navigation-focus]')).toBeFocused();

  await select('Set A', 'Set A');
  const selectedPacket = page.locator('tr[data-director-navigation-id]').filter({ hasText: 'Set A' }).first();
  await expect(selectedPacket).toHaveClass(/is-navigation-target/);
  await expect(selectedPacket.locator('[data-director-navigation-focus]')).toBeFocused();
  await expect(page.getByRole('region', { name: 'Set A details' })).toBeVisible();

  await navigation.getByRole('button', { name: 'Format', exact: true }).click();
  await page.getByRole('button', { name: 'Generate next round' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tournament control' })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare', exact: true }).click();
  await page.getByRole('button', { name: 'Release', exact: true }).click();

  await navigation.getByRole('button', { name: /Results/ }).click();
  const gameId = await page
    .locator('section')
    .filter({ hasText: 'Scheduled games' })
    .locator('tbody tr')
    .first()
    .locator('small')
    .innerText();
  await select(gameId, /Northview A.*Riverside A/);
  const selectedGame = page.locator(`[data-director-navigation-id="${gameId}"]`);
  await expect(selectedGame).toHaveClass(/is-navigation-target/);
  await expect(selectedGame.locator('[data-director-navigation-focus]')).toBeFocused();
});

test('Director Help opens from both controls, owns focus, and restores the exact invoker', async ({
  page,
}) => {
  await createTournament(page);
  const sidebarHelp = page.getByRole('button', { name: 'Help & keyboard shortcuts', exact: true });
  await sidebarHelp.focus();
  await sidebarHelp.click();
  const dialog = page.getByRole('dialog', { name: 'Help & keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  for (const shortcut of [
    'Focus tournament search',
    'Move active search result',
    'Open active search result',
    'Close search / dialog',
  ]) {
    await expect(dialog.getByText(shortcut, { exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(sidebarHelp).toBeFocused();

  const topbarHelp = page.getByRole('button', { name: 'Help', exact: true });
  await topbarHelp.click();
  await expect(dialog).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(topbarHelp).toBeFocused();

  await page.keyboard.press('Control+k');
  await expect(page.getByPlaceholder('Search teams, rooms, games')).toBeFocused();
});

test('Director keeps unavailable resources out of new room assignments', async ({ page }) => {
  await createTournament(page);

  const navigation = page.locator('nav[aria-label="Tournament sections"]');
  await navigation.getByRole('button', { name: 'Rooms & staff', exact: true }).click();
  await page.getByRole('button', { name: 'Add staff' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Moderator One');
  await page.getByLabel('Notes').fill('Covers room checks.');
  await page.getByRole('button', { name: 'Save staff member' }).click();
  await page.getByRole('button', { name: 'Add equipment' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Buzzer One');
  await page.getByLabel('Notes').fill('Keep the spare cable nearby.');
  await page.getByRole('button', { name: 'Save equipment' }).click();

  await expect(page.getByRole('heading', { level: 2, name: /1 member · 1 available/ })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: /1 resource · 1 available/ })).toBeVisible();
  const staffPanel = page.locator('.director-two-column section').nth(0);
  await staffPanel.getByRole('button', { name: 'Edit' }).click();
  await staffPanel.getByLabel('Name').fill('Moderator Two');
  await staffPanel.getByLabel('Notes').fill('Also covers room checks.');
  await staffPanel.getByLabel('Runner').check();
  await staffPanel.getByRole('button', { name: 'Save changes' }).click();
  await expect(staffPanel).toContainText('Moderator Two');
  await expect(staffPanel).toContainText('Also covers room checks.');
  const equipmentPanel = page.locator('.director-two-column section').nth(1);
  await equipmentPanel.getByRole('button', { name: 'Edit' }).click();
  await equipmentPanel.getByLabel('Name').fill('Buzzer Two');
  await equipmentPanel.getByLabel('Notes').fill('Fully charged.');
  await equipmentPanel.getByLabel('Type').selectOption('device');
  await equipmentPanel.getByRole('button', { name: 'Save changes' }).click();
  await expect(equipmentPanel).toContainText('Buzzer Two');
  await expect(equipmentPanel).toContainText('Fully charged.');
  await page.getByRole('button', { name: 'Mark unavailable' }).nth(0).click();
  await page.getByRole('button', { name: 'Mark unavailable' }).nth(0).click();
  await expect(page.getByRole('heading', { level: 2, name: /1 member · 0 available/ })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: /1 resource · 0 available/ })).toBeVisible();

  await page.getByRole('button', { name: 'Add room' }).click();
  await page.getByLabel('Room name').fill('Room 101');
  await page.getByRole('button', { name: 'Save room' }).click();
  await page.locator('.director-table').getByRole('button', { name: 'Edit' }).click();
  const editor = page.locator('.director-table-edit-row');
  await expect(
    editor.locator('select').nth(0).locator('option').filter({ hasText: 'Moderator One' }),
  ).toHaveCount(0);
  await expect(
    editor.locator('select').nth(2).locator('option').filter({ hasText: 'Buzzer One' }),
  ).toHaveCount(0);
});

test('Director configures a pool format before generating its first round', async ({ page }) => {
  await createTournament(page);

  const navigation = page.locator('nav[aria-label="Tournament sections"]');
  await navigation.getByRole('button', { name: 'Teams', exact: true }).click();
  for (const team of ['Northview A', 'Riverside A', 'Lakeside A', 'Hillcrest A']) {
    await page.getByRole('button', { name: 'Add team' }).click();
    await page.getByLabel('Display name').fill(team);
    await page.getByRole('button', { name: 'Save team' }).click();
  }

  await navigation.getByRole('button', { name: 'Rooms & staff', exact: true }).click();
  for (const room of ['Room 101', 'Room 102']) {
    await page.getByRole('button', { name: 'Add room' }).click();
    await page.getByLabel('Room name').fill(room);
    await page.getByRole('button', { name: 'Save room' }).click();
  }

  await navigation.getByRole('button', { name: 'Format', exact: true }).click();
  await page.getByRole('combobox', { name: 'Format' }).selectOption('pools');
  await page.getByLabel('Number of pools').fill('2');
  await page.getByRole('button', { name: 'Create and distribute pools' }).click();
  await expect(page.locator('.director-pool-card').nth(0).locator('input')).toHaveValue('Pool A');
  await expect(page.locator('.director-pool-card').nth(1).locator('input')).toHaveValue('Pool B');
  await expect(page.getByText('All confirmed teams are assigned exactly once.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate next round' })).toBeEnabled();

  await page.getByRole('button', { name: 'Generate next round' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tournament control' })).toBeVisible();
  await expect(page.getByText('Round 1', { exact: true })).toBeVisible();
});
