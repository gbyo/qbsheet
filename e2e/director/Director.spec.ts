/**
 * The Director user interface, in a real browser, driven through the Director application itself.
 *
 * # Why this spec is not in `e2e/` with the scorer's
 *
 * It used to be, and it opened `/director.html` on the root website's dev server — an entry that
 * existed on the deployed site as well, and which the site no longer has. Director is a desktop
 * application: `apps/director` is the real Vite application, its `index.html` is the real entry, and
 * its Tauri shell loads that same build. So the coverage moved rather than being dropped, and it now
 * drives the application under test at its own root on its own configured port (1420). See
 * `playwright.director.config.ts`.
 *
 * What this spec covers is the Director UI as web technology, which is what the Tauri window renders.
 * The native half — the SQLite store, the QBTCP listener, the file dialogs — is covered separately;
 * `apps/director/src/native.test.ts` and the Rust crate's own tests own that side, and a browser
 * cannot exercise it, which `TournamentView` says on screen rather than pretending otherwise.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { assignmentDocument } from '../../tests/qbjDocuments';

async function createTournament(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 2, name: 'Create or open a tournament' })).toBeVisible();
  await page.getByLabel('Tournament name').fill('Local Invitational');
  await page.getByLabel('Venue').fill('Main building');
  await page.getByLabel('Organizer').fill('Director');
  await page.getByRole('button', { name: 'Create tournament' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Local Invitational' })).toBeVisible();
}

async function goToSection(page: Page, name: string) {
  // Tournament tools remain in the sidebar. App settings use the existing operator menu.
  const navigation = page.locator('nav[aria-label="Tournament sections"]');
  await expect(navigation.getByRole('button', { name: /More/ })).toHaveCount(0);
  if (name === 'Settings') {
    await page.getByRole('button', { name: /^Operator:/ }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  } else await navigation.getByRole('button', { name, exact: true }).click();
}

test('Director starts with an empty, persisted tournament workspace', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('QBSheet Director');
  await expect(page.getByRole('heading', { level: 2, name: 'Create or open a tournament' })).toBeVisible();

  await page.getByLabel('Tournament name').fill('Spring Invitational');
  await page.getByRole('button', { name: 'Create tournament' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Spring Invitational' })).toBeVisible();
  await expect(page.getByText('Build the tournament plan')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add teams' })).toBeVisible();
});

test('Director accepts a QBJ document even when its upload is named .json', async ({ page }) => {
  await page.goto('/');
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

  const teamForm = page.getByRole('dialog');
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
  await page.getByLabel('School / club').fill('Northview');
  await page.getByRole('dialog').getByRole('button', { name: 'Add team', exact: true }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Schools & clubs', exact: true }).click();
  const schools = page.getByRole('dialog', { name: 'Schools & clubs' });
  await schools.getByLabel('City').fill('Springfield');
  await schools.getByRole('button', { name: 'Save', exact: true }).click();
  await schools.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Schools & clubs', exact: true }).click();
  await expect(schools.getByLabel('City')).toHaveValue('Springfield');
  await schools.getByRole('button', { name: 'Done' }).click();

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

  await goToSection(page, 'Rooms & staff');
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
  const offlineFilter = page.getByRole('button', { name: /Offline/ });
  await expect(offlineFilter).toHaveAttribute('aria-pressed', 'false');
  await offlineFilter.click();
  await expect(offlineFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('No rooms match this filter.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show all rooms' }).click();
  await expect(page.getByText('Room 101', { exact: true })).toBeVisible();

  await goToSection(page, 'Settings');
  await page.setViewportSize({ width: 520, height: 720 });
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(521);
  await navigation.getByRole('button', { name: 'Teams', exact: true }).click();
  await page.getByRole('button', { name: 'Add team' }).click();
  await expect(page.getByLabel('Player 1 name')).toBeVisible();
  await page.getByRole('button', { name: 'Add player', exact: true }).click();
  await expect(page.getByLabel('Player 6 name')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(521);
});

test('Director runs a local tournament slice and reopens its result', async ({ page }) => {
  await createTournament(page);

  await page
    .locator('nav[aria-label="Tournament sections"]')
    .getByRole('button', { name: 'Teams', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add team' }).click();
  await page.getByLabel('Display name').fill('Northview A');
  await page.getByLabel('School / club').fill('Northview');
  await page.getByRole('dialog').getByRole('button', { name: 'Add team', exact: true }).click();
  await page.getByRole('button', { name: 'Add team' }).click();
  await page.getByLabel('Display name').fill('Riverside A');
  await page.getByLabel('School / club').fill('Riverside');
  await page.getByRole('dialog').getByRole('button', { name: 'Add team', exact: true }).click();
  await expect(page.getByText('Northview A', { exact: true })).toBeVisible();
  await expect(page.getByText('Riverside A', { exact: true })).toBeVisible();

  await goToSection(page, 'Rooms & staff');
  await page.getByRole('button', { name: 'Add room' }).click();
  await page.getByLabel('Room name').fill('Room 101');
  await page.getByRole('button', { name: 'Save room' }).click();

  await goToSection(page, 'Packets');
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

  await goToSection(page, 'Format');
  await page.getByRole('button', { name: 'Generate next round' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tournament day' })).toBeVisible();
  await page.getByRole('button', { name: /^Start Round/ }).click();
  await expect(page.getByRole('status')).toContainText('started');

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
    .getByRole('button', { name: 'Stats', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 2, name: '2 teams' })).toBeVisible();
  await expect(page.getByText('Northview A', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Local Invitational' })).toBeVisible();
  await page
    .locator('nav[aria-label="Tournament sections"]')
    .getByRole('button', { name: 'Stats', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 2, name: '2 teams' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '210', exact: true }).first()).toBeVisible();
});

test('Director edits scoring rules without persisting an incomplete numeric field', async ({ page }) => {
  await createTournament(page);

  await goToSection(page, 'Format');

  const bonusValue = page.getByLabel('Bonus value');
  await expect(bonusValue).toHaveValue('10');
  await bonusValue.fill('12');
  await bonusValue.blur();
  await expect(bonusValue).toHaveValue('12');

  const tossupValue = page.getByLabel('Tossup value');
  await tossupValue.fill('');
  await tossupValue.blur();
  await expect(page.getByRole('alert').last()).toContainText('Tossup value must be a number.');

  await page.reload();
  await goToSection(page, 'Format');
  await expect(page.getByLabel('Bonus value')).toHaveValue('12');
  await expect(page.getByLabel('Tossup value')).toHaveValue('10');
});

test('Director configures stages, advancement, and standings order', async ({ page }) => {
  await createTournament(page);

  await goToSection(page, 'Format');

  // One implicit stage is the tournament itself: no stage machinery.
  await expect(page.getByRole('heading', { name: 'Single stage' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Stage settings' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Plan sequence' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Add playoff stage' }).click();
  const stageForm = page.locator('.director-phase-add-form');
  await expect(stageForm.getByLabel('Stage name')).toHaveValue('Playoffs');
  await stageForm.getByLabel('Stage type').selectOption('playoff');
  await stageForm.getByRole('button', { name: 'Save stage' }).click();
  await expect(page.getByText('Playoffs', { exact: true })).toBeVisible();

  // The second stage reveals stage navigation and settings, still pointed at
  // the original stage. Configure advancement out of it.
  await expect(page.getByRole('heading', { name: 'Plan sequence' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Stage settings' })).toBeVisible();
  await page.getByLabel('Stage name').first().fill('Preliminary rankings');
  await page.getByLabel('Stage type').first().selectOption('preliminary');
  await page.getByLabel('Use an advancement rule').check();
  await page.getByLabel('Qualifiers from stage').fill('1');
  await page.getByLabel('Allow director override for unresolved ties').check();
  await page.getByRole('button', { name: 'Save stage settings' }).click();
  await expect(page.getByText('Preliminary rankings stage settings updated.')).toBeVisible();

  await page.getByRole('button', { name: 'Move Overall record up' }).click();
  await expect(page.getByRole('status')).toContainText('Overall record moved up');
  await expect(page.getByRole('button', { name: 'Move Overall record down' })).toBeVisible();

  // Switching stages repoints settings at the playoff stage.
  await page.getByRole('button', { name: 'Use', exact: true }).click();
  await expect(page.getByLabel('Stage name').first()).toHaveValue('Playoffs');
  await expect(page.getByLabel('Stage type').first()).toHaveValue('playoff');

  // Persistence is an async queue: wait until the stage selection has landed in
  // IndexedDB before reloading, or the reload can win the race and restore the
  // previous current stage.
  await page.waitForFunction(async () => {
    interface PersistedPhase {
      id: string;
      name: string;
    }
    interface PersistedDocument {
      state?: {
        phases?: PersistedPhase[];
        tournament?: { currentPhaseId: string | null } | null;
      };
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('qbsheet-director');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const records = await new Promise<PersistedDocument[]>((resolve, reject) => {
        const tx = db.transaction('tournament-documents', 'readonly');
        const req = tx.objectStore('tournament-documents').getAll();
        req.onsuccess = () => resolve((req.result ?? []) as PersistedDocument[]);
        req.onerror = () => reject(req.error);
      });
      return records.some((record) => {
        const playoff = (record.state?.phases ?? []).find((phase) => phase.name === 'Playoffs');
        return Boolean(playoff && record.state?.tournament?.currentPhaseId === playoff.id);
      });
    } finally {
      db.close();
    }
  });

  await page.reload();
  await goToSection(page, 'Format');
  await expect(page.getByLabel('Stage name').first()).toHaveValue('Playoffs');
  await expect(page.getByText('Preliminary rankings', { exact: true })).toBeVisible();
});

test('Director supports keyboard search, inline edits, and audited result review', async ({ page }) => {
  await createTournament(page);

  const navigation = page.locator('nav[aria-label="Tournament sections"]');
  await navigation.getByRole('button', { name: 'Teams', exact: true }).click();
  await page.getByRole('button', { name: 'Add team' }).click();
  await page.getByLabel('School / club').fill('Northview High');
  await page.getByLabel('Team letter').fill('A');
  await expect(page.getByLabel('Display name')).toHaveValue('Northview High A');
  await page.getByLabel('Display name').fill('Northview A');
  const teamDialog = page.getByRole('dialog');
  await teamDialog.getByLabel('Notes', { exact: true }).fill('Late check-in requested.');
  await teamDialog.getByLabel('Paste player names').fill('Alice Smith\nBob Jones\nCharlie Lee\nDana Patel');
  await teamDialog.getByRole('button', { name: 'Add pasted names' }).click();
  await teamDialog.locator('.director-roster-entry-row').nth(5).getByLabel('Captain').check();
  await teamDialog.locator('.director-roster-entry-row').nth(5).getByLabel('Roster number').fill('07');
  await teamDialog.getByRole('button', { name: 'Add team', exact: true }).click();
  await expect(page.getByText('4 players', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add team' }).click();
  await page.getByLabel('Display name').fill('Riverside A');
  await page.getByLabel('School / club').fill('Riverside High');
  await page.getByRole('dialog').getByRole('button', { name: 'Add team', exact: true }).click();

  const search = page.getByPlaceholder('Search teams, rooms, games');
  await search.fill('Northview');
  await search.press('ArrowDown');
  await expect(search).toHaveAttribute('aria-activedescendant', 'director-search-result-0');
  await search.press('Enter');
  await expect(search).toHaveValue('');
  await expect(page.getByRole('heading', { level: 1, name: 'Teams' })).toBeVisible();

  const teamEditor = page.getByRole('dialog');
  await teamEditor.getByLabel('Display name').fill('Northview B');
  await teamEditor.getByLabel('Team letter').fill('B');
  await teamEditor.getByLabel('Notes', { exact: true }).fill('Seeded from the registration desk.');
  const playerEditor = teamEditor.locator('.director-roster-entry-row').first();
  await expect(playerEditor.getByLabel('Player 1 name')).toHaveValue('Alice Smith');
  await playerEditor.getByLabel('Roster number').fill('08');
  await playerEditor.getByLabel('Player notes').fill('Late arrival.');
  await playerEditor.getByLabel('Active', { exact: true }).uncheck();
  await teamEditor.getByRole('button', { name: 'Save changes' }).click();
  const northviewRow = page.locator('tr').filter({ hasText: 'Northview B' }).first();
  await expect(northviewRow).toContainText('3 players');
  await search.fill('Northview B');
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(teamEditor.getByLabel('Notes', { exact: true })).toHaveValue(
    'Seeded from the registration desk.',
  );
  await expect(playerEditor.getByLabel('Roster number')).toHaveValue('08');
  await expect(playerEditor.getByLabel('Player notes')).toHaveValue('Late arrival.');
  await expect(playerEditor.getByLabel('Active', { exact: true })).not.toBeChecked();
  await playerEditor.getByLabel('Active', { exact: true }).check();
  await teamEditor.getByRole('button', { name: 'Save changes' }).click();
  await expect(northviewRow).toContainText('4 players');

  await goToSection(page, 'Format');
  await page.getByRole('button', { name: 'Generate next round' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tournament day' })).toBeVisible();
  await page.getByRole('button', { name: /^Start Round/ }).click();
  await expect(page.getByRole('status')).toContainText('started');

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
  await page.getByLabel('School / club').fill('Northview High');
  await page.getByLabel('Player 1 name').fill('Ada Lovelace');
  await page.getByRole('dialog').getByRole('button', { name: 'Add team', exact: true }).click();
  await page.getByRole('button', { name: 'Add team' }).click();
  await page.getByLabel('Display name').fill('Riverside A');
  await page.getByRole('dialog').getByRole('button', { name: 'Add team', exact: true }).click();

  const northviewRow = page.locator('tr').filter({ hasText: 'Northview A' }).first();
  await expect(northviewRow.getByText('1 player', { exact: true })).toBeVisible();

  await goToSection(page, 'Rooms & staff');
  await page.getByRole('button', { name: 'Add room' }).click();
  await page.getByLabel('Room name').fill('Room 101');
  await page.getByRole('button', { name: 'Save room' }).click();

  await goToSection(page, 'Packets');
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
  const selectedTeam = page.getByRole('dialog');
  await expect(selectedTeam.getByLabel('Display name')).toHaveValue('Northview A');
  await selectedTeam.getByRole('button', { name: 'Cancel' }).click();
  await select('Ada Lovelace', 'Ada Lovelace');
  await expect(selectedTeam.getByLabel('Display name')).toHaveValue('Northview A');
  await expect(selectedTeam.getByLabel('Player 1 name')).toHaveValue('Ada Lovelace');
  await selectedTeam.getByRole('button', { name: 'Cancel' }).click();

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

  await goToSection(page, 'Format');
  await page.getByRole('button', { name: 'Generate next round' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tournament day' })).toBeVisible();
  await page.getByRole('button', { name: /^Start Round/ }).click();
  await expect(page.getByRole('status')).toContainText('started');

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

  await goToSection(page, 'Rooms & staff');
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
    await page.getByRole('dialog').getByRole('button', { name: 'Add team', exact: true }).click();
  }

  await goToSection(page, 'Rooms & staff');
  for (const room of ['Room 101', 'Room 102']) {
    await page.getByRole('button', { name: 'Add room' }).click();
    await page.getByLabel('Room name').fill(room);
    await page.getByRole('button', { name: 'Save room' }).click();
  }

  await goToSection(page, 'Format');
  await page.getByRole('combobox', { name: 'Format' }).selectOption('pools');
  await page.getByLabel('Number of pools').fill('2');
  await page.getByRole('button', { name: 'Create and distribute pools' }).click();
  await expect(page.locator('.director-pool-card').nth(0).locator('input')).toHaveValue('Pool A');
  await expect(page.locator('.director-pool-card').nth(1).locator('input')).toHaveValue('Pool B');
  await expect(page.getByText('All confirmed teams are assigned exactly once.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate next round' })).toBeEnabled();

  await page.getByRole('button', { name: 'Generate next round' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tournament day' })).toBeVisible();
  await expect(page.getByText('Round 1', { exact: true })).toBeVisible();
});

test('ten-team release rehearsal: rounds, lunch, assignments, one-action start, recovery and reload', async ({
  page,
}, testInfo) => {
  await createTournament(page);
  await goToSection(page, 'Teams');
  for (let number = 1; number <= 10; number++) {
    await page.getByRole('button', { name: 'Add team', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Display name').fill(`Team ${number}`);
    await dialog.getByRole('button', { name: 'Add team', exact: true }).click();
  }
  await goToSection(page, 'Format');
  await page.getByRole('button', { name: 'Use this plan', exact: true }).click();
  await expect(page.locator('.director-round')).toHaveCount(9);
  await expect(page.getByRole('button', { name: /Put Round .* on USB/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add event', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Lunch', exact: true }).click();
  for (let move = 0; move < 4; move++) await page.getByRole('button', { name: 'Move Lunch earlier' }).click();
  const dayOrder = () => page.locator('.director-day-sequence > li').allTextContents();
  await page.screenshot({ path: testInfo.outputPath('morning-rounds.png'), fullPage: true });
  await goToSection(page, 'Packets');
  await page.getByRole('button', { name: 'Add packet' }).click();
  await page.getByLabel('Packet name').fill('Morning packet');
  await page.getByRole('button', { name: 'Save packet' }).click();
  await goToSection(page, 'Rooms & staff');
  await page.getByRole('button', { name: 'Add room' }).click();
  await page.getByLabel('Room name').fill('USB room');
  await page.getByRole('button', { name: 'Save room' }).click();
  await goToSection(page, 'Rounds');
  const first = page.locator('.director-round').first();
  await first.getByRole('button', { name: 'Assign packet' }).click();
  await first.getByLabel('Packet for Round 1').selectOption({ label: 'Morning packet' });
  await expect(first).toContainText('Packet: Morning packet');
  await first.getByRole('button', { name: 'Assign rooms' }).click();
  await first.locator('select').first().selectOption({ label: 'USB room' });
  await first.getByRole('button', { name: 'Save rooms' }).click();
  await expect(first).toContainText('USB room');
  await first.getByRole('button', { name: 'Start Round 1', exact: true }).click();
  await expect(first).toContainText('5 results outstanding');
  await expect(first.getByRole('button', { name: 'Finish Round 1' })).toHaveCount(0);
  const ordered = await dayOrder();
  expect(ordered).toHaveLength(10);
  expect(ordered[4]).toContain('Round 5');
  expect(ordered[5]).toContain('Lunch');
  expect(ordered[6]).toContain('Round 6');
  await first.getByRole('button', { name: '5 results outstanding · Open Results' }).click();
  await expect(page.getByRole('combobox', { name: 'Round', exact: true })).not.toHaveValue('');
  await expect(page.locator('[data-director-navigation-id]')).toHaveCount(5);
  await goToSection(page, 'Settings');
  const recovery = page.getByRole('region', { name: 'Recovery' });
  await recovery.getByRole('button', { name: 'Create recovery point' }).click();
  await expect(recovery.getByText('Manual recovery point')).toBeVisible();
  await goToSection(page, 'Rounds');
  const last = page.locator('.director-round').last();
  await last.getByRole('button', { name: 'Details & recovery' }).click();
  let removalConfirmation = '';
  page.once('dialog', async (dialog) => {
    removalConfirmation = dialog.message();
    await dialog.accept();
  });
  await last.getByRole('button', { name: /Remove round/i }).click();
  await expect(page.locator('.director-round')).toHaveCount(8);
  // Removing a round discards accepted results too, and the confirmation has to say so.
  expect(removalConfirmation).toContain('any accepted results');
  expect(removalConfirmation).toContain('A recovery point will be created first.');
  await goToSection(page, 'Settings');
  // Accept first and assert afterwards. A handler that throws before `accept()` leaves the
  // modal up, and the click that opened it hangs until the test times out on the wrong thing.
  let restoreConfirmation = '';
  page.once('dialog', async (dialog) => {
    restoreConfirmation = dialog.message();
    await dialog.accept();
  });
  await recovery
    .locator('li')
    .filter({ hasText: 'Manual recovery point' })
    .getByRole('button', { name: 'Restore', exact: true })
    .click();
  expect(restoreConfirmation).toContain('A recovery point of the current state will be created first.');
  await expect(recovery.getByText(/Before restoring checkpoint from/)).toBeVisible();
  await page.reload();
  await goToSection(page, 'Rounds');
  await expect(page.locator('.director-round')).toHaveCount(9);
  await expect(page.locator('.director-round').first()).toContainText('5 results outstanding');
  const restored = await dayOrder();
  expect(restored[5]).toContain('Lunch');
  await page.screenshot({ path: testInfo.outputPath('restored-rounds.png'), fullPage: true });
  await goToSection(page, 'Settings');
  await expect(recovery.getByText('Manual recovery point')).toBeVisible();
  await expect(recovery.getByText(/Before restoring checkpoint from/)).toBeVisible();
});
