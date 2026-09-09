import { describe, expect, test } from 'vitest';
import { deriveRoundStats, type RoundStatsGameFacts } from '../src/index.js';

function fact(
  gameId: string,
  roundId: string,
  overrides: Partial<RoundStatsGameFacts> = {},
): RoundStatsGameFacts {
  return {
    gameId,
    roundId,
    roundName: roundId === 'r1' ? 'Round 1' : 'Round 2',
    phaseId: 'prelims',
    phaseName: 'Preliminary',
    packetId: roundId === 'r1' ? 'p1' : 'p2',
    packetName: roundId === 'r1' ? 'Packet 1' : 'Packet 2',
    teamIds: [`${gameId}-a`, `${gameId}-b`],
    teamPoints: [300, 200],
    played: true,
    detailComplete: true,
    tossupsRead: 20,
    regulationTossupCount: 20,
    superpowers: 0,
    powers: 3,
    gets: 7,
    negs: 3,
    bonusesHeard: 10,
    bonusPoints: 140,
    maximumBonusScore: 30,
    superpowerApplicable: false,
    powerApplicable: true,
    negApplicable: true,
    bonusApplicable: true,
    ...overrides,
  };
}

describe('deriveRoundStats', () => {
  test('matches hand-calculated round formulas and recomputes weighted totals', () => {
    const report = deriveRoundStats([
      fact('g1', 'r1'),
      fact('g2', 'r1', {
        teamPoints: [400, 100],
        powers: 5,
        gets: 5,
        negs: 2,
        bonusesHeard: 12,
        bonusPoints: 180,
      }),
      fact('g3', 'r2', {
        teamPoints: [450, 350],
        powers: 1,
        gets: 9,
        negs: 1,
        bonusesHeard: 1,
        bonusPoints: 30,
      }),
    ]);

    const round = report.rows[0]!;
    expect(round.games).toBe(2);
    expect(round.regulationTossupCount).toBe(20);
    expect(round.pointsPerTeamPerXTuh).toBeCloseTo(250);
    expect(round.tossupConversionRate).toBeCloseTo(0.5);
    expect(round.powerRate).toBeCloseTo(0.4);
    expect(round.negRatePerXTuh).toBeCloseTo(2.5);
    expect(round.ppb).toBeCloseTo(320 / 22);
    expect(round.bonusConversionRate).toBeCloseTo(320 / (22 * 30));
    expect(round.packetName).toBe('Packet 1');

    expect(report.total?.ppb).toBeCloseTo(350 / 23);
    expect(report.total?.ppb).not.toBeCloseTo((round.ppb! + report.rows[1]!.ppb!) / 2);
  });

  test('does not silently aggregate a known subset when detail is partial', () => {
    const report = deriveRoundStats([
      fact('g1', 'r1'),
      fact('g2', 'r1', {
        detailComplete: false,
        powers: null,
        gets: null,
        negs: null,
        bonusesHeard: null,
        bonusPoints: null,
      }),
    ]);
    const round = report.rows[0]!;

    expect(round.pointsPerTeamPerXTuh).toBeCloseTo(250);
    expect(round.tossupConversionRate).toBeNull();
    expect(round.powerRate).toBeNull();
    expect(round.negRatePerXTuh).toBeNull();
    expect(round.ppb).toBeNull();
    expect(round.notes).toContain('1/2 played games have complete detail.');
  });

  test('counts scoreless forfeits as results without fabricating scoring denominators', () => {
    const report = deriveRoundStats([
      fact('g1', 'r1', { regulationTossupCount: 24, tossupsRead: 24 }),
      fact('forfeit', 'r1', {
        teamPoints: [0, 0],
        played: false,
        detailComplete: false,
        tossupsRead: null,
        regulationTossupCount: null,
        superpowers: null,
        powers: null,
        gets: null,
        negs: null,
        bonusesHeard: null,
        bonusPoints: null,
        maximumBonusScore: null,
        superpowerApplicable: null,
        powerApplicable: null,
        negApplicable: null,
        bonusApplicable: null,
      }),
    ]);
    const round = report.rows[0]!;

    expect(round.games).toBe(2);
    expect(round.playedGames).toBe(1);
    expect(round.regulationTossupCount).toBe(24);
    expect(round.pointsPerTeamPerXTuh).toBeCloseTo(250);
    expect(round.notes.some((note) => note.includes('administrative result'))).toBe(true);
  });

  test('keeps definition-dependent normalization unavailable for mixed historical lengths', () => {
    const report = deriveRoundStats([
      fact('g1', 'r1', { regulationTossupCount: 20 }),
      fact('g2', 'r1', {
        regulationTossupCount: 24,
        packetId: 'different',
        packetName: 'Packet X',
      }),
    ]);
    const round = report.rows[0]!;

    expect(round.regulationTossupCount).toBeNull();
    expect(round.pointsPerTeamPerXTuh).toBeNull();
    expect(round.negRatePerXTuh).toBeNull();
    expect(round.tossupConversionRate).toBeCloseTo(0.5);
    expect(round.ppb).toBeCloseTo(14);
    expect(round.packetName).toBe('Mixed');
    expect(round.notes).toContain('Mixed regulation lengths; regulation-normalized metrics are unavailable.');
  });
});
