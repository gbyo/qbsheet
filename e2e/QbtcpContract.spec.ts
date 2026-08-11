/**
 * The migration contract, tested against a server rather than against constants.
 *
 * # What the unit tests could not prove
 *
 * There were tests that a QBTCP discovery document parses and that the canonical route table spells
 * every path correctly, and they passed for as long as nothing called either one. That is the exact
 * shape of the defect this file exists to catch: an implementation can be complete, correct, and
 * unreachable, and a suite built out of isolated pieces will report it as finished.
 *
 * So the assertion here is not about paths. It is that the application, driven through its own user
 * interface, can carry a room from an address on a projector to a result on record against a server
 * that speaks *only* QBTCP — and separately, against one that speaks only the surface QBTCP
 * replaces. Every `/api/v1` request to the first server is a `404`, and every `/qbtcp/v1` request to
 * the second one is. Neither can be satisfied by a client that guessed.
 */
import { expect, test, type Page } from '@playwright/test';
import { assignmentPollIntervalMs } from '../src/app/useConnectedRuntime';
import {
  ITournamentControl,
  pairingCode,
  roomId,
  roomName,
  rounds,
  startTournamentControl,
} from './support/tournamentControl';

async function pairRoom(page: Page, control: ITournamentControl): Promise<void> {
  await page.goto('/');
  // The address typed on the welcome screen carries into the setup screen, where pressing Connect
  // is the gesture the browser's local-network permission prompt needs.
  await page.locator('#control-address').fill(control.origin);
  await page.locator('.welcome-connect-form button[type="submit"]').click();
  await expect(page.locator('#setup-address')).toHaveValue(control.origin);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  await expect(page.getByLabel('Pairing code')).toBeVisible();
  await page.getByLabel('Pairing code').fill(pairingCode);
  await page.getByRole('button', { name: 'Pair this room' }).click();

  await expect(page.getByRole('heading', { name: `${roomName} · Connected` })).toBeVisible();
}

/**
 * Both assignments field exactly four players a side, which is the format's active limit, so the
 * scorer starts the game rather than asking who is on the floor. The prompt is handled anyway
 * because that is a property of the fixture rather than of the protocol.
 */
async function startAssignedGame(page: Page, round: 4 | 5): Promise<void> {
  const spec = rounds[round];
  await expect(page.getByText(`${spec.label} · ${spec.left.name} vs ${spec.right.name}`)).toBeVisible();
  await page.getByRole('button', { name: /^(Start|Resume) scoring$/ }).click();

  const confirm = page.getByRole('button', { name: 'Everything matches' });
  const lineup = page.getByRole('heading', { name: 'Who is starting?' });
  const scoresheet = page.getByText('Tossup 1 of 20', { exact: true });

  // A connected assignment is confirmed before anything is scored against it. It appears on a fresh
  // start and not on a resume that already has questions in it, so all three landing places are waited
  // for together — asking `count()` straight after the click would race the render and read zero.
  await expect(confirm.or(lineup).or(scoresheet).first()).toBeVisible();
  if (await confirm.count()) {
    await expect(page.getByText(`${spec.label} · ${roomName}`)).toBeVisible();
    await confirm.click();
  }

  await expect(lineup.or(scoresheet).first()).toBeVisible();
  if (await lineup.count()) {
    for (const player of spec.starters) await page.getByLabel(player, { exact: true }).check();
    await page.getByRole('button', { name: 'Start game', exact: true }).click();
  }
  await expect(page.getByText('Tossup 1 of 20', { exact: true })).toBeVisible();
}

async function scoreTossup(page: Page, player: string, ruling: string, bonus: number): Promise<void> {
  await page.getByRole('button', { name: `${player} ${ruling}`, exact: true }).click();
  await page.getByLabel('Bonus').getByRole('button', { name: String(bonus), exact: true }).click();
}

async function endGameAndSubmit(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Game', exact: true }).click();
  await page.getByRole('menuitem', { name: 'End game early…' }).click();
  await page.getByLabel('Why is the game ending early?').fill('Protocol contract test');
  await page.getByRole('button', { name: 'End the game now' }).click();
  await page.getByLabel('Final score confirmed with both teams').check();
  await page.getByRole('button', { name: 'Submit result' }).click();
  await expect(page.getByRole('heading', { name: 'Final' })).toBeVisible();
}

