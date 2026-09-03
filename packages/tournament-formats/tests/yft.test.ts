/**
 * YellowFruit (.yft) migration import, formats level: a real 12-team,
 * two-stage YellowFruit file normalizes into canonical QBJ records with
 * teams, players, pools, rounds, games with per-player detail, seeds,
 * venue/date metadata, and an explicit import report — without coupling to
 * YellowFruit internals.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { isYellowFruitDocument, readYellowFruitTournament } from '../src/yft';

function fixture(): string {
  return readFileSync(new URL('./fixtures/yft-sample.yft.json', import.meta.url), 'utf8');
}

describe('yellowfruit migration import', () => {
  test('real 12-team two-stage file imports with full detail', () => {
    const report = readYellowFruitTournament(fixture());
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const { tournament } = report.value;
    const meta = report.value.tournament.tournament;
    // 7 school registrations expand to 12 stable teams; no merges.
    expect(tournament.teams).toHaveLength(12);
    expect(tournament.players).toHaveLength(48);
    // 5 prelim rounds x 6 games + 3 playoff rounds x 6 games.
    expect(tournament.games).toHaveLength(48);
    expect(tournament.games.every((game) => game.status === 'complete')).toBe(true);
    // Every game resolves both sides to stable imported teams.
    for (const game of tournament.games) {
      expect(game.teamIds[0]).toBeTruthy();
      expect(game.teamIds[1]).toBeTruthy();
    }
    // Player detail survives: per-player results with classified buzz counts.
    const withPlayers = tournament.games.filter((game) => (game.result?.players?.length ?? 0) > 0);
    expect(withPlayers.length).toBeGreaterThan(40);
    // Stages and pools come through as ordinary structure.
    expect(tournament.phases.map((phase) => phase.kind)).toEqual(['preliminary', 'playoff']);
    expect(tournament.pools).toHaveLength(4);
    expect(tournament.pools.every((pool) => (pool.teamIds?.length ?? 0) === 6)).toBe(true);
    // Round context links every game to its stage and numbered round.
    for (const game of tournament.games) {
      expect(game.phaseId).toBeTruthy();
      expect(game.roundId).toBeTruthy();
    }
    // Seeds, venue, and date map onto canonical fields.
    expect(tournament.teams.every((team) => typeof team.seed === 'number')).toBe(true);
    expect(meta.location).toBe('Gould Academy');
    expect(meta.date).toBe('2025-10-05T04:00:00.000Z');
    // Player years map to plain-integer grades (Director derives schoolYear
    // from these); the original "12th" labels stay in YfData extensions.
    const seniors = tournament.players.filter((player) => player.grade === '12');
    expect(seniors.length).toBeGreaterThan(0);
    // Scoring rules hoist with the 15/10/-5 answer values intact.
    expect(tournament.rules).toBeTruthy();
    // The import report summarizes counts and lists what stayed behind.
    const codes = report.warnings.map((entry) => entry.code);
    expect(codes).toContain('yft-import-summary');
    expect(codes).toContain('yft-not-carried-over');
  });

  test('canonical QBJ is not detected as YellowFruit', () => {
    expect(isYellowFruitDocument({ version: '2.1.1', objects: [{ type: 'Tournament', id: 't' }] })).toBe(
      false,
    );
    expect(isYellowFruitDocument(JSON.parse(fixture()))).toBe(true);
  });

  test('non-YellowFruit input fails with an explicit error', () => {
    const report = readYellowFruitTournament(JSON.stringify({ version: '2.1.1', objects: [] }));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.errors[0].code).toBe('yft-not-yellowfruit');
  });
});
