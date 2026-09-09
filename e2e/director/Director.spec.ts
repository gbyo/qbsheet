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

/**
 * The startup screen's single Create flow.
 *
 * Every test gets its own tournament name. The suite shares one IndexedDB
 * across tests, and a reload reopens the most recent document — so identically
 * named tournaments made "did this persist?" depend on which one came back.
 */
async function createTournament(page: Page, name = 'Local Invitational') {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Create a tournament' })).toBeVisible();
  await page.getByLabel('Tournament name').fill(name);
  await page.getByLabel('Venue').fill('Main building');
  await page.getByLabel('Organizer').fill('Director');
  await page.getByRole('button', { name: 'Create tournament' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(`^Tournament: ${name}`) })).toBeVisible();
}

/**
 * Every destination is in the sidebar, grouped `Plan / Run / Review`, and the
 * accessible name of each link carries its group — so a screen-reader user
 * hears the same structure a sighted operator reads. Settings is an ordinary
 * destination now rather than an operator-menu accident, and there is no
 * narrow-window "More" menu re-implementing navigation.
 */
async function goToSection(page: Page, name: string) {
  const navigation = page.locator('nav[aria-label="Director sections"]');
  await expect(navigation.getByRole('button', { name: /More/ })).toHaveCount(0);
  await navigation.getByRole('button', { name: new RegExp(`(^|: )${name}$`) }).click();
}

test('Director starts with an empty, persisted tournament workspace', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('QBSheet Director');
  await expect(page.getByRole('heading', { level: 1, name: 'Create a tournament' })).toBeVisible();

  await page.getByLabel('Tournament name').fill('Spring Invitational');
  await page.getByRole('button', { name: 'Create tournament' }).click();

  // The page names the destination; the tournament identifies itself in the
  // switcher and the supporting line rather than being the heading.
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Tournament: Spring Invitational/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up teams' })).toBeVisible();
});

test('Director accepts a QBJ document even when its upload is named .json', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Create a tournament' })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: 'tournament.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(assignmentDocument())),
  });

  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.locator('.director-toast')).toContainText('QBJ tournament imported');
});

