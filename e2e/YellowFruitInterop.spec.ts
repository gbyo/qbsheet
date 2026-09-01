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
    const control = await startYellowFruitControl();
    try {
      await page.goto('/');
      await page.locator('#control-address').fill(control.origin);
      await page.locator('.welcome-connect-form button[type="submit"]').click();

      await expect(page.getByLabel('Pairing code')).toBeVisible();
      await page.getByLabel('Pairing code').fill(control.pairingCode);
      await page.getByRole('button', { name: 'Pair this room' }).click();
      await expect(page.locator('.connected-room-shell')).toBeVisible();
      await expect(page.locator('.assignment-context')).toContainText(rounds[4].label);

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

      await page.getByRole('button', { name: 'Sarah Power', exact: true }).click();
      await page.getByLabel('Bonus').getByRole('button', { name: '20', exact: true }).click();
      await expect
        .poll(() => control.state().sessions.some((session) => session.progressSequence > 0))
        .toBe(true);

      await page.getByRole('button', { name: 'Game', exact: true }).click();
      await page.getByRole('menuitem', { name: 'End game early…' }).click();
      await page.getByLabel('Why is the game ending early?').fill('Real YellowFruit interoperability test');
      await page.getByRole('button', { name: 'End the game now' }).click();
      await page.getByLabel('Final score confirmed with both teams').check();
      await page.getByRole('button', { name: 'Submit result' }).click();
      await expect(page.getByRole('heading', { name: 'Final' })).toBeVisible();
      await expect(page.getByText(/Result sent|Result received for director review/)).toBeVisible();

      await expect.poll(() => control.state().results.length, { timeout: 20_000 }).toBe(1);
      const received = control.state().results[0];
      expect(received).toMatchObject({ matchId: rounds[4].matchId, status: 'needs-review' });
      const review = await control.review(received.id);
      expect(review).toEqual({ reviewed: true });
      expect(control.state().results[0].status).toBe('accepted');
    } finally {
      await control.close();
    }
  });
});
