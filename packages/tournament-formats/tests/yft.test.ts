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

function scheduleFixture(): string {
  return readFileSync(new URL('./fixtures/yft-schedule-metadata.yft.json', import.meta.url), 'utf8');
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

  test('exposes parallel pools, tier advancement, and playoff carryover as read-only metadata', () => {
    const report = readYellowFruitTournament(fixture());
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const [prelims, playoffs] = report.value.schedule.phases;
    expect(prelims).toMatchObject({
      id: 'Phase_Prelims',
      name: 'Prelims',
      type: 'Prelim',
      code: '1',
      firstRound: 1,
      lastRound: 5,
      wildcardAdvancementRules: [],
      wildcardRankingMethod: 'RankThenPPB',
    });
    expect(prelims.pools.map((pool) => pool.tier)).toEqual([1, 1]);
    expect(prelims.pools.map((pool) => pool.name)).toEqual(['Prelim A', 'Prelim B']);
    expect(prelims.pools[0]).toMatchObject({
      expectedSize: 6,
      teamIds: [
        'Team_Hebron Academy',
        'Team_Windham A',
        'Team_Cony',
        'Team_Wells',
        'Team_Gould Academy B',
        'Team_Plymouth B',
      ],
      seeds: [1, 4, 5, 8, 9, 12],
      roundRobins: 1,
      hasCarryover: false,
      autoAdvanceRules: [
        {
          tier: 1,
          ranksThatAdvance: [1, 2, 3],
          rankingRule: 'RecordthenPPGThenOther',
        },
        {
          tier: 2,
          ranksThatAdvance: [4, 5, 6],
          rankingRule: 'RecordthenPPGThenOther',
        },
      ],
    });
    expect(playoffs).toMatchObject({ id: 'Phase_Playoffs', firstRound: 6, lastRound: 8 });
    expect(playoffs.pools.map((pool) => [pool.name, pool.tier, pool.hasCarryover])).toEqual([
      ['Championship', 1, true],
      ['7th Place', 2, true],
    ]);
    expect(
      report.warnings.some((entry) => entry.message.includes('schedule template is not carried over')),
    ).toBe(false);
  });

  test('preserves wildcard metadata and an explicit zero-round-robin pool', () => {
    const report = readYellowFruitTournament(scheduleFixture());
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const [phase] = report.value.schedule.phases;
    expect(phase).toMatchObject({
      type: 'Prelim',
      code: 'custom',
      firstRound: 1,
      lastRound: 2,
      forceNumericRounds: true,
      wildcardAdvancementRules: [
        { tier: 1, numberOfTeams: 2 },
        { tier: 2, numberOfTeams: 1 },
      ],
      wildcardRankingMethod: 'RecordThanPPB',
      topWildcardSeed: 9,
    });
    expect(phase.pools[0]).toMatchObject({
      id: 'Pool_Custom',
      name: 'Card System',
      tier: 1,
      expectedSize: 4,
      teamIds: ['Team_Alpha', 'Team_Bravo', 'Team_Charlie', 'Team_Delta'],
      seeds: [1, 4, 5, 8],
      roundRobins: 0,
      hasCarryover: false,
      autoAdvanceRules: [{ tier: 1, ranksThatAdvance: [1, 2], rankingRule: 'RecordThenPPGThenOther' }],
    });
  });

  test('ignores malformed optional schedule metadata without rejecting the tournament', () => {
    const parsed = JSON.parse(scheduleFixture()) as {
      objects: Record<string, unknown>[];
    };
    const tournament = parsed.objects[0];
    const phase = (tournament.phases as Record<string, unknown>[])[0];
    const phaseData = phase.YfData as Record<string, unknown>;
    phaseData.wildCardAdvancementRules = [
      { tier: 'one', numberOfTeams: 2 },
      { tier: 1, numberOfTeams: 1 },
    ];
    phaseData.wildCardRankingMethod = 42;
    phaseData.forceNumericRounds = 'yes';
    const rounds = phase.rounds as Record<string, unknown>[];
    (rounds[0].YfData as Record<string, unknown>).number = 'first';
    const pool = (phase.pools as Record<string, unknown>[])[0];
    const poolData = pool.YfData as Record<string, unknown>;
    poolData.size = 'four';
    poolData.seeds = [1, 'bad', 5];
    poolData.roundRobins = 'none';
    poolData.hasCarryover = 'yes';
    poolData.autoAdvanceRules = [
      { tier: 'one', ranksThatAdvance: [1] },
      { tier: 2, ranksThatAdvance: [2], rankingRule: 17 },
    ];

    const report = readYellowFruitTournament(JSON.stringify(parsed));
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const [safePhase] = report.value.schedule.phases;
    expect(safePhase).toMatchObject({
      firstRound: 1,
      lastRound: 2,
      wildcardAdvancementRules: [{ tier: 1, numberOfTeams: 1 }],
    });
    expect(safePhase.forceNumericRounds).toBeUndefined();
    expect(safePhase.wildcardRankingMethod).toBeUndefined();
    expect(safePhase.pools[0]).toMatchObject({
      teamIds: ['Team_Alpha', 'Team_Bravo', 'Team_Charlie', 'Team_Delta'],
      autoAdvanceRules: [{ tier: 2, ranksThatAdvance: [2] }],
    });
    expect(safePhase.pools[0].expectedSize).toBeUndefined();
    expect(safePhase.pools[0].seeds).toBeUndefined();
    expect(safePhase.pools[0].roundRobins).toBeUndefined();
    expect(safePhase.pools[0].hasCarryover).toBeUndefined();
    expect(report.warnings.some((entry) => entry.code === 'yft-schedule-metadata')).toBe(true);
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
