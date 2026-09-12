/**
 * Playoff slots: YellowFruit's ranking, ties that stop the line, and pool verification.
 *
 * Standings inputs are controlled synthetic prelim results. The expected orders below follow
 * YellowFruit's `PoolStats` rules (win share, then points per regulation tossup heard; ranks
 * shared on equal win share), so a failure here means the transcription drifted — not that
 * the test's arithmetic is merely different.
 */

import { describe, expect, test } from 'vitest';
import { assignSlotLabels, countDecidedPrelimGames, orderPrelimPool, verifyExpectedPrelimGames, verifyPlayoffPools } from './playoffs';
import { planPrelims, validateWildcatCompatibility } from './schedule';
import { loadedSynthetic, syntheticTeams, syntheticYftText } from '../tests/helpers';
import { loadShuttleTournament, tournamentIdentityFingerprint, type ShuttleTournament } from './tournament';

function prelimPhaseIdOf(tournament: ShuttleTournament): string {
  const compat = validateWildcatCompatibility(tournament);
  if (!compat.ok) throw new Error(compat.errors.join(' '));
  return compat.compat.prelimPhaseId;
}

function poolIdOf(tournament: ShuttleTournament, poolName: string): string {
  const pool = tournament.pools.find((entry) => entry.name === poolName);
  if (!pool) throw new Error(`no pool named ${poolName}`);
  return pool.id;
}

/**
 * Force a total order in pool A: seed s beats every lower seed listed after it.
 * Higher seed number = stronger here; margins differ so tossup tiebreaks separate everyone.
 */
function orderedResults(seeds: number[], round: number, base = 300) {
  const results = [];
  for (let i = 0; i < seeds.length; i += 1) {
    for (let j = i + 1; j < seeds.length; j += 1) {
      results.push({
        round,
        leftSeed: seeds[i],
        rightSeed: seeds[j],
        leftPoints: base + (seeds.length - i) * 10,
        rightPoints: base - (j + 1) * 10,
      });
    }
  }
  return results;
}

