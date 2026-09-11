/**
 * YellowFruit parity matrix gate (#754, epic #755).
 *
 * Checked-in goldens for every scoring mode in `fixtures/parity-matrix.ts`:
 * exact integers, rates asserted as numerator/denominator pairs so a rounding
 * change cannot hide a formula change. All fixtures and tests are hermetic —
 * no network, no YellowFruit checkout. retiring or editing a golden requires
 * its own PR with a YellowFruit source diff.
 */
import { describe, expect, test } from 'vitest';
import {
  acceptedGameRecords,
  canonicalCompetitionRanks,
  derivePlayerStandings,
  deriveRoundStats,
  deriveTeamStandings,
  normalizedPointsPerX,
  playerPptuh,
  regulationDerivationForTeam,
  scopeScoringApplicability,
  type TeamStanding,
} from '../src/index.js';
import {
  bouncebackMode,
  customTiesMode,
  forfeitMode,
  fractionalGpMode,
  irregularBonusMode,
  lightningMode,
  mixedBouncebackMode,
  mixedDefinitionsMode,
  mixedLightningMode,
  multiRoundMode,
  overtimeKnownPointsMode,
  overtimeMode,
  overtimeUnknownSplitMode,
  partialMode,
  standardMode,
  superpowerMode,
  tossupOnlyMode,
  zeroVsUnknownMode,
} from './fixtures/parity-matrix.js';
import type { DirectorState } from '../src/index.js';

function standingOf(state: DirectorState, teamId: string): TeamStanding {
  const standing = deriveTeamStandings(state, undefined, {}).find((entry) => entry.teamId === teamId);
  expect(standing).toBeDefined();
  return standing!;
}