test.describe('a server that speaks only QBTCP', () => {
  let control: ITournamentControl;

  test.beforeEach(async () => {
    control = await startTournamentControl('qbtcp');
  });

  test.afterEach(async () => {
    await control?.close();
  });

  test('carries a room from pairing to a result, and on to the next game', async ({ page }) => {
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));

    // --- discovery, pairing, and the QBJ assignment ------------------------------------------
    await pairRoom(page, control);
    expect(control.requests.some((entry) => entry.path === '/qbtcp/v1')).toBe(true);
    expect(control.requests.some((entry) => entry.path === '/qbtcp/v1/pair')).toBe(true);

    await startAssignedGame(page, 4);
    // The assignment came as a QBJ document, and its operational state came from the sibling
    // endpoint. Both are QBTCP's central commitment and neither exists on the older surface.
    expect(control.requests.some((entry) => entry.path === '/qbtcp/v1/assignment')).toBe(true);
    expect(control.requests.some((entry) => entry.path === '/qbtcp/v1/assignment/status')).toBe(true);
    expect(control.requests.some((entry) => entry.path === '/qbtcp/v1/sessions')).toBe(true);
    // Nothing reached for the deprecated surface at any point.
    expect(control.requests.filter((entry) => entry.path.startsWith('/api/v1'))).toEqual([]);

    // --- scoring, and the sequenced progress envelope ------------------------------------------
    await scoreTossup(page, 'Sarah', 'Power', 20);
    await expect(page.getByLabel('Ninety Six score')).toHaveText('35');
    await expect(page.getByText('Tossup 2 of 20', { exact: true })).toBeVisible();

    await expect.poll(() => control.progress.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const firstEnvelope = control.progress[0];
    // `sequence` is transport metadata beside the match, not a field invented inside the QBJ.
    expect(typeof firstEnvelope.sequence).toBe('number');
    expect(Number.isInteger(firstEnvelope.sequence)).toBe(true);
    expect(firstEnvelope.match).toMatchObject({ tossups_read: 1 });
    expect(firstEnvelope.match).not.toHaveProperty('sequence');

    // --- a reload mid-round restores from local state and reconnects ---------------------------
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Unfinished game' })).toBeVisible();
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByText('Tossup 2 of 20', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Ninety Six score')).toHaveText('35');

    const beforeResume = control.progress.length;
    await scoreTossup(page, 'Emma', 'Correct', 10);
    await expect(page.getByLabel('Greenwood score')).toHaveText('20');
    await expect.poll(() => control.progress.length, { timeout: 20_000 }).toBeGreaterThan(beforeResume);
    // Sequences only ever go up, which is what stops a server discarding a reloaded room's writes.
    const sequences = control.progress.map((entry) => entry.sequence as number);
    expect(sequences).toEqual([...sequences].sort((first, second) => first - second));
    expect(new Set(sequences).size).toBe(sequences.length);

    // --- the final, and the handoff the tournament did not ask for -----------------------------
    await endGameAndSubmit(page);
    expect(control.results).toHaveLength(1);
    expect(control.results[0]).toMatchObject({ tossups_read: 2 });
    await expect(page.getByText('Result sent ✓')).toBeVisible();

    // Tournament control accepted it and attached no handoff instruction, so the room is free to
    // move on. The backup is still one press away and the game is still on this device.
    const next = page.getByRole('button', { name: `Next game in ${roomName}` });
    await expect(next).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Download QBJ backup' })).toBeVisible();

    // --- back to the room, which is where the next assignment turns up -------------------------
    control.assign(5);
    await next.click();
    await expect(page.getByRole('heading', { name: `${roomName} · Connected` })).toBeVisible();
    await expect(
      page.getByText(`${rounds[5].label} · ${rounds[5].left.name} vs ${rounds[5].right.name}`),
    ).toBeVisible({ timeout: 20_000 });

    // No address, and no second pairing code, between one game and the next.
    expect(control.requests.filter((entry) => entry.path === '/qbtcp/v1/pair')).toHaveLength(1);
    await startAssignedGame(page, 5);

    expect(browserErrors).toEqual([]);
  });

  test('keeps one truthful room summons across scoring, reload, and server resolution', async ({ page }) => {
    await pairRoom(page, control);
    await startAssignedGame(page, 4);

    await page.getByRole('button', { name: 'Flag', exact: true }).click();
    await page.getByRole('button', { name: 'Question / packet issue', exact: true }).click();
    await page.getByLabel('What happened?').fill('The buzzers cut out in room 204.');
    await page.getByLabel('Ask tournament control to come', { exact: true }).check();
    await page.getByRole('button', { name: 'Save and request control', exact: true }).click();

    await expect(page.getByText(/Issue saved and was sent to tournament control/)).toBeVisible();
    await expect.poll(() => control.helpPosts.length).toBe(1);
    expect(control.helpPosts[0]).toEqual({
      category: 'question-packet',
      message: 'The buzzers cut out in room 204.',
    });
    expect(control.helpRequests).toHaveLength(1);

    await scoreTossup(page, 'Sarah', 'Power', 20);
    await expect(page.getByLabel('Ninety Six score')).toHaveText('35');
    await expect(page.getByText('Tournament control requested · Question / packet issue')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Unfinished game' })).toBeVisible();
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.getByText('Tossup 2 of 20', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Ninety Six score')).toHaveText('35');
    await expect(page.getByText('Tournament control requested · Question / packet issue')).toBeVisible({
      timeout: 20_000,
    });
    // Reconciliation is GET-only on reload; restoring the banner must not notify control again.
    expect(control.helpPosts).toHaveLength(1);

    await scoreTossup(page, 'Emma', 'Correct', 10);
    await expect(page.getByLabel('Greenwood score')).toHaveText('20');

    control.resolveHelpRequest();
    await expect(page.getByText('Tournament control requested · Question / packet issue')).toBeHidden({
      timeout: 20_000,
    });
    expect(control.helpPosts).toHaveLength(1);
    expect(control.helpRequests[0]).toMatchObject({
      category: 'question-packet',
      message: 'The buzzers cut out in room 204.',
    });
    expect(page.getByText('Tossup 3 of 20', { exact: true })).toBeVisible();
    expect(await page.getByLabel('Ninety Six score').textContent()).toBe('35');
  });

  test('saves an issue locally when help POST fails and retries only the control request', async ({ page }) => {
    await pairRoom(page, control);
    await startAssignedGame(page, 4);
    control.failNextHelp(503, 'Tournament control is temporarily unavailable.');

    await page.getByRole('button', { name: 'Flag', exact: true }).click();
    await page.getByRole('button', { name: 'Question / packet issue', exact: true }).click();
    await page.getByLabel('What happened?').fill('A failure that must stay on the scoresheet.');
    await page.getByLabel('Ask tournament control to come', { exact: true }).check();
    await page.getByRole('button', { name: 'Save and request control', exact: true }).click();

    await expect(page.getByText(/Issue saved, but tournament control was not reached/)).toBeVisible();
    await expect(page.getByText('Tournament control was not reached.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try request again', exact: true }).first()).toBeVisible();
    await expect.poll(() => control.helpPosts.length).toBe(1);
    expect(control.helpRequests).toHaveLength(0);

    await page.getByRole('button', { name: 'Try request again', exact: true }).first().click();
    await expect(page.getByText(/Tournament control requested · Question \/ packet issue/)).toBeVisible({
      timeout: 20_000,
    });
    await expect.poll(() => control.helpPosts.length).toBe(2);
    expect(control.helpPosts[1]).toEqual(control.helpPosts[0]);
    // The retry creates no second scoresheet event and no second open request.
    expect(control.helpRequests).toHaveLength(1);

    await page.getByRole('button', { name: 'Game', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Full scoresheet review' }).click();
    await expect(page.getByText('Flagged note: Question / packet issue: A failure that must stay on the scoresheet.')).toBeVisible();
  });

  test('keeps a retryable final intact through handoff, reload, and the next assignment', async ({ page }) => {
    await pairRoom(page, control);
    await startAssignedGame(page, 4);
    await scoreTossup(page, 'Sarah', 'Power', 20);

    // The request reached the fixture but its retryable server failure means no result was accepted.
    control.failNextResult(503, 'Tournament control is temporarily unavailable.');
    await endGameAndSubmit(page);
    await expect(page.getByText(/did not receive the result yet/)).toBeVisible();
    await expect.poll(() => control.resultAttempts.length).toBe(1);
    const firstAttempt = JSON.stringify(control.resultAttempts[0]);
    expect(control.results).toHaveLength(0);
    expect(control.resultAttempts[0]).not.toHaveProperty('_yf_scorekeeper_recovery');

    // Pending delivery still needs the independent human/file handoff before this screen can close.
    await page.getByRole('button', { name: 'Download QBJ', exact: true }).click();
    await page.getByRole('button', { name: 'I uploaded the result', exact: true }).click();
    const next = page.getByRole('button', { name: `Next game in ${roomName}` });
    await expect(next).toBeEnabled();

    // Move the room on. The earlier result's private capability is keyed to its record, not to the
    // one current connection that now points at the next session.
    control.assign(5);
    await next.click();
    await startAssignedGame(page, 5);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible();

    const oldGame = page.locator('.recent-item').filter({ hasText: 'Ninety Six' });
    await expect(oldGame).toContainText('Not delivered yet');
    await expect(oldGame.getByText('Ninety Six 35–0 Greenwood')).toBeVisible();
    await oldGame.getByRole('button', { name: 'Retry sending result', exact: true }).click();

    await expect.poll(() => control.results.length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => control.resultAttempts.length, { timeout: 20_000 }).toBe(2);
    expect(JSON.stringify(control.resultAttempts[1])).toBe(firstAttempt);
    await expect(oldGame).toContainText('Accepted');
    await expect(oldGame).toContainText('2 attempts');
    await expect(oldGame.getByText('Ninety Six 35–0 Greenwood')).toBeVisible();
  });

  test('a room that has paired once goes straight back to its room after a reload', async ({ page }) => {
    await pairRoom(page, control);

    await page.goto('/');
    // The stored room is offered by name, ahead of the address box it replaces.
    await expect(page.getByText(`${roomName} · Connected`)).toBeVisible();
    await page.getByRole('button', { name: 'Go to this room' }).click();

    await expect(page.getByRole('heading', { name: `${roomName} · Connected` })).toBeVisible();
    await expect(page.getByText(`${rounds[4].label} · Ninety Six vs Greenwood`)).toBeVisible();
    expect(control.requests.filter((entry) => entry.path === '/qbtcp/v1/pair')).toHaveLength(1);
  });

  test('waits rather than asking for a code when tournament control has nothing assigned', async ({ page }) => {
    control.assign(null);
    await pairRoom(page, control);

    await expect(page.getByText('Waiting for the next assignment.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start scoring' })).toBeDisabled();
    // `204 No Content` is not an error and must not send anybody back through pairing.
    await expect(page.getByLabel('Pairing code')).toHaveCount(0);
  });

  test('asks for a new code only once the stored room token is actually refused', async ({ page }) => {
    await pairRoom(page, control);
    await expect(page.getByText(`${rounds[4].label} · Ninety Six vs Greenwood`)).toBeVisible();

    control.revokeRoomToken();
    await page.getByRole('button', { name: 'Check again' }).click();

    await expect(page.getByLabel('Pairing code')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/no longer recognizes this room/)).toBeVisible();
  });

  /**
   * The rule QBTCP states and this test enforces: "A client MUST NOT take over automatically after a
   * failed write."
   *
   * It is worth a browser test rather than a unit test because every layer has to agree for it to
   * hold. The adapter has to read the offer out of a `409` body; the runtime has to stop writing
   * without stopping the room and without acting on the offer; the scorer has to surface it as
   * something a person presses; and the takeover has to reach the session endpoint and then let
   * snapshots flow again. A stub of any one of those would prove nothing about the other three, and
   * the failure this prevents — two live devices both believing they are authoritative — is the one
   * failure in the protocol that produces two different results for the same game.
   */
  test('a writer conflict waits for a person, and the takeover they choose restores writing', async ({
    page,
  }) => {
    // The explicit waits below already sum to well over two minutes if every one of them is taken
    // to its limit, and a ceiling under that turns a slow machine into a failure that says nothing
    // about the protocol. It is a ceiling, not a duration: the test runs in about forty seconds.
    test.setTimeout(240_000);
    await pairRoom(page, control);
    await startAssignedGame(page, 4);

    await scoreTossup(page, 'Sarah', 'Power', 20);
    await expect.poll(() => control.progress.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const beforeConflict = control.progress.length;

    // A phone in the same room takes the game over, which is the case writer ownership exists for.
    control.giveWriterTo('device-the-phone');

    await scoreTossup(page, 'Emma', 'Correct', 10);
    await expect.poll(() => control.refusedWrites(), { timeout: 20_000 }).toBeGreaterThan(0);

    // Asserted on the refusal itself rather than on the banner, so that a client which did take
    // over automatically fails here — naming the rule — instead of failing later on a banner that
    // appeared and vanished too quickly for anybody to have pressed anything in it.
    expect(control.takeovers).toEqual([]);
    expect(control.writerHeldBy()).toBe('device-the-phone');

    // And the person is told, without being sent to a pairing code: a writer conflict is somebody
    // else's device, not a credential this room has lost.
    const conflict = page.locator('.scorer-banner').filter({ hasText: 'Another device is scoring this game' });
    await expect(conflict).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel('Pairing code')).toHaveCount(0);

    // The scoresheet is untouched by any of it, and the room keeps scoring into it.
    await scoreTossup(page, 'James', 'Correct', 30);
    await expect(page.getByText('Tossup 4 of 20', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Ninety Six score')).toHaveText('75');

    // A second failed write, and one full assignment poll, still produce no takeover. Automatic
    // recovery from this state is precisely what must not happen.
    await page.waitForTimeout(assignmentPollIntervalMs + 2_000);
    expect(control.takeovers).toEqual([]);
    expect(control.progress.length).toBe(beforeConflict);

    // --- the takeover, which only a person starts ---------------------------------------------
    await conflict.getByRole('button', { name: 'Take over scoring' }).click();

    await expect.poll(() => control.takeovers.length, { timeout: 20_000 }).toBe(1);
    // Explicit on the wire, and carrying the device the server arbitrates ownership by.
    expect(control.takeovers[0].takeOver).toBe(true);
    expect(control.takeovers[0].deviceId).toEqual(expect.stringMatching(/^device-/));
    expect(control.writerHeldBy()).toBeNull();
    await expect(conflict).toBeHidden();

    // Writing resumes, and what arrives is the current game rather than a replay of what was missed.
    await expect.poll(() => control.progress.length, { timeout: 30_000 }).toBeGreaterThan(beforeConflict);
    const resumed = control.progress[control.progress.length - 1];
    expect(resumed.match).toMatchObject({ tossups_read: 3 });
    expect(resumed.sequence).toBeGreaterThan(control.progress[beforeConflict - 1].sequence as number);

    // And the game can still be finished through the session it never left.
    await endGameAndSubmit(page);
    expect(control.results).toHaveLength(1);
    await expect(page.getByText('Result sent ✓')).toBeVisible();
  });

  /**
   * The room-token repair, which is the only one that needs a person to type something.
   *
   * The rule it has to keep is that the scoresheet never leaves the screen: the code is asked for
   * over a live game, and a scorekeeper who cannot find the code just closes the dialog and keeps
   * scoring. Which is also why the dialog has to behave like one — focus in the field, Escape out,
   * and Tab staying inside rather than wandering onto the tossup buttons behind it.
   */
  test('the room-token repair is a dialog over a live scoresheet, and restores writing', async ({ page }) => {
    test.setTimeout(120_000);
    await pairRoom(page, control);
    await startAssignedGame(page, 4);
    await scoreTossup(page, 'Sarah', 'Power', 20);
    await expect.poll(() => control.progress.length, { timeout: 20_000 }).toBeGreaterThan(0);

    control.revokeRoomToken();
    const banner = page.locator('.scorer-banner').filter({ hasText: 'Tournament connection changed' });
    await expect(banner).toBeVisible({ timeout: 20_000 });

    await banner.getByRole('button', { name: 'Repair connection…' }).click();
    const dialog = page.getByRole('dialog', { name: `Repair the connection for ${roomName}` });
    await expect(dialog).toBeVisible();

    // The field the dialog exists for already has focus, and Escape is a way out that costs nothing.
    await expect(page.locator('#repair-code')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Tossup 2 of 20', { exact: true })).toBeVisible();

    // Scoring continued the whole time, with the game never once off the screen.
    await scoreTossup(page, 'Emma', 'Correct', 10);
    await expect(page.getByLabel('Greenwood score')).toHaveText('20');

    await banner.getByRole('button', { name: 'Repair connection…' }).click();
    await expect(dialog).toBeVisible();
    // Tab does not reach the scoresheet behind: a modal dialog keeps its own focus.
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

    await page.locator('#repair-code').fill(pairingCode);
    await dialog.getByRole('button', { name: 'Pair this room again' }).click();
    await expect(dialog).toBeHidden();
    await expect(banner).toBeHidden({ timeout: 20_000 });

    // Repaired in place: the same game, still on screen, writing again.
    const repaired = control.progress.length;
    await scoreTossup(page, 'James', 'Correct', 30);
    await expect(page.getByText('Tossup 4 of 20', { exact: true })).toBeVisible();
    await expect.poll(() => control.progress.length, { timeout: 30_000 }).toBeGreaterThan(repaired);
    expect(control.progress[control.progress.length - 1].match).toMatchObject({ tossups_read: 3 });
  });

  test('a refused session token reopens the same game instead of ending it', async ({ page }) => {
    await pairRoom(page, control);
    await startAssignedGame(page, 4);
    await scoreTossup(page, 'Sarah', 'Power', 20);
    await expect.poll(() => control.progress.length, { timeout: 20_000 }).toBeGreaterThan(0);

    const sessionsOpened = control.requests.filter((entry) => entry.path === '/qbtcp/v1/sessions').length;
    control.revokeSessionToken();

    // The scoresheet stays exactly where it is while the repair happens behind it.
    await scoreTossup(page, 'Emma', 'Correct', 10);
    await expect(page.getByText('Tossup 3 of 20', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Ninety Six score')).toHaveText('35');

    await expect
      .poll(() => control.requests.filter((entry) => entry.path === '/qbtcp/v1/sessions').length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(sessionsOpened);
    // Reopening returns the session that was already open; it does not start a second game.
    await expect(page.getByLabel('Pairing code')).toHaveCount(0);

    const delivered = control.progress.length;
    await scoreTossup(page, 'James', 'Correct', 30);
    await expect.poll(() => control.progress.length, { timeout: 20_000 }).toBeGreaterThan(delivered);
  });
});

test.describe('a server that only speaks the surface QBTCP replaces', () => {
  let control: ITournamentControl;

  test.beforeEach(async () => {
    control = await startTournamentControl('legacy');
  });

  test.afterEach(async () => {
    await control?.close();
  });

  test('still carries a room from pairing to a result', async ({ page }) => {
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await pairRoom(page, control);
    // Discovery was attempted and answered with a `404`, which is how a client learns that a server
    // predates QBTCP. Degrading is safe; it is guessing at a newer protocol that is not.
    expect(control.requests.some((entry) => entry.path === '/qbtcp/v1')).toBe(true);
    expect(control.requests.some((entry) => entry.path === '/api/v1/join')).toBe(true);

    await startAssignedGame(page, 4);
    expect(control.requests.some((entry) => entry.path === `/api/v1/rooms/${roomId}/assignment`)).toBe(true);

    await scoreTossup(page, 'Sarah', 'Power', 20);
    await expect(page.getByLabel('Ninety Six score')).toHaveText('35');

    await expect.poll(() => control.progress.length, { timeout: 20_000 }).toBeGreaterThan(0);
    // Bare, with no envelope: this surface has no sequence and would not know what to do with one.
    expect(control.progress[0].sequence).toBeUndefined();
    expect(control.progress[0].match).toMatchObject({ tossups_read: 1 });

    await endGameAndSubmit(page);
    expect(control.results).toHaveLength(1);
    await expect(page.getByText('Result sent ✓')).toBeVisible();

    // The only canonical path ever requested is discovery itself. A client is allowed to ask more
    // than once — each screen builds its own client — but it may never reach past the question.
    const canonical = control.requests.filter((entry) => entry.path.startsWith('/qbtcp/v1'));
    expect(canonical.length).toBeGreaterThan(0);
    expect(canonical.every((entry) => entry.method === 'GET' && entry.path === '/qbtcp/v1')).toBe(true);
    expect(browserErrors).toEqual([]);
  });
});