describe('prelim ordering', () => {
  test('a clear pool orders by record, then tossup numbers', () => {
    // Pool A round robin where seed order == strength: F1=seed1 … F6=seed12.
    const results = orderedResults([1, 4, 5, 8, 9, 12], 1);
    const tournament = loadedSynthetic({ prelimResults: results });
    const order = orderPrelimPool({
      tournament,
      prelimPhaseId: prelimPhaseIdOf(tournament),
      poolId: poolIdOf(tournament, 'FuzzyWuzzy'),
    });
    expect(order.tiedGroups).toEqual([]);
    const ids = order.standings.map((standing) => standing.teamId);
    expect(ids).toEqual([
      'Team_Seed1',
      'Team_Seed4',
      'Team_Seed5',
      'Team_Seed8',
      'Team_Seed9',
      'Team_Seed12',
    ]);
    const labels = assignSlotLabels(order, 'F');
    if (!labels.ok) throw new Error(labels.error);
    expect(labels.slots).toEqual({
      F1: 'Team_Seed1',
      F2: 'Team_Seed4',
      F3: 'Team_Seed5',
      F4: 'Team_Seed8',
      F5: 'Team_Seed9',
      F6: 'Team_Seed12',
    });
  });

  test('an equal record is an unresolved tie, never a silent ordering', () => {
    // Seeds 4 and 5 finish level on wins; tossup numbers differ.
    const results = [
      { round: 1, leftSeed: 1, rightSeed: 12, leftPoints: 400, rightPoints: 100 },
      { round: 1, leftSeed: 4, rightSeed: 5, leftPoints: 320, rightPoints: 320 },
      { round: 1, leftSeed: 8, rightSeed: 9, leftPoints: 200, rightPoints: 100 },
      { round: 2, leftSeed: 1, rightSeed: 4, leftPoints: 400, rightPoints: 300 },
      { round: 2, leftSeed: 5, rightSeed: 8, leftPoints: 350, rightPoints: 100 },
      { round: 2, leftSeed: 9, rightSeed: 12, leftPoints: 200, rightPoints: 100 },
      { round: 3, leftSeed: 1, rightSeed: 5, leftPoints: 400, rightPoints: 300 },
      { round: 3, leftSeed: 4, rightSeed: 8, leftPoints: 350, rightPoints: 100 },
      { round: 3, leftSeed: 9, rightSeed: 12, leftPoints: 200, rightPoints: 150 },
      { round: 4, leftSeed: 1, rightSeed: 8, leftPoints: 400, rightPoints: 100 },
      { round: 4, leftSeed: 4, rightSeed: 9, leftPoints: 300, rightPoints: 200 },
      { round: 4, leftSeed: 5, rightSeed: 12, leftPoints: 350, rightPoints: 100 },
      { round: 5, leftSeed: 1, rightSeed: 9, leftPoints: 400, rightPoints: 100 },
      { round: 5, leftSeed: 4, rightSeed: 12, leftPoints: 300, rightPoints: 100 },
      { round: 5, leftSeed: 5, rightSeed: 8, leftPoints: 350, rightPoints: 100 },
    ];
    const tournament = loadedSynthetic({ prelimResults: results });
    const order = orderPrelimPool({
      tournament,
      prelimPhaseId: prelimPhaseIdOf(tournament),
      poolId: poolIdOf(tournament, 'FuzzyWuzzy'),
    });
    // Seed 1 is 5–0; seeds 4 and 5 are both 4–1 and must tie for second.
    expect(order.standings[0].teamId).toBe('Team_Seed1');
    expect(order.tiedGroups).toHaveLength(1);
    expect([...order.tiedGroups[0]].sort()).toEqual(['Team_Seed4', 'Team_Seed5']);
    expect(order.standings[1].rankLabel).toBe('2=');
    expect(order.standings[2].rankLabel).toBe('2=');
  });

  test('the operator resolves a tie explicitly, and only inside the tied group', () => {
    const results = [{ round: 1, leftSeed: 4, rightSeed: 5, leftPoints: 320, rightPoints: 320 }];
    const tournament = loadedSynthetic({ prelimResults: results });
    const order = orderPrelimPool({
      tournament,
      prelimPhaseId: prelimPhaseIdOf(tournament),
      poolId: poolIdOf(tournament, 'FuzzyWuzzy'),
    });
    expect(order.tiedGroups.length).toBeGreaterThan(0);
    const group = order.tiedGroups[0];
    const reversed = [...group].reverse();
    const resolved = assignSlotLabels(order, 'F', reversed);
    if (!resolved.ok) throw new Error(resolved.error);
    // The operator's order fills the tied label positions exactly: F1 takes the first name
    // given, F2 the second — not whatever the file happened to list first.
    expect(resolved.slots.F1).toBe(reversed[0]);
    expect(resolved.slots.F2).toBe(reversed[1]);
    const partial = assignSlotLabels(order, 'F', [group[0]]);
    expect(partial.ok).toBe(false);
  });

  test('adjacent ties at different ranks stay separate groups', () => {
    // Seeds 1 and 4 go 2–0, seeds 5 and 8 go 1–1, seeds 9 and 12 go 0–2: three rank
    // labels, three manual ties. Keying groups on the `=` suffix alone would merge all
    // six into one; the rank label keeps 1=/3=/5= apart.
    const results = [
      { round: 1, leftSeed: 1, rightSeed: 9, leftPoints: 300, rightPoints: 200 },
      { round: 1, leftSeed: 1, rightSeed: 5, leftPoints: 300, rightPoints: 200 },
      { round: 1, leftSeed: 4, rightSeed: 12, leftPoints: 300, rightPoints: 200 },
      { round: 1, leftSeed: 4, rightSeed: 8, leftPoints: 300, rightPoints: 200 },
      { round: 1, leftSeed: 5, rightSeed: 12, leftPoints: 300, rightPoints: 200 },
      { round: 1, leftSeed: 8, rightSeed: 9, leftPoints: 300, rightPoints: 200 },
    ];
    const tournament = loadedSynthetic({ prelimResults: results });
    const order = orderPrelimPool({
      tournament,
      prelimPhaseId: prelimPhaseIdOf(tournament),
      poolId: poolIdOf(tournament, 'FuzzyWuzzy'),
    });
    expect(order.standings.map((standing) => standing.rankLabel)).toEqual([
      '1=',
      '1=',
      '3=',
      '3=',
      '5=',
      '5=',
    ]);
    expect(order.tiedGroups.map((group) => [...group].sort())).toEqual([
      ['Team_Seed1', 'Team_Seed4'],
      ['Team_Seed5', 'Team_Seed8'],
      ['Team_Seed12', 'Team_Seed9'],
    ]);
    // Each group resolves to its own label positions: F1/F2, then F3/F4, then F5/F6.
    const resolved = assignSlotLabels(order, 'F', [
      'Team_Seed4',
      'Team_Seed1',
      'Team_Seed8',
      'Team_Seed5',
      'Team_Seed12',
      'Team_Seed9',
    ]);
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.slots).toMatchObject({
      F1: 'Team_Seed4',
      F2: 'Team_Seed1',
      F3: 'Team_Seed8',
      F4: 'Team_Seed5',
      F5: 'Team_Seed12',
      F6: 'Team_Seed9',
    });
  });

  test('a forfeit decides the game without feeding tossup numbers', () => {
    const results = [
      { round: 1, leftSeed: 1, rightSeed: 12, leftPoints: 0, rightPoints: 0, forfeit: 'right' as const },
    ];
    const tournament = loadedSynthetic({ prelimResults: results });
    const order = orderPrelimPool({
      tournament,
      prelimPhaseId: prelimPhaseIdOf(tournament),
      poolId: poolIdOf(tournament, 'FuzzyWuzzy'),
    });
    const seed1 = order.standings.find((standing) => standing.teamId === 'Team_Seed1')!;
    const seed12 = order.standings.find((standing) => standing.teamId === 'Team_Seed12')!;
    expect(seed1.wins).toBe(1);
    expect(seed12.losses).toBe(1);
    expect(seed1.tossupsHeard).toBe(0);
    expect(
      countDecidedPrelimGames({
        tournament,
        prelimPhaseId: prelimPhaseIdOf(tournament),
      }),
    ).toBe(1);
  });

  test('overtime points leave the tossup numbers, as YellowFruit scores them', () => {
    const results = [
      {
        round: 1,
        leftSeed: 1,
        rightSeed: 12,
        leftPoints: 330,
        rightPoints: 300,
        overtimeTossups: 2,
      },
    ];
    const tournament = loadedSynthetic({ prelimResults: results });
    const order = orderPrelimPool({
      tournament,
      prelimPhaseId: prelimPhaseIdOf(tournament),
      poolId: poolIdOf(tournament, 'FuzzyWuzzy'),
    });
    const seed1 = order.standings.find((standing) => standing.teamId === 'Team_Seed1')!;
    // 20 heard, 2 in overtime: regulation hears 18 for an untimed format without OT bonuses.
    expect(seed1.tossupsHeard).toBe(18);
    expect(seed1.pointsForPpg).toBe(330);
  });
});

