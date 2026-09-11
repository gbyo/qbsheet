import { describe, expect, test } from 'vitest';
import {
  buildStatReportBundle,
  deriveRoundStats,
  type GameStatsRow,
  type GameTeamStatsRow,
  type RoundStatDefinition,
  type StatsSnapshot,
} from '../src/index';

function team(teamId: string, points: number, overrides: Partial<GameTeamStatsRow> = {}): GameTeamStatsRow {
  return {
    teamId,
    teamName: teamId,
    points,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    tossupsHeard: null,
    bonusesHeard: 0,
    bonusPoints: 0,
    ppb: null,
    bouncebacks: 0,
    ...overrides,
  };
}

function definition(overrides: Partial<RoundStatDefinition> = {}): RoundStatDefinition {
  return {
    regulationTossups: 20,
    regulationLengthFixed: true,
    overtimeEnabled: true,
    powers: true,
    superpowers: false,
    bonuses: true,
    bouncebacks: false,
    lightning: false,
    maximumBonusScore: 30,
    source: 'game',
    ...overrides,
  };
}

function game(id: string, overrides: Partial<GameStatsRow> = {}): GameStatsRow {
  return {
    gameId: id,
    phaseId: 'phase',
    phaseName: 'Preliminary',
    roundId: 'round',
    roundName: 'Round 1',
    teamOneId: 'A',
    teamOneName: 'A',
    teamOnePoints: 300,
    teamTwoId: 'B',
    teamTwoName: 'B',
    teamTwoPoints: 200,
    status: 'accepted',
    detail: 'complete',
    tossupsRead: 20,
    overtimeTossupsRead: 0,
    roundStatDefinition: definition(),
    teamStats: [
      team('A', 300, { powers: 2, gets: 8, negs: 1, bonusesHeard: 10, bonusPoints: 180 }),
      team('B', 200, { powers: 1, gets: 7, negs: 2, bonusesHeard: 8, bonusPoints: 150 }),
    ],
    ...overrides,
  };
}

function snapshot(games: GameStatsRow[]): StatsSnapshot {
  return {
    format: 'qbsheet-stats',
    version: 1,
    generatedAt: '2026-09-09T20:00:00.000Z',
    tournament: { id: 'tournament', name: 'Optional Metrics Test' },
    teams: [],
    players: [],
    games,
    extensions: { scopeLabel: 'Overall' },
  };
}

describe('round-stat rule variants', () => {
  test('uses the exact total tossups-read denominator for an overtime game', () => {
    const overtime = game('overtime', {
      tossupsRead: 21,
      overtimeTossupsRead: 1,
    });
    const row = deriveRoundStats([overtime]).rows[0]!;
    expect(row.tossupsRead).toBe(21);
    expect(row.tossupConversionRate).toBeCloseTo(18 / 21);
    expect(row.negRatePerXTuh).toBeCloseTo((3 / 21) * 20);
  });

  test('Pts/team/X TUH excludes overtime points and TUH when the split is known (#755)', () => {
    const overtime = game('overtime', {
      tossupsRead: 21,
      overtimeTossupsRead: 1,
      teamStats: [
        team('A', 300, {
          powers: 2,
          gets: 8,
          negs: 1,
          bonusesHeard: 10,
          bonusPoints: 180,
          overtimePoints: 30,
        }),
        team('B', 200, { powers: 1, gets: 7, negs: 2, bonusesHeard: 8, bonusPoints: 150, overtimePoints: 0 }),
      ],
    });
    const row = deriveRoundStats([overtime]).rows[0]!;
    // Regulation: 270 + 200 over 20 TUH, normalized to X = 20.
    expect(row.pointsPerTeamPerXTuh).toBeCloseTo(((270 + 200) / 2) * (20 / 20));
  });

  test('Pts/team/X TUH stays unknown when the overtime points split is missing (#755)', () => {
    const overtime = game('overtime', {
      tossupsRead: 21,
      overtimeTossupsRead: 1,
    });
    const row = deriveRoundStats([overtime]).rows[0]!;
    expect(row.pointsPerTeamPerXTuh).toBeNull();
  });

  test('marks power rate unavailable when power eligibility changes within one round', () => {
    const powered = game('powered');
    const noPowers = game('no-powers', {
      roundStatDefinition: definition({ powers: false }),
      teamStats: [
        team('A', 300, { powers: 0, gets: 10, negs: 1, bonusesHeard: 10, bonusPoints: 180 }),
        team('B', 200, { powers: 0, gets: 8, negs: 2, bonusesHeard: 8, bonusPoints: 150 }),
      ],
    });
    const report = deriveRoundStats([powered, noPowers]);
    expect(report.showPowers).toBe(true);
    expect(report.rows[0]!.powerRate).toBeNull();
    expect(report.rows[0]!.tossupConversionRate).not.toBeNull();
  });

  test('does not invent bounceback or lightning percentages without canonical denominators', () => {
    const bouncebackPoints = game('bounceback', {
      teamStats: [
        team('A', 300, {
          powers: 2,
          gets: 8,
          bonusesHeard: 10,
          bonusPoints: 180,
          bouncebacks: 20,
        }),
        team('B', 200, {
          powers: 1,
          gets: 7,
          bonusesHeard: 8,
          bonusPoints: 150,
          bouncebacks: 10,
        }),
      ],
    });
    const row = deriveRoundStats([bouncebackPoints]).rows[0]!;
    expect('bouncebackRate' in row).toBe(false);
    expect('lightningPointsPerTeamPerGame' in row).toBe(false);

    const rounds = buildStatReportBundle(snapshot([bouncebackPoints])).find(
      (page) => page.name === 'rounds.html',
    )!.content;
    expect(rounds).not.toContain('Bounceback %');
    expect(rounds).not.toContain('Lightning');
  });
});
