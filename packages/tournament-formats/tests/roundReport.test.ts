import { describe, expect, test } from 'vitest';
import { buildStatReportBundle, type RoundStatsRow, type StatsSnapshot } from '../src/index.js';

const at = '2026-09-09T12:00:00.000Z';

function round(overrides: Partial<RoundStatsRow> = {}): RoundStatsRow {
  return {
    roundId: 'round-1',
    roundName: 'Round 1',
    phaseId: 'phase-1',
    phaseName: 'Preliminary',
    packetName: 'Packet One',
    games: 1,
    teams: 2,
    playedGames: 1,
    regulationTossupCount: 20,
    tossupsRead: 20,
    pointsPerTeamPerXTuh: 250,
    superpowerRate: null,
    powerRate: 0.3,
    tossupConversionRate: 0.5,
    negRatePerXTuh: 3,
    ppb: 14,
    bonusConversionRate: 14 / 30,
    superpowerApplicable: false,
    powerApplicable: true,
    negApplicable: true,
    bonusApplicable: true,
    coverage: {
      playedGames: 1,
      detailGames: 1,
      tossupsReadGames: 1,
      regulationGames: 1,
      bonusGames: 1,
    },
    notes: [],
    ...overrides,
  };
}

function snapshot(): StatsSnapshot {
  const row = round();
  return {
    format: 'qbsheet-stats',
    version: 1,
    generatedAt: at,
    tournament: { id: 'tournament', name: 'Report Test' },
    teams: [],
    players: [],
    games: [
      {
        gameId: 'game-1',
        phaseId: 'phase-1',
        roundId: 'round-1',
        roundName: 'Round 1',
        packetId: 'packet-1',
        packetName: 'Packet One',
        teamOneId: 'team-a',
        teamOneName: 'Aiken',
        teamOnePoints: 300,
        teamTwoId: 'team-b',
        teamTwoName: 'Dorman',
        teamTwoPoints: 200,
        winnerId: 'team-a',
        status: 'accepted',
        detail: 'complete',
      },
    ],
    rounds: [row],
    roundTotal: { ...row, roundId: 'overall', roundName: 'Overall', packetName: null },
    extensions: { scopeLabel: 'Overall' },
  };
}

describe('printable round report', () => {
  test('renders canonical round metrics as a linked printable table', () => {
    const pages = buildStatReportBundle(snapshot());
    const rounds = pages.find((page) => page.name === 'rounds.html')?.content ?? '';
    const games = pages.find((page) => page.name === 'games.html')?.content ?? '';

    expect(rounds).toContain('<table>');
    expect(rounds).toContain('Round statistics');
    expect(rounds).toContain('games.html#round-round-1');
    expect(rounds).toContain('TU Conv %');
    expect(rounds).toContain('Power %');
    expect(rounds).toContain('PPB');
    expect(rounds).toContain('Packet One');
    expect(rounds).toContain('Overall');
    expect(rounds).not.toContain('Aiken 300–200 Dorman');

    expect(games).toContain('id="round-round-1"');
    expect(games).toContain('Aiken vs Dorman');
    expect(games).toContain('300–200');
  });

  test('omits columns that are irrelevant to the included scoring definitions', () => {
    const value = snapshot();
    const noPowerOrBonus = round({
      powerRate: null,
      negRatePerXTuh: null,
      ppb: null,
      bonusConversionRate: null,
      powerApplicable: false,
      negApplicable: false,
      bonusApplicable: false,
      packetName: null,
    });
    value.rounds = [noPowerOrBonus];
    value.roundTotal = { ...noPowerOrBonus, roundId: 'overall', roundName: 'Overall' };
    const rounds = buildStatReportBundle(value).find((page) => page.name === 'rounds.html')?.content ?? '';

    expect(rounds).not.toContain(
      'title="Superpowers plus powers divided by positive tossup conversions">Power %',
    );
    expect(rounds).not.toContain(
      'title="Negs normalized to the historical regulation tossup count">Negs/reg',
    );
    expect(rounds).not.toContain('title="Bonus points divided by bonuses heard">PPB');
    expect(rounds).not.toContain('<th scope="col">Packet</th>');
  });
});