test('Director layout keeps dialog, table, status, and narrow-window contracts', async ({ page }) => {
  await createTournament(page);

  const navigation = page.locator('nav[aria-label="Director sections"]');
  await navigation.getByRole('button', { name: /(^|: )Teams$/ }).click();
  await page.getByRole('button', { name: 'Add team' }).click();

  /*
   * Entity editing is a focused dialog everywhere in Director now, so the inset
   * contract is the dialog's: body and footer are distinct regions, and neither
   * the fields nor the footer actions run to the edge.
   */
  const teamForm = page.getByRole('dialog');
  await expect(teamForm.locator('.director-dialog-body')).toBeVisible();
  await expect(teamForm.locator('.director-dialog-footer')).toBeVisible();
  const teamFormInsets = await teamForm.evaluate((dialog) => {
    const box = dialog.getBoundingClientRect();
    const grid = dialog.querySelector('.director-form-grid')?.getBoundingClientRect();
    const action = dialog.querySelector('.director-dialog-footer .director-button')?.getBoundingClientRect();
    if (!grid || !action) throw new Error('Expected a form grid and footer action.');
    return {
      gridLeft: grid.left - box.left,
      gridRight: box.right - grid.right,
      actionLeft: action.left - box.left,
      actionRight: box.right - action.right,
    };
  });
  expect(teamFormInsets.gridLeft).toBeGreaterThanOrEqual(12);
  expect(teamFormInsets.gridRight).toBeGreaterThanOrEqual(12);
  expect(teamFormInsets.actionLeft).toBeGreaterThanOrEqual(12);
  expect(teamFormInsets.actionRight).toBeGreaterThanOrEqual(12);

  await page.getByLabel('Display name').fill('Northview A');
  await page.getByRole('combobox', { name: 'School / club' }).fill('Northview');
  await teamForm.locator('.director-dialog-footer').getByRole('button', { name: 'Add team' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Schools and clubs is its own management surface rather than a stray header action.
  await page.getByRole('button', { name: 'Schools & clubs' }).click();
  const schools = page.getByRole('dialog');
  await schools.getByLabel('Name').fill('Northview');
  await schools.getByRole('button', { name: 'Add', exact: true }).click();
  await schools.getByRole('button', { name: 'Northview', exact: true }).click();
  await schools.getByLabel('City').fill('Springfield');
  await schools.getByRole('button', { name: /^Save/ }).click();
  await schools.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Schools & clubs' }).click();
  await expect(page.getByRole('dialog').getByLabel('City')).toHaveValue('Springfield');
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();

  const tableContract = await page
    .locator('.director-table')
    .first()
    .evaluate((table) => {
      const wrap = table.parentElement;
      const firstCell = table.querySelector('th, td');
      const lastCell = table.querySelector('tr > :last-child');
      if (!wrap || !firstCell || !lastCell) throw new Error('Expected a Director table.');
      return {
        borderCollapse: getComputedStyle(table).borderCollapse,
        overflowX: getComputedStyle(wrap).overflowX,
        firstCellPadding: Number.parseFloat(getComputedStyle(firstCell).paddingLeft),
        lastCellPadding: Number.parseFloat(getComputedStyle(lastCell).paddingRight),
        // No table declares a min-width any more; column priority handles narrowing.
        minWidth: getComputedStyle(table).minWidth,
      };
    });
  expect(tableContract.borderCollapse).toBe('collapse');
  expect(tableContract.overflowX).toBe('auto');
  expect(tableContract.firstCellPadding).toBeGreaterThanOrEqual(14);
  expect(tableContract.lastCellPadding).toBeGreaterThanOrEqual(14);
  expect(['auto', '0px']).toContain(tableContract.minWidth);

  await goToSection(page, 'Operations');
  await page.getByRole('button', { name: 'Add room' }).click();
  const roomForm = page.getByRole('dialog');
  await expect(roomForm.locator('.director-dialog-body')).toBeVisible();
  await expect(roomForm.locator('.director-dialog-footer')).toBeVisible();
  await page.getByLabel('Room name').fill('Room 101');
  await page.getByLabel('Accessibility').fill('Step-free entrance');
  await page.getByLabel('Directions').fill('East stairwell');
  await page.getByLabel('Notes').fill('Bring the spare buzzer.');
  await roomForm.locator('.director-dialog-footer').getByRole('button', { name: 'Add room' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Wayfinding and notes are detail, not row chrome: one disclosure away.
  await page.getByRole('button', { name: /Room details & QBTCP/ }).click();
  await expect(page.getByText('Step-free entrance', { exact: false })).toBeVisible();
  await expect(page.getByText('East stairwell', { exact: false })).toBeVisible();
  await expect(page.getByText('Bring the spare buzzer.', { exact: false })).toBeVisible();

  /*
   * QBTCP is a dormant subsystem in a manual tournament, so the shell says
   * nothing about it at all — there is no permanent server panel in the sidebar
   * and no chip in the top bar.
   */
  await expect(page.locator('.director-server-status')).toHaveCount(0);
  await expect(page.locator('.director-now-chip')).toHaveCount(0);

  const roomFilter = page.getByRole('group', { name: 'Room filter' });
  const attention = roomFilter.getByRole('button', { name: /^Attention/ });
  await expect(attention).toHaveAttribute('aria-pressed', 'false');
  await attention.click();
  await expect(attention).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('No rooms match this filter.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show all rooms' }).click();
  await expect(page.getByText('Room 101', { exact: true })).toBeVisible();

  await goToSection(page, 'Settings');
  await page.setViewportSize({ width: 520, height: 720 });
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(521);

  // The narrow layout is the same tree behind a drawer, not a second menu.
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await navigation.getByRole('button', { name: /(^|: )Teams$/ }).click();
  await page.getByRole('button', { name: 'Add team' }).click();
  await expect(page.getByLabel('Player 1 name')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Add player' }).click();
  await expect(page.getByLabel('Player 6 name')).toBeFocused();
});

test('Director runs a local tournament slice and reopens its result', async ({ page }) => {
  await createTournament(page, 'Tournament Slice Invitational');

  /** Every entity is created in the shared dialog; the submit sits in its footer. */
  const submitDialog = (name: string) =>
    page.getByRole('dialog').locator('.director-dialog-footer').getByRole('button', { name });

  await goToSection(page, 'Teams');
  for (const [team, school] of [
    ['Northview A', 'Northview'],
    ['Riverside A', 'Riverside'],
  ]) {
    await page.getByRole('button', { name: 'Add team' }).click();
    await page.getByLabel('Display name').fill(team);
    await page.getByRole('combobox', { name: 'School / club' }).fill(school);
    await submitDialog('Add team').click();
  }
  await expect(page.getByText('Northview A', { exact: true })).toBeVisible();
  await expect(page.getByText('Riverside A', { exact: true })).toBeVisible();

  await goToSection(page, 'Operations');
  await page.getByRole('button', { name: 'Add room' }).click();
  await page.getByLabel('Room name').fill('Room 101');
  await submitDialog('Add room').click();

  await goToSection(page, 'Packets');
  await page.getByRole('button', { name: 'Add packet' }).click();
  await page.getByLabel('Packet name').fill('Set A');
  await page.getByRole('checkbox', { name: 'Tiebreaker packet' }).check();
  await page.getByLabel('Notes').fill('Keep sealed until needed.');
  await submitDialog('Add packet').click();
  await expect(page.getByText('Tiebreaker', { exact: false }).first()).toBeVisible();

  // Editing a packet is the same focused dialog as creating one, rather than a
  // row expanding into a form while its details appear below the whole table.
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByLabel('Packet name').fill('Set A final');
  await page.getByLabel('Notes').fill('Ready for the final round.');
  await submitDialog('Save changes').click();
  await expect(page.getByText('Set A final', { exact: true })).toBeVisible();

  /*
   * Generating the day belongs to Tournament day; Format configures the plan.
   * There is no second, differently named button for the same action.
   */
  await goToSection(page, 'Format');
  await expect(page.getByRole('button', { name: 'Generate next round' })).toHaveCount(0);
  await goToSection(page, 'Tournament day');
  await page.getByRole('button', { name: 'Add round' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tournament day' })).toBeVisible();
  await page
    .getByRole('button', { name: /^Start round/ })
    .first()
    .click();
  await expect(page.locator('.director-toast')).toContainText('started');

  await goToSection(page, 'Results');
  await page.getByRole('button', { name: 'Enter result' }).click();
  const scores = page.getByRole('dialog').locator('input[type="number"]');
  await scores.nth(0).fill('210');
  await scores.nth(1).fill('180');
  await submitDialog('Accept manual result').click();

  await goToSection(page, 'Standings');
  await expect(page.getByRole('button', { name: 'Teams 2' })).toBeVisible();
  await expect(page.getByText('Northview A', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await goToSection(page, 'Standings');
  await expect(page.getByRole('button', { name: 'Teams 2' })).toBeVisible();

  /*
   * The default table is rank, team, and record. Points for is a detailed
   * scoring column the operator opts into, which is how ten equally weighted
   * columns stopped being forced on everyone — so the persisted score is
   * checked after turning them on.
   */
  await expect(page.getByRole('cell', { name: '210', exact: true })).toHaveCount(0);
  await page.getByRole('switch', { name: 'Detailed scoring columns' }).click();
  await expect(page.getByRole('cell', { name: '210', exact: true }).first()).toBeVisible();
});

test('Director edits scoring rules without persisting an incomplete numeric field', async ({ page }) => {
  await createTournament(page, 'Scoring Rules Invitational');

  await goToSection(page, 'Format');

  // Scoring is a summary line on the page and a focused dialog to change it,
  // rather than a wall of numeric inputs on the destination itself.
  await page.getByRole('button', { name: 'Edit scoring rules' }).click();
  const dialog = page.getByRole('dialog');
  const save = dialog.locator('.director-dialog-footer').getByRole('button', { name: 'Save scoring rules' });

  const bonusValue = page.getByLabel('Bonus value');
  await expect(bonusValue).toHaveValue('10');
  await bonusValue.fill('12');

  // An incomplete field is refused on the field itself, not announced as a
  // toast that is gone by the time the operator looks at the input.
  const tossupValue = page.getByLabel('Tossup value');
  await tossupValue.fill('');
  await save.click();
  await expect(dialog).toBeVisible();
  await expect(tossupValue).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByText('Tossup value must be a number.')).toBeVisible();
  // A rejected save keeps the operator's other edits.
  await expect(bonusValue).toHaveValue('12');

  // Correcting it clears the error, and only then does the change commit.
  await tossupValue.fill('10');
  await expect(tossupValue).not.toHaveAttribute('aria-invalid', 'true');
  await save.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await waitForPersisted(
    page,
    'Scoring Rules Invitational',
    (state) =>
      (state as { tournament?: { rules?: { bonusValue?: number } } }).tournament?.rules?.bonusValue === 12,
  );
  await page.reload();
  await expect(page.getByRole('button', { name: /^Tournament: Scoring Rules Invitational/ })).toBeVisible();
  await goToSection(page, 'Format');
  await page.getByRole('button', { name: 'Edit scoring rules' }).click();
  await expect(page.getByLabel('Bonus value')).toHaveValue('12');
  await expect(page.getByLabel('Tossup value')).toHaveValue('10');
});

/**
 * Wait until Director's save queue has written the open tournament.
 *
 * Persistence is asynchronous, so a `page.reload()` issued straight after an
 * edit can beat the write and read back the previous document. The stage test
 * already waited on IndexedDB for this reason; this is the same wait, expressed
 * once, for any predicate over the stored state.
 */
async function waitForPersisted(page: Page, name: string, check: (state: unknown) => boolean) {
  await page.waitForFunction(
    async ([tournamentName, source]) => {
      const predicate = new Function('return ' + source)() as (state: unknown) => boolean;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('qbsheet-director');
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      try {
        const records = await new Promise<{ state?: { tournament?: { name?: string } } }[]>(
          (resolve, reject) => {
            const tx = db.transaction('tournament-documents', 'readonly');
            const request = tx.objectStore('tournament-documents').getAll();
            request.onsuccess = () => resolve(request.result ?? []);
            request.onerror = () => reject(request.error);
          },
        );
        return records.some(
          (record) => record.state?.tournament?.name === tournamentName && predicate(record.state),
        );
      } finally {
        db.close();
      }
    },
    [name, check.toString()] as const,
  );
}

/** Stage machinery lives behind a disclosure; open it if it is not already. */
async function openStages(page: Page) {
  const stages = page.getByRole('button', { name: /Stages & advancement/ });
  if ((await stages.getAttribute('aria-expanded')) !== 'true') await stages.click();
}

test('Director configures stages, advancement, and standings order', async ({ page }) => {
  await createTournament(page, 'Stages Invitational');

  await goToSection(page, 'Format');

  /*
   * One implicit stage is the tournament itself, so the page says nothing about
   * stages at all: no stage list, no per-stage settings, and no "phase" in any
   * copy. The capability is one disclosure away, and the disclosure explains
   * why it is not needed.
   */
  await expect(page.getByRole('heading', { name: 'Tournament stage' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /^Selected stage/ })).toHaveCount(0);
  const stages = page.getByRole('button', { name: /Stages & advancement/ });
  await expect(stages).toHaveAttribute('aria-expanded', 'false');
  await stages.click();

  const dialogFooter = () => page.getByRole('dialog').locator('.director-dialog-footer');
  await page.getByRole('button', { name: 'Add playoff stage' }).click();
  await expect(page.getByLabel('Stage name')).toHaveValue('Playoffs');
  await dialogFooter().getByRole('button', { name: 'Add stage' }).click();
  await expect(page.getByText('Playoffs', { exact: true }).first()).toBeVisible();

  // A second stage means the tournament now has stages, so the section is open
  // on arrival and the per-stage settings appear beside the sequence.
  await page.reload();
  await goToSection(page, 'Format');
  await expect(page.getByRole('button', { name: /Stages & advancement/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.getByRole('heading', { name: 'Stage sequence' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Selected stage/ })).toBeVisible();

  await page.getByLabel('Stage name').first().fill('Preliminary rankings');
  await page.getByRole('checkbox', { name: 'Use an advancement rule' }).check();
  await page.getByLabel(/^Qualifiers/).fill('1');
  await page.getByRole('checkbox', { name: 'Allow director override for unresolved ties' }).check();
  await page.getByRole('button', { name: 'Save stage settings' }).click();
  await expect(page.locator('.director-toast')).toContainText('stage settings updated');

  /*
   * Reordering the standings criteria is an explicit mode rather than a pair of
   * arrows on every row, and its keyboard route is the same capability as the
   * drag one.
   */
  await page.getByRole('button', { name: /Standings & tiebreakers/ }).click();
  await page.getByRole('button', { name: 'Reorder criteria' }).click();
  await page.getByRole('button', { name: 'Move Overall record earlier' }).click();
  await expect(page.locator('.director-toast')).toContainText('Overall record');
  await page.getByRole('button', { name: 'Done reordering' }).click();

  // Switching stages repoints the settings at the playoff stage.
  await openStages(page);
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Playoffs' })
    .getByRole('button', { name: 'Select' })
    .click();
  await openStages(page);
  await expect(page.getByLabel('Stage name').first()).toHaveValue('Playoffs');

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
  await expect(page.getByRole('button', { name: /Stages & advancement/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.getByLabel('Stage name').first()).toHaveValue('Playoffs');
  await expect(page.getByText('Preliminary rankings', { exact: true }).first()).toBeVisible();
});

test('Director supports keyboard search, inline edits, and audited result review', async ({ page }) => {
  await createTournament(page);

  const navigation = page.locator('nav[aria-label="Director sections"]');
  await navigation.getByRole('button', { name: /(^|: )Teams$/ }).click();
  await page.getByRole('button', { name: 'Schools & clubs' }).click();
  const schools = page.getByRole('dialog');
  await schools.getByLabel('Name').fill('Northview High');
  await schools.getByRole('button', { name: 'Add', exact: true }).click();
  await schools.getByRole('button', { name: 'Northview High', exact: true }).click();
  await schools.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Add team' }).click();
  await page.getByRole('combobox', { name: 'School / club' }).fill('Northview High');
  await page.getByRole('option', { name: /Northview High/ }).click();
  await page.getByLabel('Team letter').fill('A');
  await expect(page.getByLabel('Display name')).toHaveValue('Northview High A');
  await page.getByLabel('Display name').fill('Northview A');
  const teamDialog = page.getByRole('dialog');
  // Optional fields say so in their accessible name, and roster rows have their
  // own "Player N notes" — so the team field is matched by prefix.
  await teamDialog.getByLabel(/^Notes/).fill('Late check-in requested.');
  await teamDialog.getByLabel('Paste player names').fill('Alice Smith\nBob Jones\nCharlie Lee\nDana Patel');
  await teamDialog.getByRole('button', { name: 'Add pasted names' }).click();
  // Roster controls are named for the player they belong to.
  await teamDialog.getByRole('checkbox', { name: 'Player 6 captain' }).check();
  await teamDialog.getByLabel('Player 6 roster number').fill('07');
  await teamDialog.locator('.director-dialog-footer').getByRole('button', { name: 'Add team' }).click();
  await expect(page.getByText('4 players', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add team' }).click();
  await page.getByLabel('Display name').fill('Riverside A');
  await page.getByRole('combobox', { name: 'School / club' }).fill('Riverside High');
  await page
    .getByRole('dialog')
    .locator('.director-dialog-footer')
    .getByRole('button', { name: 'Add team' })
    .click();

  const search = page.getByPlaceholder('Search pages, settings, teams, rooms, rounds, games');
  await search.fill('Northview');
  /*
   * The best match is selected as soon as there is a query, so Enter runs the
   * obvious answer without a preparatory keystroke — arrow travel moves *off*
   * it rather than into it, and announces wherever it lands.
   */
  const firstResult = page.getByRole('option').first();
  await expect(firstResult).toHaveAttribute('aria-selected', 'true');
  await search.press('ArrowDown');
  await expect(search).toHaveAttribute('aria-activedescendant', /.+/);
  await search.press('ArrowUp');
  await expect(firstResult).toHaveAttribute('aria-selected', 'true');
  await search.press('Enter');
  await expect(search).toHaveValue('');
  await expect(page.getByRole('heading', { level: 1, name: 'Teams' })).toBeVisible();

  const teamEditor = page.getByRole('dialog');
  await teamEditor.getByLabel('Display name').fill('Northview B');
  await teamEditor.getByLabel('Team letter').fill('B');
  await teamEditor.getByLabel(/^Notes/).fill('Seeded from the registration desk.');
  await expect(teamEditor.getByLabel('Player 1 name')).toHaveValue('Alice Smith');
  await teamEditor.getByLabel('Player 1 roster number').fill('08');
  await teamEditor.getByLabel('Player 1 notes').fill('Late arrival.');
  await teamEditor.getByRole('checkbox', { name: 'Player 1 active' }).uncheck();
  await teamEditor.locator('.director-dialog-footer').getByRole('button', { name: 'Save changes' }).click();
  const northviewRow = page.locator('tr').filter({ hasText: 'Northview B' }).first();
  await expect(northviewRow).toContainText('3 players');
  await search.fill('Northview B');
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(teamEditor.getByLabel(/^Notes/)).toHaveValue('Seeded from the registration desk.');
  await expect(teamEditor.getByLabel('Player 1 roster number')).toHaveValue('08');
  await expect(teamEditor.getByLabel('Player 1 notes')).toHaveValue('Late arrival.');
  const activePlayer = teamEditor.getByRole('checkbox', { name: 'Player 1 active' });
  await expect(activePlayer).not.toBeChecked();
  await activePlayer.check();
  await teamEditor.locator('.director-dialog-footer').getByRole('button', { name: 'Save changes' }).click();
  await expect(northviewRow).toContainText('4 players');

  await goToSection(page, 'Tournament day');
  await page.getByRole('button', { name: 'Add round' }).click();
  await page
    .getByRole('button', { name: /^Start round/ })
    .first()
    .click();
  await expect(page.locator('.director-toast')).toContainText('started');

  const dialogFooter = () => page.getByRole('dialog').locator('.director-dialog-footer');
  await goToSection(page, 'Results');
  await page.getByRole('button', { name: 'Enter result' }).click();
  const scores = page.getByRole('dialog').locator('input[type="number"]');
  await scores.nth(0).fill('210');
  await scores.nth(1).fill('180');
  await dialogFooter().getByRole('button', { name: 'Accept manual result' }).click();

  /*
   * Correcting an accepted result and opening a protest are low-frequency
   * decisions, so they live in the submission's overflow menu and open the
   * shared focused dialog rather than expanding another panel into the page.
   */
  // A manual result is accepted immediately, so it is in History rather than
  // the review queue.
  await page.getByRole('button', { name: 'History' }).click();
  await page
    .getByRole('button', { name: /result actions$/ })
    .first()
    .click();
  await page.getByRole('option', { name: 'Correct accepted result…' }).click();
  const correction = page.getByRole('dialog');
  await correction.locator('input[type="number"]').nth(0).fill('');
  await dialogFooter().getByRole('button', { name: 'Save correction' }).click();
  await expect(correction).toBeVisible();
  await expect(page.locator('.director-toast')).toContainText(
    'Corrected scores must be finite whole numbers.',
  );
  await correction.locator('input[type="number"]').nth(0).fill('215');
  await dialogFooter().getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('215', { exact: false }).first()).toBeVisible();

  await page
    .getByRole('button', { name: /result actions$/ })
    .first()
    .click();
  await page.getByRole('option', { name: 'Open protest…' }).click();
  await page.getByRole('dialog').getByLabel('Description').fill('Verify the tossup ruling.');
  await dialogFooter().getByRole('button', { name: 'Open protest' }).click();

  // Protests are one of the four Results views, with the count on the control.
  await page.getByRole('button', { name: 'Protests 1' }).click();
  await page.getByRole('button', { name: 'Rule protest' }).first().click();
  await page.getByRole('dialog').getByLabel('Ruling').fill('Ruling confirmed by the director.');
  await dialogFooter().getByRole('button', { name: 'Save ruling' }).click();
  await expect(page.getByRole('list', { name: 'Protests' })).toContainText('Ruled');
});

test('Director opens every indexed search entity at its exact operational target', async ({ page }) => {
  await createTournament(page);
  const navigation = page.locator('nav[aria-label="Director sections"]');

  await navigation.getByRole('button', { name: /(^|: )Teams$/ }).click();
  await page.getByRole('button', { name: 'Add team' }).click();
  await page.getByLabel('Display name').fill('Northview A');
  await page.getByRole('combobox', { name: 'School / club' }).fill('Northview High');
  await page.getByLabel('Player 1 name').fill('Ada Lovelace');
  await page
    .getByRole('dialog')
    .locator('.director-dialog-footer')
    .getByRole('button', { name: 'Add team' })
    .click();
  await page.getByRole('button', { name: 'Add team' }).click();
  await page.getByLabel('Display name').fill('Riverside A');
  await page
    .getByRole('dialog')
    .locator('.director-dialog-footer')
    .getByRole('button', { name: 'Add team' })
    .click();

  const northviewRow = page.locator('tr').filter({ hasText: 'Northview A' }).first();
  await expect(northviewRow.getByText('1 player', { exact: true })).toBeVisible();

  const footerButton = (name: string) =>
    page.getByRole('dialog').locator('.director-dialog-footer').getByRole('button', { name });

  await goToSection(page, 'Operations');
  await page.getByRole('button', { name: 'Add room' }).click();
  await page.getByLabel('Room name').fill('Room 101');
  await footerButton('Add room').click();

  await goToSection(page, 'Packets');
  await page.getByRole('button', { name: 'Add packet' }).click();
  await page.getByLabel('Packet name').fill('Set A');
  await footerButton('Add packet').click();

  const search = page.getByPlaceholder('Search pages, settings, teams, rooms, rounds, games');
  const select = async (query: string, resultText: string | RegExp) => {
    await search.fill(query);
    const result = page.getByRole('option').filter({ hasText: resultText }).first();
    await expect(result).toBeVisible();
    await result.click();
    await expect(search).toHaveValue('');
  };

  /*
   * Global search is a navigator: every indexed entity opens at the thing
   * itself, not merely at the page that contains it. That contract is what the
   * redesign had to carry across unchanged.
   */
  await select('Northview A', 'Northview A');
  const selectedTeam = page.getByRole('dialog');
  await expect(selectedTeam.getByLabel('Display name')).toHaveValue('Northview A');
  await selectedTeam.getByRole('button', { name: 'Cancel' }).click();
  await select('Ada Lovelace', 'Ada Lovelace');
  await expect(selectedTeam.getByLabel('Display name')).toHaveValue('Northview A');
  await expect(selectedTeam.getByLabel('Player 1 name')).toHaveValue('Ada Lovelace');
  await selectedTeam.getByRole('button', { name: 'Cancel' }).click();

  // Rooms are a summary list rather than a table row now.
  await select('Room 101', 'Room 101');
  const selectedRoom = page.getByRole('listitem').filter({ hasText: 'Room 101' }).first();
  await expect(selectedRoom).toHaveClass(/is-navigation-target/);
  await expect(selectedRoom.locator('[data-director-navigation-focus]')).toBeFocused();

  await select('Set A', 'Set A');
  const selectedPacket = page.getByRole('listitem').filter({ hasText: 'Set A' }).first();
  await expect(selectedPacket).toHaveClass(/is-navigation-target/);
  await expect(selectedPacket.locator('[data-director-navigation-focus]')).toBeFocused();

  await goToSection(page, 'Tournament day');
  await page.getByRole('button', { name: 'Add round' }).click();
  await page
    .getByRole('button', { name: /^Start round/ })
    .first()
    .click();
  await expect(page.locator('.director-toast')).toContainText('started');

  /*
   * A game's raw id is diagnostic detail rather than participant-facing
   * context, so the row no longer prints it — the deep link is checked through
   * the id the row carries for exactly that purpose.
   */
  await goToSection(page, 'Results');
  await page.getByRole('button', { name: /^Games/ }).click();
  const gameId = await page
    .getByRole('list', { name: 'Scheduled games' })
    .getByRole('listitem')
    .first()
    .locator('[data-director-navigation-id]')
    .getAttribute('data-director-navigation-id');
  await select(gameId ?? '', /Northview A.*Riverside A/);
  const selectedGame = page.locator(`[data-director-navigation-id="${gameId}"]`);
  await expect(selectedGame).toBeFocused();

  /*
   * Destinations and settings are in the same index as the entities. An operator
   * who types "timezone" is not asked to know first that it lives in Settings,
   * behind the General sub-section, in the Tournament details panel — and a
   * mistyped query still lands, which a substring match could never do.
   */
  await select('standings', /^Standings/);
  await expect(page.getByRole('heading', { level: 1, name: 'Standings' })).toBeVisible();

  await select('timezone', /^Tournament timezone/);
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  // The zone field is a Combobox, so arriving on it opens its list — the label
  // names both the input and the popover, hence the explicit role.
  await expect(page.getByRole('combobox', { name: 'Tournament timezone' })).toBeFocused();

  /*
   * `^Recovery` and not `Recovery`: the Settings *page* describes itself as
   * holding "storage, recovery, and audit history", so a loose text filter
   * would pick the page over the panel the query is actually reaching for.
   */
  await select('recovry', /^Recovery/);
  await expect(page.getByRole('button', { name: 'Create recovery point' })).toBeFocused();
});

test('Director Help has one entry, owns focus, and restores the exact invoker', async ({ page }) => {
  await createTournament(page);

  /*
   * Help used to be reachable from a sidebar link *and* a top-bar button. Global
   * actions now have one home each: Help belongs to the operator menu, with
   * operator identity and Settings.
   */
  await expect(page.getByRole('button', { name: 'Help', exact: true })).toHaveCount(0);

  const operator = page.getByRole('button', { name: /^Operator:/ });
  await operator.focus();
  await operator.click();
  await page.getByRole('option', { name: 'Help & keyboard shortcuts' }).click();

  const dialog = page.getByRole('dialog', { name: 'Help & keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  for (const shortcut of [
    'Focus tournament search',
    'Move active search result',
    'Open active search result',
    'Close search, menu, or dialog',
  ]) {
    await expect(dialog.getByText(shortcut, { exact: true })).toBeVisible();
  }

  // The keycap names this platform's modifier rather than hedging with "⌘/Ctrl".
  /*
   * The keycap names one platform's modifier rather than hedging with the
   * literal "⌘/Ctrl" the table used to print. Which one depends on the browser
   * — Playwright's Desktop Chrome reports a Windows user agent — so the
   * assertion is that exactly one convention is shown, never both.
   */
  const shortcuts = dialog.locator('.director-help-shortcuts');
  await expect(shortcuts).not.toContainText('⌘/Ctrl');
  const shortcutText = (await shortcuts.textContent()) ?? '';
  expect(shortcutText.includes('⌘') !== shortcutText.includes('Ctrl')).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(operator).toBeFocused();

  await page.keyboard.press('Control+k');
  await expect(page.getByPlaceholder('Search pages, settings, teams, rooms, rounds, games')).toBeFocused();
});

test('Director keeps unavailable resources out of new room assignments', async ({ page }) => {
  await createTournament(page);

  const footerButton = (name: string) =>
    page.getByRole('dialog').locator('.director-dialog-footer').getByRole('button', { name });
  const view = (name: RegExp) => page.getByRole('button', { name });

  /*
   * Staff and equipment are peer views of the logistics workspace rather than
   * panels stacked under the room table, and all three use the same dialog to
   * create and edit.
   */
  await goToSection(page, 'Operations');
  await view(/^Staff/).click();
  await page.getByRole('button', { name: 'Add staff' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Moderator One');
  await page
    .getByRole('dialog')
    .getByLabel(/^Notes/)
    .fill('Covers room checks.');
  await footerButton('Add staff member').click();

  await view(/^Equipment/).click();
  await page.getByRole('button', { name: 'Add equipment' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Buzzer One');
  await page
    .getByRole('dialog')
    .getByLabel(/^Notes/)
    .fill('Keep the spare cable nearby.');
  await footerButton('Add equipment').click();

  // Editing is the same dialog, and multi-role staff keep the shared checkboxes.
  await view(/^Staff/).click();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Moderator One' })
    .getByRole('button', { name: 'Edit' })
    .click();
  await page.getByRole('dialog').getByLabel('Name').fill('Moderator Two');
  await page.getByRole('dialog').getByRole('checkbox', { name: 'Runner' }).check();
  await footerButton('Save changes').click();
  await expect(page.getByText('Moderator Two').first()).toBeVisible();

  // Maintenance actions are in the row's overflow menu, not permanent chrome.
  await page.getByRole('button', { name: /Moderator Two actions/ }).click();
  await page.getByRole('option', { name: 'Mark unavailable' }).click();
  await expect(page.getByText('Unavailable').first()).toBeVisible();

  await view(/^Equipment/).click();
  await page.getByRole('button', { name: /Buzzer One actions/ }).click();
  await page.getByRole('option', { name: 'Mark unavailable' }).click();

  /*
   * The point of the test: a resource marked unavailable is not offered for a
   * new room assignment. The pickers are the shared Select, whose options exist
   * only while it is open.
   */
  await view(/^Rooms/).click();
  await page.getByRole('button', { name: 'Add room' }).click();
  await page.getByLabel('Room name').fill('Room 101');
  await footerButton('Add room').click();

  await page
    .getByRole('listitem')
    .filter({ hasText: 'Room 101' })
    .getByRole('button', { name: 'Edit' })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Moderator' }).click();
  await expect(page.getByRole('option').filter({ hasText: 'Moderator Two' })).toHaveCount(0);
  await dialog.getByRole('combobox', { name: 'Moderator' }).click();
  await dialog.getByRole('combobox', { name: 'Equipment' }).click();
  await expect(page.getByRole('option').filter({ hasText: 'Buzzer One' })).toHaveCount(0);
});

test('Director configures a pool format before generating its first round', async ({ page }) => {
  await createTournament(page);

  const footerButton = (name: string) =>
    page.getByRole('dialog').locator('.director-dialog-footer').getByRole('button', { name });

  await goToSection(page, 'Teams');
  for (const team of ['Northview A', 'Riverside A', 'Lakeside A', 'Hillcrest A']) {
    await page.getByRole('button', { name: 'Add team' }).click();
    await page.getByLabel('Display name').fill(team);
    await footerButton('Add team').click();
  }

  await goToSection(page, 'Operations');
  for (const room of ['Room 101', 'Room 102']) {
    await page.getByRole('button', { name: 'Add room' }).click();
    await page.getByLabel('Room name').fill(room);
    await footerButton('Add room').click();
  }

  /*
   * Pools are a tournament concept, so the pool controls appear because the
   * format now has pools — not because a mode was switched on.
   */
  await goToSection(page, 'Format');
  await expect(page.getByRole('heading', { name: 'Pools' })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Format' }).click();
  await page.getByRole('option', { name: /Preliminary pools/ }).click();
  await page.getByRole('button', { name: 'Save format' }).click();

  await expect(page.getByRole('heading', { name: 'Pools' })).toBeVisible();
  await page.getByLabel('Number of pools').fill('2');
  await page.getByRole('button', { name: 'Create and distribute pools' }).click();
  const poolNames = page.getByLabel('Pool name');
  await expect(poolNames).toHaveCount(2);
  await expect(poolNames.nth(0)).toHaveValue('Pool A');
  await expect(poolNames.nth(1)).toHaveValue('Pool B');
  await expect(page.getByText(/still need a pool/)).toHaveCount(0);

  // Generating the day belongs to Tournament day, not Format.
  await expect(page.getByRole('button', { name: 'Generate next round' })).toHaveCount(0);
  await goToSection(page, 'Tournament day');
  await page.getByRole('button', { name: 'Add round' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tournament day' })).toBeVisible();
  await expect(page.getByText('Round 1', { exact: false }).first()).toBeVisible();
});

/**
 * The tournament the product principles are written against: ten teams, rounds
 * 1–5, lunch, rounds 6–9. It should need no stage, pool, transport, or
 * state-machine vocabulary at any point.
 */
test('ten-team release rehearsal: rounds, lunch, assignments, one-action start, recovery and reload', async ({
  page,
}, testInfo) => {
  await createTournament(page, 'Release Rehearsal');
  const footerButton = (name: string) =>
    page.getByRole('dialog').locator('.director-dialog-footer').getByRole('button', { name });
  const days = () => page.getByRole('list', { name: 'Tournament day' }).getByRole('listitem');

  await goToSection(page, 'Teams');
  for (let number = 1; number <= 10; number++) {
    await page.getByRole('button', { name: 'Add team' }).click();
    await page.getByRole('dialog').getByLabel('Display name').fill(`Team ${number}`);
    await footerButton('Add team').click();
  }

  await goToSection(page, 'Format');
  await page.getByRole('button', { name: 'Use recommended plan' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tournament day' })).toBeVisible();
  await expect(days()).toHaveCount(9);

  // No USB drive is attached, so nothing anywhere mentions one.
  await expect(page.getByRole('button', { name: /USB/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Add event' }).click();
  // A common break is one press: the menu adds it rather than opening a form.
  await page.getByRole('option', { name: 'Lunch', exact: true }).click();
  await expect(days()).toHaveCount(10);

  /*
   * Reordering is an explicit mode rather than a pair of arrows on every row,
   * and the keyboard route is the same capability as dragging.
   */
  await page.getByRole('button', { name: 'Reorder day' }).click();
  for (let move = 0; move < 4; move++) {
    await page.getByRole('button', { name: 'Move Lunch earlier' }).click();
  }
  await page.getByRole('button', { name: 'Done reordering' }).click();
  const ordered = await days().allTextContents();
  expect(ordered).toHaveLength(10);
  expect(ordered[4]).toContain('Round 5');
  expect(ordered[5]).toContain('Lunch');
  expect(ordered[6]).toContain('Round 6');
  await page.screenshot({ path: testInfo.outputPath('morning-rounds.png'), fullPage: true });

  await goToSection(page, 'Packets');
  await page.getByRole('button', { name: 'Add packet' }).click();
  await page.getByLabel('Packet name').fill('Morning packet');
  await footerButton('Add packet').click();

  await goToSection(page, 'Operations');
  const roomNames = Array.from({ length: 5 }, (_, index) => `Main room ${index + 1}`);
  for (const roomName of roomNames) {
    await page.getByRole('button', { name: 'Add room' }).click();
    await page.getByLabel('Room name').fill(roomName);
    await footerButton('Add room').click();
  }

  /*
   * The round owns its packet and rooms, reached from the round itself — but
   * they are low-frequency, so they live in its overflow menu rather than
   * expanding raw selects into the row.
   */
  await goToSection(page, 'Tournament day');
  const firstRound = days().first();
  await firstRound.getByRole('button', { name: /Round 1 actions/ }).click();
  await page.getByRole('option', { name: 'Assign packet…' }).click();
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: /Packet/ })
    .click();
  await page.getByRole('option', { name: /Morning packet/ }).click();
  await footerButton('Save packet').click();
  await expect(firstRound).toContainText('Morning packet');

  await firstRound.getByRole('button', { name: /Round 1 actions/ }).click();
  await page.getByRole('option', { name: 'Assign rooms…' }).click();
  const roomDialog = page.getByRole('dialog');
  const roomAssignments = roomDialog.getByRole('combobox');
  await expect(roomAssignments).toHaveCount(roomNames.length);
  for (let index = 0; index < roomNames.length; index++) {
    await roomAssignments.nth(index).click();
    await page.getByRole('option', { name: roomNames[index], exact: true }).click();
  }
  await footerButton('Save rooms').click();
  await expect(firstRound).toContainText(`${roomNames.length} rooms`);

  // The ordinary workflow is one action, named for what it does.
  await firstRound.getByRole('button', { name: 'Start round' }).click();
  await expect(firstRound).toContainText('0 of 5 results in');
  await expect(firstRound.getByRole('button', { name: 'Finish round' })).toHaveCount(0);

  await firstRound.getByRole('button', { name: 'Open results' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Results' })).toBeVisible();

  await goToSection(page, 'Settings');
  await page.getByRole('button', { name: /^Recovery/ }).click();
  await page.getByRole('button', { name: 'Create recovery point' }).click();
  await expect(page.getByText('Manual recovery point').first()).toBeVisible();

  /*
   * Removing a round is recovery work, not a routine round control: it sits
   * behind the round's advanced recovery surface, and its confirmation is the
   * shared Director dialog rather than a browser `confirm()`.
   */
  await goToSection(page, 'Tournament day');
  const lastRound = days().last();
  await lastRound.getByRole('button', { name: /actions/ }).click();
  await page.getByRole('option', { name: 'Advanced recovery…' }).click();
  await page.getByRole('button', { name: 'Remove round…' }).click();
  const removal = page.getByRole('alertdialog');
  await expect(removal).toContainText('accepted results will be removed');
  await expect(removal).toContainText('A recovery point will be created before removal.');
  await removal.getByRole('button', { name: 'Remove round' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(days()).toHaveCount(9);

  await goToSection(page, 'Settings');
  await page.getByRole('button', { name: /^Recovery/ }).click();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Manual recovery point' })
    .getByRole('button', { name: 'Restore…' })
    .click();
  const restore = page.getByRole('alertdialog');
  await expect(restore).toContainText('recovery point');
  await restore.getByRole('button', { name: 'Restore tournament' }).click();

  await waitForPersisted(page, 'Release Rehearsal', (state) => {
    const rounds = (state as { rounds?: unknown[] }).rounds ?? [];
    const timeline = (state as { timeline?: unknown[] }).timeline ?? [];
    return rounds.length === 9 && timeline.length === 1;
  });
  await page.reload();
  await goToSection(page, 'Tournament day');
  await expect(days()).toHaveCount(10);
  await expect(days().first()).toContainText('0 of 5 results in');
  const restored = await days().allTextContents();
  expect(restored[5]).toContain('Lunch');
  await page.screenshot({ path: testInfo.outputPath('restored-rounds.png'), fullPage: true });
});
