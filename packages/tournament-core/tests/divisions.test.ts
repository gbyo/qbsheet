import { describe, expect, it } from 'vitest';
import {
  previewDivisionPlacement,
  suggestPoolPlacementDivisions,
  type DivisionDefinition,
  type PoolStandings,
} from '../src/divisions';
import type { TeamStandingRow } from '../src/statistics';

interface RowInput {
  readonly teamId: string;
  readonly rank: number;
  readonly wins: number;
  readonly gamesPlayed: number;
  readonly pointsFor?: number;
  readonly tieStatus?: TeamStandingRow['tieStatus'];
  readonly seed?: number | null;
}

function row(input: RowInput): TeamStandingRow {
  const gamesPlayed = input.gamesPlayed;
  const pointsFor = input.pointsFor ?? 300 - input.rank * 10;
  return {
    teamId: input.teamId,
    poolId: null,
    gamesPlayed,
    wins: input.wins,
    losses: gamesPlayed - input.wins,
    ties: 0,
    winPercentage: gamesPlayed === 0 ? 0 : input.wins / gamesPlayed,
    pointsFor,
    pointsAgainst: 200,
    pointsPerGame: gamesPlayed === 0 ? 0 : pointsFor / gamesPlayed,
    pointsAgainstPerGame: gamesPlayed === 0 ? 0 : 200 / gamesPlayed,
    margin: pointsFor - 200,
    powers: 0,
    gets: 0,
    negs: 0,
    tossupsHeard: gamesPlayed * 20,
    pointsPerTossupHeard: gamesPlayed === 0 ? 0 : pointsFor / (gamesPlayed * 20),
    bonusPoints: 0,
    bonusesHeard: 0,
    pointsPerBonus: 0,
    bouncebacks: 0,
    lightningPoints: 0,
    overtimePoints: 0,
    seed: input.seed ?? null,
    rank: input.rank,
    tieStatus: input.tieStatus ?? 'clear',
  };
}

/** Three six-team pools where every team's record is unambiguous. */
function evenPools(): PoolStandings[] {
  return ['A', 'B', 'C'].map((letter) => ({
    poolId: `pool-${letter}`,
    poolName: `Pool ${letter}`,
    rows: Array.from({ length: 6 }, (_, index) =>
      row({
        teamId: `${letter}${index + 1}`,
        rank: index + 1,
        wins: 5 - index,
        gamesPlayed: 5,
        // Pool A's teams are strongest, then B, then C, so a global ranking is deterministic.
        pointsFor: 400 - letter.charCodeAt(0) * 3 - index * 20,
      }),
    ),
  }));
}

/** A 6/6/5 morning: the third pool played one fewer game per team. */
function unevenPools(): PoolStandings[] {
  const [poolA, poolB] = evenPools();
  return [
    poolA,
    poolB,
    {
      poolId: 'pool-C',
      poolName: 'Pool C',
      rows: Array.from({ length: 5 }, (_, index) =>
        row({
          teamId: `C${index + 1}`,
          rank: index + 1,
          wins: 4 - index,
          gamesPlayed: 4,
          pointsFor: 380 - index * 20,
        }),
      ),
    },
  ];
}

const threeDivisions: DivisionDefinition[] = [
  { id: 'champ', name: 'Championship', order: 1, placements: [1, 2] },
  { id: 'div2', name: 'Division II', order: 2, placements: [3, 4] },
  { id: 'div3', name: 'Division III', order: 3, remainder: true },
];

