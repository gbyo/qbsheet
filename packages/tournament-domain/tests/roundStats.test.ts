import { describe, expect, test } from 'vitest';
import {
  defaultRules,
  deriveRoundStats,
  emptyDirectorState,
  type DirectorState,
  type TeamGameScore,
} from '../src/index.js';

const at = '2026-09-09T12:00:00.000Z';

function teamScore(teamId: string, score: number, detail: Partial<TeamGameScore> = {}): TeamGameScore {
  return {
    teamId,
    score,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonuses: 0,
    bonusPoints: 0,
    bouncebacks: 0,
    ...detail,
  };
}

function roundState(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 't',
    name: 'Round stats',
    date: '2026-09-09',
    venue: '',
    organizer: '',
    status: 'running',
    timeZone: 'America/New_York',
    rules: structuredClone(defaultRules),
    formatId: null,
    currentPhaseId: 'phase-1',
    currentPacketId: null,
    currentRoundId: null,
    createdAt: at,
    updatedAt: at,
  };
  state.teams = ['a', 'b', 'c', 'd'].map((id) => ({
    id,
    organizationId: null,
    displayName: id.toUpperCase(),
    teamLetter: 'A',
    seed: null,
    status: 'confirmed' as const,
    createdAt: at,
    updatedAt: at,
  }));
  state.rounds = [
    {
      id: 'round-z',
      phaseId: 'phase-1',
      name: 'Round 1',
      number: 1,
      revision: 1,
      status: 'closed',
      packetId: 'packet-1',
      scheduledGameIds: ['s1', 's2'],
      dayOrder: 0,
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
    },
    {
      id: 'round-a',
      phaseId: 'phase-1',
      name: 'Round 2',
      number: 2,
      revision: 1,
      status: 'closed',
      packetId: 'packet-2',
      scheduledGameIds: ['s3', 's4'],
      dayOrder: 1,
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
    },
  ];
  state.scheduledGames = [
    ['s1', 'round-z', 'a', 'b'],
    ['s2', 'round-z', 'c', 'd'],
    ['s3', 'round-a', 'a', 'c'],
    ['s4', 'round-a', 'b', 'd'],
  ].map(([id, roundId, leftTeamId, rightTeamId]) => ({
    id: id!,
    roundId: roundId!,
    roomId: null,
    packetId: roundId === 'round-z' ? 'packet-1' : 'packet-2',
    leftTeamId: leftTeamId!,
    rightTeamId: rightTeamId!,
    bye: false,
    status: 'accepted' as const,
    assignmentRevision: 1,
  }));
  state.games = [
    {
      id: 'g1',
      scheduledGameId: 's1',
      roundId: 'round-z',
      packetId: 'packet-1',
      status: 'accepted',
      scores: [
        teamScore('a', 300, { powers: 2, gets: 4, negs: 1, bonuses: 6, bonusPoints: 90 }),
        teamScore('b', 200, { powers: 1, gets: 3, negs: 2, bonuses: 4, bonusPoints: 50 }),
      ],
      playerStats: [],
      source: 'manual',
      detailedStats: 'complete',
    },
    {
      id: 'g2',
      scheduledGameId: 's2',
      roundId: 'round-z',
      packetId: 'packet-1',
      status: 'accepted',
      scores: [teamScore('c', 250), teamScore('d', 150)],
      playerStats: [],
      source: 'paper',
      detailedStats: 'unknown',
    },
    {
      id: 'g3',
      scheduledGameId: 's3',
      roundId: 'round-a',
      packetId: 'packet-2',
      status: 'accepted',
      scores: [
        teamScore('a', 280, { powers: 1, gets: 5, negs: 0, bonuses: 6, bonusPoints: 84 }),
        teamScore('c', 220, { powers: 0, gets: 4, negs: 1, bonuses: 5, bonusPoints: 60 }),
      ],
      playerStats: [],
      source: 'manual',
      detailedStats: 'complete',
    },
    {
      id: 'g4',
      scheduledGameId: 's4',
      roundId: 'round-a',
      packetId: 'packet-2',
      status: 'forfeit',
      forfeitedTeamId: 'd',
      scores: [teamScore('b', 0), teamScore('d', 0)],
      playerStats: [],
      source: 'manual',
      detailedStats: 'unknown',
    },
  ];
  return state;
}

describe('deriveRoundStats', () => {
  test('orders by tournament day and keeps exact point averages even when detail is partial', () => {
    const rows = deriveRoundStats(roundState());

    expect(rows.map((row) => row.roundName)).toEqual(['Round 1', 'Round 2']);
    expect(rows[0]).toMatchObject({
      games: 2,
      playedGames: 2,
      detailedGames: 1,
      pointsPerTeam: 225,
      powers: null,
      gets: null,
      negs: null,
      bonusesHeard: null,
      bonusPoints: null,
      ppb: null,
      packetIds: ['packet-1'],
    });
  });

  test('computes PPB and count aggregates only when every eligible played game has detail', () => {
    const row = deriveRoundStats(roundState())[1]!;

    // The administrative 0-0 forfeit is a result, but not a played scoring sample.
    expect(row.games).toBe(2);
    expect(row.playedGames).toBe(1);
    expect(row.detailedGames).toBe(1);
    expect(row.pointsPerTeam).toBe(250);
    expect(row).toMatchObject({
      powers: 1,
      gets: 9,
      negs: 1,
      bonusesHeard: 11,
      bonusPoints: 144,
      packetIds: ['packet-2'],
    });
    expect(row.ppb).toBeCloseTo(144 / 11);
  });

  test('declines tossup-normalized rates instead of fabricating denominators', () => {
    for (const row of deriveRoundStats(roundState())) {
      expect(row.tossupsRead).toBeNull();
      expect(row.pointsPerTeamPerXTuh).toBeNull();
      expect(row.powerRate).toBeNull();
      expect(row.tossupConversionRate).toBeNull();
      expect(row.negRatePerXTuh).toBeNull();
    }
  });

  test('respects canonical phase scoping', () => {
    expect(deriveRoundStats(roundState(), { phaseId: 'missing' })).toEqual([]);
    expect(deriveRoundStats(roundState(), { phaseId: 'phase-1' })).toHaveLength(2);
  });
});