describe('parity matrix goldens', () => {
  test('1. standard 20-TU powers and bonuses', () => {
    const state = standardMode();
    const a = standingOf(state, 'a');
    expect(a).toMatchObject({ wins: 1, losses: 0, ties: 0, gamesPlayed: 1, winPercentage: 1 });
    expect(a).toMatchObject({ pointsFor: 320, pointsAgainst: 110, margin: 210 });
    expect(a).toMatchObject({ powers: 4, gets: 8, negs: 1, tossupsHeard: 20, tossupsHeardKnown: true });
    expect(
      playerPptuh({
        points: a.pointsFor,
        tossupsHeard: a.tossupsHeard,
        tossupsHeardKnown: a.tossupsHeardKnown,
      }),
    ).toBe(16);
    expect(a).toMatchObject({ bonuses: 12, bonusPoints: 130 });
    // Opponent 6-for-40 leaves (6*30-40)/10 = 14 parts heard; 0 own points convert 0.
    expect(a).toMatchObject({
      bouncebacksKnown: true,
      bouncebackPoints: 0,
      bouncebackPartsHeard: 14,
      bouncebackPartsConverted: 0,
      bouncebackConversion: 0,
    });
    // Own 130 points are 13 parts over 36 heard: (13+0)/(36+14) = 13/50.
    expect(a.totalBonusConversion).toBeCloseTo(13 / 50, 12);
    const b = standingOf(state, 'b');
    expect(b).toMatchObject({ wins: 0, losses: 1, pointsFor: 110, tossupsHeard: 20 });
    expect(b.bouncebackPartsHeard).toBe(23);
    expect(b.totalBonusConversion).toBeCloseTo(4 / 41, 12);
  });

  test('2. superpower format counts the top tier', () => {
    const a = standingOf(superpowerMode(), 'a');
    expect(a).toMatchObject({ superpowers: 1, powers: 2, gets: 8, negs: 1, pointsFor: 350 });
  });

  test('3. tossup-only: bonus facts are absent, parts uncomputable', () => {
    const a = standingOf(tossupOnlyMode(), 'a');
    expect(a).toMatchObject({ bonuses: 0, bonusPoints: 0, tossupsHeard: 20 });
    expect(
      playerPptuh({
        points: a.pointsFor,
        tossupsHeard: a.tossupsHeard,
        tossupsHeardKnown: a.tossupsHeardKnown,
      }),
    ).toBe(9);
    // useBonuses false makes parts irregular: null, never zero.
    expect(a.bouncebackPartsHeard).toBeNull();
    expect(a.bouncebackConversion).toBeNull();
    expect(a.totalBonusConversion).toBeNull();
  });

  test('4. regular bouncebacks: parts, BB %, and total %', () => {
    const a = standingOf(bouncebackMode(), 'a');
    expect(a).toMatchObject({
      bouncebacksKnown: true,
      bouncebackPoints: 30,
      bouncebackPartsHeard: 9,
      bouncebackPartsConverted: 3,
    });
    expect(a.bouncebackConversion).toBeCloseTo(1 / 3, 12);
    expect(a.totalBonusConversion).toBeCloseTo(23 / 39, 12);
    const b = standingOf(bouncebackMode(), 'b');
    expect(b).toMatchObject({
      bouncebacksKnown: true,
      bouncebackPoints: 0,
      bouncebackPartsHeard: 10,
      bouncebackPartsConverted: 0,
    });
    // An exact zero conversion is known, not unknown.
    expect(b.bouncebackConversion).toBe(0);
    expect(b.totalBonusConversion).toBeCloseTo(15 / 34, 12);
  });

  test('5. irregular bonuses: parts decline to null while points stay known', () => {
    const a = standingOf(irregularBonusMode(), 'a');
    expect(a).toMatchObject({ bouncebacksKnown: true, bouncebackPoints: 30 });
    expect(a.bouncebackPartsHeard).toBeNull();
    expect(a.bouncebackPartsConverted).toBeNull();
    expect(a.bouncebackConversion).toBeNull();
    expect(a.totalBonusConversion).toBeNull();
  });

  test('6. lightning: known totals stand, missing breakdowns unknown the rest', () => {
    const state = lightningMode();
    const a = standingOf(state, 'a');
    expect(a).toMatchObject({ lightningKnown: true, lightningPoints: 40 });
    const b = standingOf(state, 'b');
    expect(b.lightningKnown).toBe(false);
  });

  test('7. overtime: regulation TUH excludes known overtime', () => {
    const a = standingOf(overtimeMode(), 'a');
    expect(a).toMatchObject({ tossupsHeard: 20, tossupsHeardKnown: true });
    expect(a).toMatchObject({ tossupsHeardRegulation: 18, tossupsHeardRegulationKnown: true });
  });

  test('8. substitution: fractional GP with exact rates', () => {
    const state = fractionalGpMode();
    const players = derivePlayerStandings(state, {});
    const gp = new Map(players.map((entry) => [entry.playerId, entry]));
    expect(gp.get('a1')).toMatchObject({ gamesPlayed: 1, tossupsHeard: 20 });
    expect(gp.get('a2')).toMatchObject({ gamesPlayed: 0.5, tossupsHeard: 10 });
    // 3 gets are 30 points: PPTUH 30/10, PPG 30/0.5.
    expect(gp.get('a2')!.points).toBe(30);
    expect(playerPptuh(gp.get('a2')!)).toBe(3);
    expect(gp.get('a2')!.ppg).toBe(60);
    expect(gp.get('b1')).toMatchObject({ gamesPlayed: 1 });
  });

  test('9. custom 24-TU values with mirror winners tied at rank 1', () => {
    const state = customTiesMode();
    const standings = deriveTeamStandings(state, undefined, {});
    const ranks = canonicalCompetitionRanks(
      standings,
      acceptedGameRecords(state, {}),
      state.tournament?.rules.tiebreakers,
    );
    expect(ranks.get('a')).toBe(1);
    expect(ranks.get('c')).toBe(1);
    expect(ranks.get('b')).toBe(3);
    expect(ranks.get('d')).toBe(3);
    expect(standingOf(state, 'a')).toMatchObject({ tossupsHeard: 24, pointsFor: 400 });
    // 2 powers at the custom 20 plus 8 gets at 12 minus a neg at 10: 126.
    const a1 = derivePlayerStandings(state, {}).find((entry) => entry.playerId === 'a1')!;
    expect(a1.points).toBe(126);
    expect(playerPptuh(a1)).toBeCloseTo(126 / 24, 12);
  });

  test('10. pure forfeit: decided for W/L, invisible to TUH', () => {
    const state = forfeitMode();
    const a = standingOf(state, 'a');
    expect(a).toMatchObject({ gamesPlayed: 2, wins: 2, losses: 0, pointsFor: 300 });
    expect(a).toMatchObject({ tossupsHeard: 20, tossupsHeardKnown: true });
    expect(a).toMatchObject({ bouncebacksKnown: true, bouncebackPoints: 0, bouncebackPartsHeard: 9 });
    const c = standingOf(state, 'c');
    expect(c).toMatchObject({ gamesPlayed: 1, wins: 0, losses: 1, pointsFor: 0, tossupsHeard: 0 });
  });

  test('11. score-only partial: points without trustworthy detail', () => {
    const a = standingOf(partialMode(), 'a');
    expect(a).toMatchObject({ gamesPlayed: 1, wins: 1, pointsFor: 250 });
    expect(a).toMatchObject({ tossupsHeard: 0, tossupsHeardKnown: false });
    expect(a).toMatchObject({ powersKnown: false, bouncebacksKnown: false });
    expect(a.bouncebackPartsHeard).toBeNull();
  });

  test('12. multi-round aggregation and phase scoping', () => {
    const state = multiRoundMode();
    const rounds = deriveRoundStats(state);
    expect(rounds.map((entry) => entry.roundId)).toEqual(['round-1', 'round-2', 'round-3']);
    const first = rounds[0]!;
    expect(first).toMatchObject({
      games: 1,
      playedGames: 1,
      detailedGames: 1,
      pointsPerTeam: 200,
      powers: 3,
      gets: 12,
      negs: 3,
      bonusesHeard: 15,
      bonusPoints: 240,
    });
    expect(first.ppb).toBeCloseTo(16, 12);
    expect(first.bouncebackPartsHeard).toBe(21);
    expect(first.bouncebackConversion).toBe(0);
    expect(first.totalBonusConversion).toBeCloseTo(24 / 66, 12);
    const overall = standingOf(state, 'a');
    expect(overall).toMatchObject({ gamesPlayed: 3, pointsFor: 760 });
    const phase = deriveTeamStandings(state, undefined, { phaseId: 'phase-2' }).find(
      (entry) => entry.teamId === 'a',
    )!;
    expect(phase).toMatchObject({ gamesPlayed: 1, pointsFor: 200 });
  });

  test('13. known zero stays comparable while unknown declines', () => {
    const state = zeroVsUnknownMode();
    const a = standingOf(state, 'a');
    expect(a).toMatchObject({ powersKnown: true, powers: 0, bouncebacksKnown: true, bouncebackPoints: 0 });
    const b = standingOf(state, 'b');
    expect(b).toMatchObject({ bonuses: 5, bonusPoints: 0 });
    const c = standingOf(state, 'c');
    expect(c).toMatchObject({ powersKnown: false, tossupsHeardKnown: false, bouncebacksKnown: false });
    expect(c.bouncebackPartsHeard).toBeNull();
  });

  test('14. mixed history: each game valued under its own definition', () => {
    const state = mixedDefinitionsMode();
    const a1 = derivePlayerStandings(state, {}).find((entry) => entry.playerId === 'a1')!;
    // 105 under the modern 15-point power plus 115 under the legacy 20-point power.
    expect(a1.points).toBe(220);
    expect(standingOf(state, 'a')).toMatchObject({ pointsFor: 620 });
  });

  test('15. mixed bounceback history: the off game storing 0 is N/A, not parts', () => {
    const state = mixedBouncebackMode();
    const games = acceptedGameRecords(state, {});
    // The scope still offers bouncebacks because game-1 uses them.
    expect(scopeScoringApplicability(state, games).bouncebacks).toBe(true);
    const a = standingOf(state, 'a');
    expect(a).toMatchObject({ gamesPlayed: 2, pointsFor: 650 });
    // Game-2's scorer-exported zero contributes no points, parts, or knownness.
    expect(a).toMatchObject({
      bouncebacksKnown: true,
      bouncebackPoints: 30,
      bouncebackPartsHeard: 9,
      bouncebackPartsConverted: 3,
    });
    expect(a.bouncebackConversion).toBeCloseTo(1 / 3, 12);
    expect(a.totalBonusConversion).toBeCloseTo(23 / 39, 12);
    const b = standingOf(state, 'b');
    expect(b).toMatchObject({
      bouncebacksKnown: true,
      bouncebackPoints: 0,
      bouncebackPartsHeard: 10,
      bouncebackPartsConverted: 0,
    });
    expect(b.bouncebackConversion).toBe(0);
    // Round aggregation skips the N/A game: 9 + 10 heard, 3 + 0 converted.
    const round = deriveRoundStats(state).find((entry) => entry.roundId === 'round-1')!;
    expect(round.bouncebacks).toBe(30);
    expect(round.bouncebackPartsHeard).toBe(19);
    expect(round.bouncebackPartsConverted).toBe(3);
    expect(round.bouncebackConversion).toBeCloseTo(3 / 19, 12);
  });

  test('16. mixed lightning history: the off game without a field is N/A, not unknown', () => {
    const state = mixedLightningMode();
    const games = acceptedGameRecords(state, {});
    expect(scopeScoringApplicability(state, games).lightning).toBe(true);
    const a = standingOf(state, 'a');
    expect(a).toMatchObject({ gamesPlayed: 2, lightningKnown: true, lightningPoints: 40 });
    // Denominator counts only the lightning-applicable non-forfeit game.
    expect(a.lightningGames).toBe(1);
    const b = standingOf(state, 'b');
    expect(b).toMatchObject({ lightningKnown: true, lightningPoints: 30, lightningGames: 1 });
  });

  test('17. overtime with a known split: normalized Pts/X excludes overtime points', () => {
    const state = overtimeKnownPointsMode();
    const a = standingOf(state, 'a');
    // Numerator: 330 total minus 30 known overtime = 300 regulation points.
    const regulation = regulationDerivationForTeam(a);
    expect(regulation).toMatchObject({ overtimePoints: 30, regulationPoints: 300 });
    // Denominator: 20 tossups read minus 2 overtime = 18 regulation TUH.
    expect(a).toMatchObject({ tossupsHeardRegulation: 18, tossupsHeardRegulationKnown: true });
    const x = scopeScoringApplicability(state, acceptedGameRecords(state, {})).regulationTossups;
    expect(x).toBe(20);
    // Final value excludes overtime; final-score scaling would give 330.
    expect(normalizedPointsPerX(regulation.regulationPoints, a.tossupsHeardRegulation, x)).toBeCloseTo(
      (300 / 18) * 20,
      12,
    );
    expect(normalizedPointsPerX(regulation.regulationPoints, a.tossupsHeardRegulation, x)).not.toBeCloseTo(
      330,
      12,
    );
  });

  test('18. overtime-capable game with an unknown split: Pts/X declines, never guesses', () => {
    const state = overtimeUnknownSplitMode();
    const a = standingOf(state, 'a');
    expect(a.overtimePointsKnown).toBe(false);
    // Regulation TUH is still known, but the points numerator is not.
    expect(a).toMatchObject({ tossupsHeardRegulation: 18, tossupsHeardRegulationKnown: true });
    const regulation = regulationDerivationForTeam(a);
    expect(regulation.overtimePoints).toBeNull();
    expect(regulation.regulationPoints).toBeNull();
    expect(normalizedPointsPerX(regulation.regulationPoints, a.tossupsHeardRegulation, 20)).toBeNull();
  });
});