describe('pool-placement division mapping', () => {
  it('puts the top two from each pool in the Championship division', () => {
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: evenPools(),
    });
    expect(preview.blocked).toBe(false);
    const champ = preview.divisions.find((division) => division.id === 'champ');
    expect(champ?.members).toHaveLength(6);
    expect(champ?.members.map((member) => member.sourceRank)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(champ?.members.map((member) => member.seed)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('seeds the pool winners ahead of the runners-up', () => {
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: evenPools(),
    });
    const champ = preview.divisions.find((division) => division.id === 'champ');
    expect(champ?.members.slice(0, 3).every((member) => member.sourceRank === 1)).toBe(true);
    expect(champ?.members.slice(3).every((member) => member.sourceRank === 2)).toBe(true);
  });

  it('explains why each team landed where it did', () => {
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: evenPools(),
    });
    const champ = preview.divisions.find((division) => division.id === 'champ');
    expect(champ?.members.map((member) => member.reason)).toContain('Pool A · 1st');
    expect(champ?.members.map((member) => member.reason)).toContain('Pool C · 2nd');
  });

  it('takes places three and four into the second division', () => {
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: evenPools(),
    });
    const second = preview.divisions.find((division) => division.id === 'div2');
    expect(second?.members).toHaveLength(6);
    expect(new Set(second?.members.map((member) => member.sourceRank))).toEqual(new Set([3, 4]));
  });

  it('sweeps everyone else into the remainder division', () => {
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: evenPools(),
    });
    const third = preview.divisions.find((division) => division.id === 'div3');
    expect(third?.members).toHaveLength(6);
    expect(preview.unplacedTeamIds).toEqual([]);
  });

  it('produces a short lower division when the pools are uneven', () => {
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: unevenPools(),
    });
    expect(preview.divisions.map((division) => division.members.length)).toEqual([6, 6, 5]);
    expect(preview.blocked).toBe(false);
  });

  it('leaves no team unplaced for a 6/5/5 morning', () => {
    const pools = unevenPools();
    pools[1] = {
      poolId: 'pool-B',
      poolName: 'Pool B',
      rows: Array.from({ length: 5 }, (_, index) =>
        row({ teamId: `B${index + 1}`, rank: index + 1, wins: 4 - index, gamesPlayed: 4 }),
      ),
    };
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: pools,
    });
    expect(preview.divisions.map((division) => division.members.length)).toEqual([6, 6, 4]);
    expect(preview.unplacedTeamIds).toEqual([]);
  });

  it('refuses raw wins as the comparison when pools played different numbers of games', () => {
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: unevenPools(),
      rankingBasis: 'wins',
    });
    expect(preview.blocked).toBe(true);
    expect(preview.issues.map((issue) => issue.code)).toContain('unequal-schedule-raw-wins');
  });

  it('accepts raw wins when every pool played the same schedule', () => {
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: evenPools(),
      rankingBasis: 'wins',
    });
    expect(preview.blocked).toBe(false);
  });

  it('reports every team when no division claims them', () => {
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: [{ id: 'champ', name: 'Championship', order: 1, placements: [1] }],
      poolStandings: evenPools(),
    });
    expect(preview.blocked).toBe(true);
    expect(preview.issues.map((issue) => issue.code)).toContain('unplaced-teams');
    expect(preview.unplacedTeamIds).toHaveLength(15);
  });

  it('supports one, two, and four divisions as readily as three', () => {
    for (const count of [1, 2, 4]) {
      const preview = previewDivisionPlacement({
        method: 'pool-placement',
        divisions: suggestPoolPlacementDivisions(count),
        poolStandings: evenPools(),
      });
      expect(preview.divisions).toHaveLength(count);
      expect(preview.unplacedTeamIds).toEqual([]);
      expect(preview.blocked).toBe(false);
    }
  });
});

