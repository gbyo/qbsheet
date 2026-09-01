import { commitAdvancementPreview, createTournament, previewAdvancement } from '../src';
import type { Phase, Pool, TeamStandingRow } from '../src';
import { makeAcceptedResult, makeTeams, rules } from './helpers';

function phase(id: string, advancement: Phase['advancement']): Phase {
  return {
    id,
    name: id,
    order: id === 'prelim' ? 0 : 1,
    format: 'preliminary-pools',
    status: 'complete',
    poolIds: [],
    roundIds: [],
    advancement,
    notes: '',
  };
}

function pool(id: string, phaseId: string, teamIds: readonly string[], order: number): Pool {
  return { id, phaseId, name: id, order, teamIds, sourcePoolIds: [] };
}

function row(
  teamId: string,
  poolId: string,
  rank: number,
  tieStatus: TeamStandingRow['tieStatus'] = 'clear',
): TeamStandingRow {
  return {
    teamId,
    poolId,
    rank,
    tieStatus,
    gamesPlayed: 3,
    wins: 2,
    losses: 1,
    ties: 0,
    winPercentage: 2 / 3,
    pointsFor: 400,
    pointsAgainst: 300,
    pointsPerGame: 133.3,
    pointsAgainstPerGame: 100,
    margin: 100,
    powers: 5,
    gets: 20,
    negs: 2,
    tossupsHeard: 60,
    pointsPerTossupHeard: 6.6,
    bonusPoints: 100,
    bonusesHeard: 20,
    pointsPerBonus: 5,
    bouncebacks: 0,
    lightningPoints: 0,
    overtimePoints: 0,
    seed: rank,
  };
}

describe('advancement and rebracketing previews', () => {
  it('creates a deterministic snake rebracket and carries over qualifying games when configured', () => {
    const teams = makeTeams(4);
    const sourcePhase = phase('prelim', {
      qualifiersPerPool: 2,
      totalQualifiers: null,
      targetPoolCount: 1,
      seeding: 'straight',
      tiePolicy: 'block',
      carryover: 'all',
    });
    const targetPhase = phase('playoffs', null);
    const sourcePool = pool(
      'pool-a',
      'prelim',
      teams.map((team) => team.id),
      0,
    );
    const targetPool = pool('pool-final', 'playoffs', [], 0);
    const scheduledGame = {
      id: 'game-1',
      phaseId: 'prelim',
      roundId: 'round-1',
      poolId: 'pool-a',
      sequence: 0,
      kind: 'game' as const,
      teamAId: 'team-1',
      teamBId: 'team-2',
      roomId: null,
      packetId: null,
      status: 'completed' as const,
      notes: '',
    };
    const standings = {
      rows: [
        row('team-1', 'pool-a', 1),
        row('team-2', 'pool-a', 2),
        row('team-3', 'pool-a', 3),
        row('team-4', 'pool-a', 4),
      ],
      playerRows: [],
      unresolvedTies: [],
      includedResultIds: [],
      ignoredResultIds: [],
    };
    const preview = previewAdvancement({
      sourcePhase,
      sourcePools: [sourcePool],
      targetPhase,
      targetPools: [targetPool],
      standings,
      scheduledGames: [scheduledGame],
      acceptedResults: [makeAcceptedResult(scheduledGame, 210, 180)],
    });

    expect(preview.blocked).toBe(false);
    expect(preview.assignments.map((assignment) => assignment.teamId)).toEqual(['team-1', 'team-2']);
    expect(preview.assignments.every((assignment) => assignment.targetPoolId === 'pool-final')).toBe(true);
    expect(preview.carryovers).toEqual([
      expect.objectContaining({ sourceGameId: 'game-1', scoreA: 210, scoreB: 180 }),
    ]);

    const snapshot = {
      ...createTournament({ id: 'tournament-1', name: 'Test', rules }),
      phases: [sourcePhase, targetPhase],
      pools: [sourcePool, targetPool],
      teams,
      scheduledGames: [scheduledGame],
    };
    const committed = commitAdvancementPreview(snapshot, preview, { actor: 'director' });
    expect(committed.pools.find((candidate) => candidate.id === 'pool-final')?.teamIds).toEqual([
      'team-1',
      'team-2',
    ]);
    expect(committed.phases.find((candidate) => candidate.id === 'playoffs')?.status).toBe('scheduled');
    expect(committed.auditEvents.at(-1)?.type).toBe('advancement-committed');
  });

  it('blocks an unresolved cut-line tie until an explicit override is supplied', () => {
    const teams = makeTeams(4);
    const sourcePhase = phase('prelim', {
      qualifiersPerPool: 2,
      totalQualifiers: null,
      targetPoolCount: 1,
      seeding: 'straight',
      tiePolicy: 'manual-override',
      carryover: 'none',
    });
    const targetPhase = phase('playoffs', null);
    const sourcePool = pool(
      'pool-a',
      'prelim',
      teams.map((team) => team.id),
      0,
    );
    const targetPool = pool('pool-final', 'playoffs', [], 0);
    const standings = {
      rows: [
        row('team-1', 'pool-a', 1),
        row('team-2', 'pool-a', 2, 'unresolved'),
        row('team-3', 'pool-a', 2, 'unresolved'),
        row('team-4', 'pool-a', 4),
      ],
      playerRows: [],
      unresolvedTies: [{ teamIds: ['team-2', 'team-3'], poolId: 'pool-a', reason: 'tie' }],
      includedResultIds: [],
      ignoredResultIds: [],
    };
    const common = {
      sourcePhase,
      sourcePools: [sourcePool],
      targetPhase,
      targetPools: [targetPool],
      standings,
      scheduledGames: [],
      acceptedResults: [],
    };
    const blocked = previewAdvancement(common);
    expect(blocked.blocked).toBe(true);
    expect(blocked.issues.some((issue) => issue.code === 'ambiguous-cutoff')).toBe(true);

    const resolved = previewAdvancement({
      ...common,
      overrides: [
        {
          teamId: 'team-2',
          sourcePoolId: 'pool-a',
          rank: 2,
          reason: 'Head-to-head ruling',
          actor: 'director',
        },
        {
          teamId: 'team-3',
          sourcePoolId: 'pool-a',
          rank: 3,
          reason: 'Head-to-head ruling',
          actor: 'director',
        },
      ],
    });
    expect(resolved.blocked).toBe(false);
    expect(resolved.assignments.map((assignment) => assignment.teamId)).toEqual(['team-1', 'team-2']);
  });
});