describe('playoff pool verification', () => {
  function rebracketed() {
    const teams = syntheticTeams();
    const id = (seed: number): string => teams.find((team) => team.seed === seed)!.id;
    const text = syntheticYftText({
      prelimResults: orderedResults([1, 4, 5, 8, 9, 12], 1).concat(orderedResults([2, 3, 6, 7, 10, 11], 1)),
      playoffPools: [
        { name: 'Gold', position: 1, teamIds: [id(1), id(4), id(5), id(2), id(3), id(6)] },
        { name: 'Maroon', position: 2, teamIds: [id(8), id(9), id(12), id(7), id(10), id(11)] },
      ],
    });
    const report = loadShuttleTournament(text);
    if (!report.ok) throw new Error(report.errors.join(' '));
    return report.tournament;
  }

  test('matching pools verify by membership, not by name', () => {
    const tournament = rebracketed();
    const compat = validateWildcatCompatibility(tournament);
    if (!compat.ok) throw new Error(compat.errors.join(' '));
    const verified = verifyPlayoffPools({
      tournament,
      playoffPhaseId: compat.compat.playoffPhaseId,
      slots: {
        F1: 'Team_Seed1',
        F2: 'Team_Seed4',
        F3: 'Team_Seed5',
        F4: 'Team_Seed8',
        F5: 'Team_Seed9',
        F6: 'Team_Seed12',
        B1: 'Team_Seed2',
        B2: 'Team_Seed3',
        B3: 'Team_Seed6',
        B4: 'Team_Seed7',
        B5: 'Team_Seed10',
        B6: 'Team_Seed11',
      },
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.goldPoolName).toBe('Gold');
      expect(verified.maroonPoolName).toBe('Maroon');
    }
  });

  test('a mismatched rebracket stops generation with an explanation', () => {
    const tournament = rebracketed();
    const compat = validateWildcatCompatibility(tournament);
    if (!compat.ok) throw new Error(compat.errors.join(' '));
    const verified = verifyPlayoffPools({
      tournament,
      playoffPhaseId: compat.compat.playoffPhaseId,
      // Operator claims seed 8 finished third — YellowFruit's pools disagree.
      slots: {
        F1: 'Team_Seed1',
        F2: 'Team_Seed4',
        F3: 'Team_Seed8',
        F4: 'Team_Seed5',
        F5: 'Team_Seed9',
        F6: 'Team_Seed12',
        B1: 'Team_Seed2',
        B2: 'Team_Seed3',
        B3: 'Team_Seed6',
        B4: 'Team_Seed7',
        B5: 'Team_Seed10',
        B6: 'Team_Seed11',
      },
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.error).toMatch(/Confirm advancement in YellowFruit first/);
  });
});

describe('expected prelim verification', () => {
  function expectedOf(tournament: ShuttleTournament) {
    const compat = validateWildcatCompatibility(tournament);
    if (!compat.ok) throw new Error(compat.errors.join(' '));
    return planPrelims(compat.compat).map((game) => ({
      roundNumber: game.roundNumber,
      slotId: game.slotId,
      leftTeamId: game.leftTeamId,
      rightTeamId: game.rightTeamId,
    }));
  }

  function fullResults() {
    // Every prelim pairing decided once, round by round, using the real pairings.
    const tournament = loadedSynthetic();
    const compat = validateWildcatCompatibility(tournament);
    if (!compat.ok) throw new Error(compat.errors.join(' '));
    const seedOf = new Map(tournament.teams.map((team) => [team.id, team.seed!]));
    const results: { round: number; leftSeed: number; rightSeed: number; leftPoints: number; rightPoints: number }[] = [];
    for (const game of planPrelims(compat.compat)) {
      results.push({
        round: game.roundNumber,
        leftSeed: seedOf.get(game.leftTeamId)!,
        rightSeed: seedOf.get(game.rightTeamId)!,
        leftPoints: 300,
        rightPoints: 200,
      });
    }
    return results;
  }

  test('30 of 30 expected games pass the gate', () => {
    const tournament = loadedSynthetic({ prelimResults: fullResults() });
    const compat = validateWildcatCompatibility(tournament);
    if (!compat.ok) throw new Error(compat.errors.join(' '));
    const gate = verifyExpectedPrelimGames({
      tournament,
      prelimPhaseId: compat.compat.prelimPhaseId,
      expected: expectedOf(tournament),
    });
    expect(gate.present).toBe(30);
    expect(gate.missing).toEqual([]);
    expect(gate.duplicated).toEqual([]);
    expect(gate.unexpected).toEqual([]);
  });

  test('a missing game names its round and room slot', () => {
    const all = fullResults().filter(
      (result) => !(result.round === 4 && result.leftSeed === 5 && result.rightSeed === 12),
    );
    const tournament = loadedSynthetic({ prelimResults: all });
    const gate = verifyExpectedPrelimGames({
      tournament,
      prelimPhaseId: prelimPhaseIdOf(tournament),
      expected: expectedOf(tournament),
    });
    expect(gate.present).toBe(29);
    expect(gate.missing).toEqual([{ roundNumber: 4, slotId: 'slot-gold-2' }]);
  });

  test('a doubled matchup does not substitute for a missing game', () => {
    const all = fullResults();
    const extra = { ...all[0] };
    const tournament = loadedSynthetic({ prelimResults: [...all, extra] });
    const gate = verifyExpectedPrelimGames({
      tournament,
      prelimPhaseId: prelimPhaseIdOf(tournament),
      expected: expectedOf(tournament),
    });
    expect(gate.duplicated).toHaveLength(1);
    expect(gate.duplicated[0].roundNumber).toBe(1);
  });
});

describe('reload identity', () => {
  test('the same tournament keeps its fingerprint; a different file does not reuse it', () => {
    const first = loadedSynthetic();
    const second = loadedSynthetic({ timed: true });
    expect(tournamentIdentityFingerprint(first)).toBe(tournamentIdentityFingerprint(second));
    const other = { ...first, id: 'Tournament_Other' };
    expect(tournamentIdentityFingerprint(other)).not.toBe(tournamentIdentityFingerprint(first));
  });
});
