/**
 * A real cross-repository contract test.
 *
 * The ordinary QBTCP browser suite uses a deliberately small protocol fixture so failure injection
 * stays deterministic. This spec additionally drives the real YellowFruit server when a sibling
 * checkout is available, proving that the two applications can pair, exchange progress, submit a
 * QBJ result, and leave a durable review record together.
 */
import { expect, test } from '@playwright/test';
import { rounds } from './support/tournamentControl';
import { startYellowFruitControl, yellowFruitHarnessAvailable } from './support/yellowfruitControl';

test.describe('QBSheet against the real YellowFruit QBTCP server', () => {
  test.skip(
    !yellowFruitHarnessAvailable,
    'Set YELLOWFRUIT_REPO to a YellowFruit checkout to enable the cross-repository contract test.',
  );

  test('pairs, scores, submits, and records a director review', async ({ page }) => {
    test.setTimeout(40_000);
    const control = await startYellowFruitControl();
    try {
      const assignment = control.assignmentDocument as {
        version: string;
        objects: Array<Record<string, unknown>>;
      };
      const match = assignment.objects.find((entry) => entry.type === 'Match');
      const teams = assignment.objects.filter((entry) => entry.type === 'Team');
      const scoringRules = assignment.objects.find((entry) => entry.type === 'ScoringRules');
      expect(assignment.version).toBe('2.1.1');
      expect(match).toMatchObject({
        id: control.matchId,
        location: 'Room 204',
        _qbtcp: {
          version: 1,
          round_revision: 1,
          assignment_revision: 1,
          room_id: control.roomId,
          procedure: {
            version: 3,
            halves: true,
            breaks: [{ afterTossup: 10, label: 'Mid-game' }],
            halfLengthMinutes: 25,
            timeoutsPerTeam: 1,
            timeoutDurationSeconds: 30,
            protestCheckpoints: 'phase-boundaries',
            substitutionPolicy: 'any-boundary',
          },
          handoff_instruction: 'Return the scoresheet to the director table.',
          scorekeeper: { timed: false },
        },
      });
      expect(teams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: control.roster.left.id, name: control.roster.left.name }),
          expect.objectContaining({ id: control.roster.right.id, name: control.roster.right.name }),
        ]),
      );
      for (const expectedTeam of [control.roster.left, control.roster.right]) {
        const team = teams.find((entry) => entry.id === expectedTeam.id);
        expect(
          (team?.players as Array<{ id: string; name: string }> | undefined)?.map(({ id, name }) => ({
            id,
            name,
          })),
        ).toEqual(expectedTeam.players);
      }
      expect(scoringRules).toMatchObject({
        maximum_regulation_tossup_count: 20,
        maximum_players_per_team: 4,
        answer_types: expect.any(Array),
      });

      await page.goto('/');
      await page.locator('#control-address').fill(control.origin);
      await page.locator('.welcome-connect-form button[type="submit"]').click();

      await expect(page.getByLabel('Pairing code')).toBeVisible();
      await page.getByLabel('Pairing code').fill(control.pairingCode);
      await page.getByRole('button', { name: 'Pair this room' }).click();
      await expect(page.locator('.connected-room-shell')).toBeVisible();
      await expect(page.locator('.assignment-context')).toHaveText('4 · Room 204');

      await page.getByRole('button', { name: 'Start scoring' }).click();
      const lineup = page.getByRole('heading', { name: 'Who is starting?' });
      if (await lineup.count()) {
        const prompt = page.getByLabel('Starting lineups');
        for (const player of rounds[4].left.players) {
          await prompt
            .getByLabel(`${rounds[4].left.name} starters`)
            .getByRole('button', { name: `Start ${player.name}` })
            .click();
        }
        for (const player of rounds[4].right.players) {
          await prompt
            .getByLabel(`${rounds[4].right.name} starters`)
            .getByRole('button', { name: `Start ${player.name}` })
            .click();
        }
        await page.getByRole('button', { name: 'Start game', exact: true }).click();
      }
      await expect(page.getByText('Tossup 1 of 20', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Players', exact: true }).click();
      const leftLineup = page.getByRole('region', { name: `${control.roster.left.name} lineup` });
      await leftLineup.getByRole('button', { name: '+ Add player', exact: true }).click();
      await leftLineup.getByLabel('Player name').fill('Vera Stone');
      await leftLineup.getByRole('button', { name: 'Add', exact: true }).click();
      await expect
        .poll(() => control.state().roster.left.players.some((player) => player.name === 'Vera Stone'), {
          timeout: 10_000,
        })
        .toBe(true);
      expect(control.state().roster.left.players).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Vera Stone' })]),
      );

      await page
        .getByRole('button', { name: `${control.roster.left.players[0].name} Power`, exact: true })
        .click();
      await page.getByLabel('Bonus').getByRole('button', { name: '20', exact: true }).click();
      await expect
        .poll(() => control.state().sessions.some((session) => session.progressSequence > 0))
        .toBe(true);

      for (let tossup = 2; tossup <= 20; tossup += 1) {
        await page.getByRole('button', { name: 'No buzz' }).click();
      }
      await page.getByLabel('Final score confirmed with both teams').check();
      await page.getByRole('button', { name: 'Submit result' }).click();
      await expect(page.getByRole('heading', { name: 'Final' })).toBeVisible();
      await expect(page.getByText(/Result sent|Result received for director review/)).toBeVisible();

      await expect.poll(() => control.state().results.length, { timeout: 20_000 }).toBe(1);
      await expect.poll(() => control.state().results[0]?.status, { timeout: 20_000 }).toBe('accepted');
      expect(control.state().results[0]).toMatchObject({
        matchId: control.matchId,
        status: 'accepted',
        importedMatchId: control.matchId,
      });
      expect(control.state().matches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scheduledGameId: control.matchId,
            tossupsRead: 20,
            leftPoints: 35,
            rightPoints: 0,
          }),
        ]),
      );

      const warningReceipt = await control.submitWarning();
      expect(warningReceipt).toMatchObject({
        accepted: true,
        received: true,
        review_required: true,
        duplicate: false,
      });
      await expect.poll(() => control.state().results.length, { timeout: 10_000 }).toBe(2);
      await expect.poll(() => control.state().importPreview?.modalIsOpen, { timeout: 10_000 }).toBe(true);
      expect(control.state().results[1]).toMatchObject({
        status: 'conflict',
        matchId: control.matchId,
      });
      await expect
        .poll(() => control.state().importPreview?.comparisons, { timeout: 10_000 })
        .toContain('conflict');
      await control.reviewWarning();
      await expect.poll(() => control.state().results[1]?.status, { timeout: 10_000 }).toBe('accepted');
      expect(control.state().results).toHaveLength(2);
    } finally {
      await control.close();
    }
  });
});
