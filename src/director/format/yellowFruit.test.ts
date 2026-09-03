/**
 * YellowFruit migration import, Director level: the real 12-team .yft
 * fixture opens as ordinary Director state — teams with seeds and letters,
 * players with school years, stages/pools/rounds/games, venue and date —
 * with classifications mapped and the import report surfaced as warnings.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { importYellowFruitText } from './interchange';

function fixture(): string {
  return readFileSync(
    new URL(
      '../../../packages/tournament-formats/tests/fixtures/yft-sample.yft.json',
      String(import.meta.url),
    ),
    'utf8',
  );
}

describe('yellowfruit Director import', () => {
  test('real file becomes runnable Director state', () => {
    const report = importYellowFruitText(fixture());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.state).toBeTruthy();
    if (!report.ok || !report.state) return;
    const { state } = report;
    expect(state.teams).toHaveLength(12);
    expect(state.players).toHaveLength(48);
    expect(state.phases.map((phase) => phase.kind)).toEqual(['preliminary', 'playoff']);
    expect(state.pools).toHaveLength(4);
    expect(state.rounds).toHaveLength(8);
    expect(state.games).toHaveLength(48);
    // Seeds and venue/date survive as first-class Director metadata.
    expect(state.teams.every((team) => team.seed !== null)).toBe(true);
    expect(state.tournament?.venue).toBe('Gould Academy');
    expect(state.tournament?.date).toBe('2025-10-05T04:00:00.000Z');
    expect(state.tournament?.questionSet).toBe('IS-241A');
    expect(state.tournament?.endDate).toBeUndefined();
    // Player years become structured school years, not notes.
    expect(state.players.some((player) => player.schoolYear === 12)).toBe(true);
    // Every game links to a stage round with both sides resolved.
    for (const game of state.games) {
      expect(game.roundId).toBeTruthy();
      expect(game.scores).toHaveLength(2);
      expect(game.scores[0].teamId).toBeTruthy();
      expect(game.scores[1].teamId).toBeTruthy();
    }
    // No final placement is fabricated for an in-progress file.
    expect(state.tournament?.finalPlacement).toBeUndefined();
    // The import report is surfaced, including what stayed behind.
    expect(report.warnings.some((entry) => entry.startsWith('YellowFruit import: 12 teams'))).toBe(true);
    expect(report.warnings.some((entry) => entry.includes('Final rankings'))).toBe(true);
  });

  test('non-YellowFruit text fails with an explicit error', () => {
    const report = importYellowFruitText(JSON.stringify({ version: '2.1.1', objects: [] }));
    expect(report.ok).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  test('finished-file team ranks become an attributed final placement', () => {
    // Simulate a finished file by stamping Overall positions onto each team,
    // exactly where YellowFruit writes them.
    const parsed = JSON.parse(fixture()) as {
      objects: [{ registrations: [{ teams: { ranks?: Record<string, unknown>[] }[] }] }];
    };
    const teams = parsed.objects[0].registrations.flatMap((registration) => registration.teams);
    teams.forEach((team, index) => {
      team.ranks = [{ ...(team.ranks?.[0] ?? {}), position: index + 1 }];
    });
    const report = importYellowFruitText(JSON.stringify(parsed));
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    if (!report.ok || !report.state) return;
    const placement = report.state.tournament?.finalPlacement;
    expect(placement?.actor).toBe('YellowFruit import');
    expect(placement?.order).toHaveLength(12);
    // Calculated data is untouched: every game still resolves to real teams.
    expect(report.state.games).toHaveLength(48);
  });
});