describe('global seeded ranking', () => {
  const globalDivisions: DivisionDefinition[] = [
    { id: 'd1', name: 'Division I', order: 1, seedRange: { from: 1, to: 6 } },
    { id: 'd2', name: 'Division II', order: 2, seedRange: { from: 7, to: 12 } },
    { id: 'd3', name: 'Division III', order: 3, remainder: true },
  ];

  it('needs an explicit ranking basis before it will compare pools', () => {
    const preview = previewDivisionPlacement({
      method: 'global-seed',
      divisions: globalDivisions,
      poolStandings: evenPools(),
    });
    expect(preview.blocked).toBe(true);
    expect(preview.issues.map((issue) => issue.code)).toContain('missing-ranking-basis');
  });

  it('splits the field by overall seed once a basis is configured', () => {
    const preview = previewDivisionPlacement({
      method: 'global-seed',
      divisions: globalDivisions,
      poolStandings: evenPools(),
      rankingBasis: 'win-percentage',
    });
    expect(preview.blocked).toBe(false);
    expect(preview.divisions.map((division) => division.members.length)).toEqual([6, 6, 6]);
    expect(preview.divisions[0].members.map((member) => member.overallRank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(preview.divisions[0].members[0].reason).toBe('Overall seed 1');
  });

  it('never determines placement from raw wins across unequal schedules', () => {
    const preview = previewDivisionPlacement({
      method: 'global-seed',
      divisions: globalDivisions,
      poolStandings: unevenPools(),
      rankingBasis: 'wins',
    });
    expect(preview.blocked).toBe(true);
    expect(preview.issues.map((issue) => issue.code)).toContain('unequal-schedule-raw-wins');
  });

  it('warns that pools played different schedules even on a fair basis', () => {
    const preview = previewDivisionPlacement({
      method: 'global-seed',
      divisions: globalDivisions,
      poolStandings: unevenPools(),
      rankingBasis: 'win-percentage',
    });
    expect(preview.blocked).toBe(false);
    expect(preview.issues.map((issue) => issue.code)).toContain('unequal-schedule-note');
  });

  it('blocks when the cut line falls inside teams the basis cannot separate', () => {
    const pools: PoolStandings[] = [
      {
        poolId: 'pool-A',
        poolName: 'Pool A',
        rows: [
          row({ teamId: 'A1', rank: 1, wins: 4, gamesPlayed: 4 }),
          row({ teamId: 'A2', rank: 2, wins: 2, gamesPlayed: 4 }),
        ],
      },
      {
        poolId: 'pool-B',
        poolName: 'Pool B',
        rows: [
          row({ teamId: 'B1', rank: 1, wins: 3, gamesPlayed: 4 }),
          row({ teamId: 'B2', rank: 2, wins: 2, gamesPlayed: 4 }),
        ],
      },
    ];
    const preview = previewDivisionPlacement({
      method: 'global-seed',
      divisions: [
        { id: 'd1', name: 'Division I', order: 1, seedRange: { from: 1, to: 3 } },
        { id: 'd2', name: 'Division II', order: 2, remainder: true },
      ],
      poolStandings: pools,
      rankingBasis: 'win-percentage',
    });
    expect(preview.blocked).toBe(true);
    expect(preview.issues.map((issue) => issue.code)).toContain('ambiguous-cutoff');
  });
});

describe('unresolved preliminary ties', () => {
  function tiedPools(): PoolStandings[] {
    const pools = evenPools();
    pools[0] = {
      ...pools[0],
      rows: pools[0].rows.map((entry, index) =>
        index === 1 || index === 2
          ? { ...entry, rank: 2, wins: 3, winPercentage: 0.6, tieStatus: 'unresolved' as const }
          : entry,
      ),
    };
    return pools;
  }

  it('blocks a tie that decides which division a team enters', () => {
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: tiedPools(),
    });
    expect(preview.blocked).toBe(true);
    expect(preview.unresolvedTies[0].affects).toBe('division-membership');
    expect(preview.unresolvedTies[0].teamIds).toEqual(['A2', 'A3']);
  });

  it('describes a tie that only decides a seed as a bye question, not a membership one', () => {
    const pools = evenPools();
    pools[0] = {
      ...pools[0],
      rows: pools[0].rows.map((entry, index) =>
        index === 0 || index === 1
          ? { ...entry, rank: 1, wins: 4, winPercentage: 0.8, tieStatus: 'unresolved' as const }
          : entry,
      ),
    };
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: pools,
    });
    expect(preview.unresolvedTies[0].affects).toBe('bracket-seed');
    expect(preview.unresolvedTies[0].message).toContain('first-round bye');
  });

  it('accepts the automatic placement when the configured policy is to use the original seed', () => {
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: tiedPools(),
      tiePolicy: 'use-seed',
    });
    expect(preview.blocked).toBe(false);
    expect(preview.unresolvedTies).toEqual([]);
  });

  it('clears the block once every tied team has an audited manual decision', () => {
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: tiedPools(),
      overrides: [
        { teamId: 'A2', divisionId: 'champ', seed: 4, reason: 'Head-to-head on the day', actor: 'Director' },
        { teamId: 'A3', divisionId: 'div2', reason: 'Head-to-head on the day', actor: 'Director' },
      ],
    });
    expect(preview.blocked).toBe(false);
    expect(preview.divisions[0].members.find((member) => member.teamId === 'A2')?.manual).toBe(true);
  });
});

describe('manual overrides', () => {
  it('require a reason and an operator', () => {
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: evenPools(),
      overrides: [{ teamId: 'A1', divisionId: 'div2', reason: '  ', actor: '' }],
    });
    expect(preview.blocked).toBe(true);
    expect(preview.issues.map((issue) => issue.code)).toContain('incomplete-override');
  });

  it('move a team between divisions and are not recomputed away', () => {
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: evenPools(),
      overrides: [
        { teamId: 'A1', divisionId: 'div2', seed: 1, reason: 'Withdrew from contention', actor: 'Director' },
      ],
    });
    expect(preview.divisions[0].members.map((member) => member.teamId)).not.toContain('A1');
    const moved = preview.divisions[1].members[0];
    expect(moved.teamId).toBe('A1');
    expect(moved.manual).toBe(true);
    expect(moved.reason).toContain('Withdrew from contention');
    expect(preview.divisions.reduce((total, division) => total + division.members.length, 0)).toBe(18);
  });

  it('reject an override that names an unknown division', () => {
    const preview = previewDivisionPlacement({
      method: 'pool-placement',
      divisions: threeDivisions,
      poolStandings: evenPools(),
      overrides: [{ teamId: 'A1', divisionId: 'nope', reason: 'x', actor: 'Director' }],
    });
    expect(preview.issues.map((issue) => issue.code)).toContain('unknown-override-division');
  });
});

describe('suggestPoolPlacementDivisions', () => {
  it('gives the last division the remaining teams and the others fixed places', () => {
    const divisions = suggestPoolPlacementDivisions(3);
    expect(divisions.map((division) => division.name)).toEqual([
      'Championship',
      'Division II',
      'Division III',
    ]);
    expect(divisions[0].placements).toEqual([1, 2]);
    expect(divisions[1].placements).toEqual([3, 4]);
    expect(divisions[2].remainder).toBe(true);
  });
});
