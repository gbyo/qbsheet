import { describe, expect, it } from 'vitest';
import {
  planPoolPrelimsWithPlayoffDivisions,
  poolName,
  recommendPoolPrelimPlayoffPlan,
  recommendPoolSizes,
  recommendPrelimStructure,
  roundsForPool,
  validatePoolRotation,
} from '../src/formatPlan';

describe('recommendPoolSizes', () => {
  it('recommends the pool sizes this format expects for a 16–18 team field', () => {
    expect(recommendPoolSizes(18, 3)).toEqual([6, 6, 6]);
    expect(recommendPoolSizes(17, 3)).toEqual([6, 6, 5]);
    expect(recommendPoolSizes(16, 3)).toEqual([6, 5, 5]);
  });

  it('never differs by more than one team on its own recommendation', () => {
    for (let teams = 4; teams <= 40; teams += 1) {
      for (let pools = 1; pools <= 6; pools += 1) {
        const sizes = recommendPoolSizes(teams, pools);
        expect(sizes.reduce((total, size) => total + size, 0)).toBe(teams);
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('recommendPrelimStructure', () => {
  it.each([
    [16, 3, [6, 5, 5]],
    [17, 3, [6, 6, 5]],
    [18, 3, [6, 6, 6]],
  ])('proposes three pools and five rounds for %i teams', (teams, pools, sizes) => {
    const structure = recommendPrelimStructure(teams);
    expect(structure.poolCount).toBe(pools);
    expect(structure.poolSizes).toEqual(sizes);
    expect(structure.prelimRounds).toBe(5);
  });
});

describe('roundsForPool', () => {
  it('needs five rounds for both a six-team and a five-team pool', () => {
    expect(roundsForPool(6)).toBe(5);
    expect(roundsForPool(5)).toBe(5);
  });

  it('needs three rounds for a four-team pool', () => {
    expect(roundsForPool(4)).toBe(3);
  });
});

describe('validatePoolRotation', () => {
  it('accepts a 6/6/5 morning over five rounds', () => {
    const report = validatePoolRotation([6, 6, 5], 5);
    expect(report.valid).toBe(true);
    expect(report.perPool.map((pool) => pool.gamesPerTeam)).toEqual([5, 5, 4]);
    expect(report.perPool.map((pool) => pool.byesPerTeam)).toEqual([0, 0, 1]);
  });

  it('explains rather than generates when a pool cannot fill the configured rounds', () => {
    const report = validatePoolRotation([6, 4], 5);
    expect(report.valid).toBe(true);
    const codes = report.issues.map((issue) => issue.code);
    expect(codes).toContain('rotation-leaves-idle-rounds');
    expect(report.perPool[1].idleRounds).toBe(2);
  });

  it('refuses a pool that needs more rounds than the morning has', () => {
    const report = validatePoolRotation([8], 5);
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain('rotation-too-long');
  });

  it('warns about a deliberate imbalance without forbidding it', () => {
    const report = validatePoolRotation([9, 5, 4], 9);
    expect(report.valid).toBe(true);
    expect(report.issues.map((issue) => issue.code)).toContain('unusual-pool-imbalance');
  });

  it('flags that unequal pools cannot be compared on raw wins', () => {
    const report = validatePoolRotation([6, 6, 5], 5);
    expect(report.issues.map((issue) => issue.code)).toContain('unequal-games-played');
  });
});

describe('planPoolPrelimsWithPlayoffDivisions', () => {
  it('numbers the day 1–8 with five preliminary and three playoff rounds', () => {
    const plan = recommendPoolPrelimPlayoffPlan(18);
    expect(plan.prelimRoundNumbers).toEqual([1, 2, 3, 4, 5]);
    expect(plan.playoffRoundNumbers).toEqual([6, 7, 8]);
    expect(plan.totalRounds).toBe(8);
  });

  it('produces three six-team divisions for an 18-team field', () => {
    const plan = recommendPoolPrelimPlayoffPlan(18);
    expect(plan.poolSizes).toEqual([6, 6, 6]);
    expect(plan.divisions.map((division) => division.teamCount)).toEqual([6, 6, 6]);
    expect(plan.valid).toBe(true);
    for (const division of plan.divisions) {
      expect(division.bracket.byes.map((bye) => bye.seed)).toEqual([1, 2]);
      expect(division.roundNumbers).toEqual([6, 7, 8]);
    }
  });

  it('explains the extra bye a 17-team field forces on the third division', () => {
    const plan = recommendPoolPrelimPlayoffPlan(17);
    expect(plan.poolSizes).toEqual([6, 6, 5]);
    expect(plan.divisions.map((division) => division.teamCount)).toEqual([6, 6, 5]);
    const third = plan.divisions[2];
    expect(third.bracket.byes.map((bye) => bye.seed)).toEqual([1, 2, 3]);
    expect(plan.notes.join(' ')).toContain('Division III: Additional bracket bye');
    expect(plan.valid).toBe(true);
  });

  it('produces a four-team lower division for a 16-team field and rests it in round 7', () => {
    const plan = recommendPoolPrelimPlayoffPlan(16);
    expect(plan.poolSizes).toEqual([6, 5, 5]);
    expect(plan.divisions.map((division) => division.teamCount)).toEqual([6, 6, 4]);
    const third = plan.divisions[2];
    expect(third.roundNumbers).toEqual([6, 8]);
    expect(third.unusedRoundNumbers).toEqual([7]);
    expect(plan.notes.join(' ')).toContain('no game in round 7');
  });

  it('plays the smaller division late instead when that policy is chosen', () => {
    const plan = planPoolPrelimsWithPlayoffDivisions({
      teamCount: 16,
      poolCount: 3,
      poolSizes: [6, 5, 5],
      prelimRounds: 5,
      divisionCount: 3,
      playoffRoundCount: 3,
      bracketRoundPolicy: 'latest',
    });
    expect(plan.divisions[2].roundNumbers).toEqual([7, 8]);
    expect(plan.divisions[2].unusedRoundNumbers).toEqual([6]);
  });

  it('reports how many games a team can expect without pretending everyone plays the same number', () => {
    const plan = recommendPoolPrelimPlayoffPlan(17);
    expect(plan.prelimGamesPerTeam).toEqual([4, 5]);
    expect(plan.playoffGamesPerTeam).toEqual({ minimum: 1, maximum: 3 });
    expect(plan.notes.join(' ')).toContain('4 or 5 preliminary games');
  });

  it('rejects pool sizes that do not add up to the field', () => {
    const plan = planPoolPrelimsWithPlayoffDivisions({
      teamCount: 18,
      poolSizes: [6, 6, 5],
      prelimRounds: 5,
    });
    expect(plan.valid).toBe(false);
    expect(plan.issues.map((issue) => issue.code)).toContain('pool-size-mismatch');
  });

  it('rejects an afternoon with fewer rounds than the deepest division needs', () => {
    const plan = planPoolPrelimsWithPlayoffDivisions({
      teamCount: 18,
      poolCount: 3,
      prelimRounds: 5,
      divisionCount: 3,
      playoffRoundCount: 2,
    });
    expect(plan.valid).toBe(false);
    expect(plan.issues.map((issue) => issue.code)).toContain('insufficient-playoff-rounds');
  });

  it('refuses to plan divisions that would be empty', () => {
    const plan = planPoolPrelimsWithPlayoffDivisions({
      teamCount: 12,
      poolCount: 2,
      prelimRounds: 5,
      divisionCount: 5,
      playoffRoundCount: 3,
    });
    expect(plan.valid).toBe(false);
    expect(plan.issues.map((issue) => issue.code)).toContain('empty-division');
  });

  it('supports the global seeded ranking split as well as pool placement', () => {
    const plan = planPoolPrelimsWithPlayoffDivisions({
      teamCount: 18,
      poolCount: 3,
      prelimRounds: 5,
      divisionCount: 3,
      playoffRoundCount: 3,
      placementMethod: 'global-seed',
    });
    expect(plan.divisions.map((division) => division.seedRange)).toEqual([
      { from: 1, to: 6 },
      { from: 7, to: 12 },
      null,
    ]);
    expect(plan.divisions.map((division) => division.teamCount)).toEqual([6, 6, 6]);
  });

  it('supports a two-division afternoon', () => {
    const plan = planPoolPrelimsWithPlayoffDivisions({
      teamCount: 18,
      poolCount: 3,
      prelimRounds: 5,
      divisionCount: 2,
      playoffRoundCount: 4,
    });
    expect(plan.divisions.map((division) => division.teamCount)).toEqual([6, 12]);
    expect(plan.divisions[1].bracket.roundCount).toBe(4);
    expect(plan.valid).toBe(true);
  });
});

describe('poolName', () => {
  it('names pools the way they are read aloud', () => {
    expect([0, 1, 2, 25, 26].map(poolName)).toEqual(['Pool A', 'Pool B', 'Pool C', 'Pool Z', 'Pool AA']);
  });
});
