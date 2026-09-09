import { describe, expect, test } from 'vitest';
import { defaultRules, emptyDirectorState, type DirectorState, type TeamGameScore } from '../domain';
import { buildCanonicalSnapshot } from './canonicalReports';

const at = '2026-09-09T12:00:00.000Z';

function score(teamId: string, points: number, detail: Partial<TeamGameScore> = {}): TeamGameScore {
  return {
    teamId,
    score: points,
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

function resultQbj(matchId: string, regulation = 20, tossupsRead = 20): Record<string, unknown> {
  const rulesId = `rules-${matchId}`;
  return {
    version: '2.1.1',
    objects: [
      {
        type: 'ScoringRules',
        id: rulesId,
        regulation_tossup_count: regulation,
        maximum_regulation_tossup_count: regulation,
        maximum_bonus_score: 30,
        bonus_divisor: 10,
        minimum_parts_per_bonus: 3,
        maximum_parts_per_bonus: 3,
        points_per_bonus_part: 10,
        bonuses_bounce_back: false,
        answer_types: [
          { type: 'AnswerType', id: 'power', value: 15, label: 'Power', short_label: 'P' },
          { type: 'AnswerType', id: 'correct', value: 10, label: 'Correct', short_label: 'C' },
          { type: 'AnswerType', id: 'neg', value: -5, label: 'Neg', short_label: 'N' },
        ],
      },
      { type: 'Tournament', id: 'tournament', scoring_rules: { $ref: rulesId } },
      { type: 'Match', id: matchId, tossups_read: tossupsRead, overtime_tossups_read: 0 },
    ],
  };
}

function reportState(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament',
    name: 'Round Report Test',
    date: '2026-09-09',
    venue: '',
    organizer: '',
    status: 'running',
    timeZone: 'America/New_York',
    rules: { ...structuredClone(defaultRules), tossupCount: 99 },
    formatId: null,
    currentPhaseId: 'phase-1',
    currentPacketId: 'packet-1',
    currentRoundId: 'round-1',
    createdAt: at,
    updatedAt: at,
  };
  state.phases = [
    {
      id: 'phase-1',
      name: 'Preliminary',
      kind: 'preliminary',
      order: 0,
      formatId: 'format-1',
      poolIds: [],
      roundIds: ['round-1', 'round-2'],
      advancementRule: null,
      carryover: false,
      status: 'active',
    },
  ];
  state.teams = [
    {
      id: 'team-a',
      organizationId: null,
      displayName: 'Aiken',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'team-b',
      organizationId: null,
      displayName: 'Dorman',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      createdAt: at,
      updatedAt: at,
    },
  ];
  state.packets = [
    {
      id: 'packet-1',
      name: 'Packet One',
      source: 'manual',
      assignedRoundIds: ['round-1'],
      assignedGameIds: ['scheduled-1'],
      usedGameIds: ['scheduled-1'],
      replacementForPacketId: null,
      tiebreaker: false,
    },
    {
      id: 'packet-2',
      name: 'Packet Two',
      source: 'manual',
      assignedRoundIds: ['round-2'],
      assignedGameIds: ['scheduled-2'],
      usedGameIds: ['scheduled-2'],
      replacementForPacketId: null,
      tiebreaker: false,
    },
  ];
  state.rounds = [
    {
      id: 'round-1',
      phaseId: 'phase-1',
      name: 'Round 1',
      number: 1,
      revision: 1,
      status: 'closed',
      packetId: 'packet-1',
      scheduledGameIds: ['scheduled-1'],
      dayOrder: 0,
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
    },
    {
      id: 'round-2',
      phaseId: 'phase-1',
      name: 'Round 2',
      number: 2,
      revision: 1,
      status: 'closed',
      packetId: 'packet-2',
      scheduledGameIds: ['scheduled-2'],
      dayOrder: 1,
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
    },
  ];
  state.scheduledGames = [
    {
      id: 'scheduled-1',
      roundId: 'round-1',
      poolId: 'pool-a',
      roomId: null,
      packetId: 'packet-1',
      leftTeamId: 'team-a',
      rightTeamId: 'team-b',
      bye: false,
      status: 'accepted',
      assignmentRevision: 1,
    },
    {
      id: 'scheduled-2',
      roundId: 'round-2',
      poolId: 'pool-b',
      roomId: null,
      packetId: 'packet-2',
      leftTeamId: 'team-b',
      rightTeamId: 'team-a',
      bye: false,
      status: 'accepted',
      assignmentRevision: 1,
    },
  ];
  state.games = [
    {
      id: 'game-1',
      scheduledGameId: 'scheduled-1',
      roundId: 'round-1',
      packetId: 'packet-1',
      status: 'accepted',
      scores: [
        score('team-a', 300, { powers: 2, gets: 4, negs: 1, bonuses: 6, bonusPoints: 90 }),
        score('team-b', 200, { powers: 1, gets: 3, negs: 2, bonuses: 4, bonusPoints: 50 }),
      ],
      playerStats: [],
      source: 'qbj',
      detailedStats: 'complete',
      rawQbj: resultQbj('scheduled-1', 20, 20),
    },
    {
      id: 'game-2',
      scheduledGameId: 'scheduled-2',
      roundId: 'round-2',
      packetId: 'packet-2',
      status: 'accepted',
      scores: [
        score('team-b', 280, { powers: 1, gets: 4, negs: 1, bonuses: 5, bonusPoints: 70 }),
        score('team-a', 250, { powers: 1, gets: 3, negs: 1, bonuses: 4, bonusPoints: 60 }),
      ],
      playerStats: [],
      source: 'manual',
      detailedStats: 'complete',
    },
  ];
  return state;
}

describe('canonical round report adapter', () => {
  test('uses each game raw QBJ definition instead of current tournament defaults', () => {
    const snapshot = buildCanonicalSnapshot(reportState(), { label: 'Overall' }, at);
    const round = snapshot.rounds?.[0];

    expect(snapshot.games[0]?.tossupsRead).toBe(20);
    expect(round?.regulationTossupCount).toBe(20);
    expect(round?.pointsPerTeamPerXTuh).toBeCloseTo(250);
    expect(round?.tossupConversionRate).toBeCloseTo(0.5);
    expect(round?.powerRate).toBeCloseTo(0.3);
    expect(round?.negRatePerXTuh).toBeCloseTo(3);
    expect(round?.ppb).toBeCloseTo(14);
    expect(round?.packetName).toBe('Packet One');
    expect(round?.regulationTossupCount).not.toBe(99);
  });

  test('leaves definition-dependent totals unavailable instead of falling back for legacy games', () => {
    const state = reportState();
    state.scheduledGames[1]!.roundId = 'round-1';
    state.scheduledGames[1]!.poolId = 'pool-a';
    state.games[1]!.roundId = 'round-1';
    state.rounds[0]!.scheduledGameIds.push('scheduled-2');
    state.rounds[1]!.scheduledGameIds = [];

    const snapshot = buildCanonicalSnapshot(state, { label: 'Overall' }, at);
    const round = snapshot.rounds?.[0];

    expect(snapshot.rounds).toHaveLength(1);
    expect(round?.games).toBe(2);
    expect(round?.regulationTossupCount).toBeNull();
    expect(round?.pointsPerTeamPerXTuh).toBeNull();
    expect(round?.notes).toContain('1/2 played games have a historical regulation length.');
  });

  test('phase and pool scope filter games before round aggregation', () => {
    const snapshot = buildCanonicalSnapshot(
      reportState(),
      { phaseId: 'phase-1', poolId: 'pool-a', label: 'Preliminary · Pool A' },
      at,
    );

    expect(snapshot.games.map((game) => game.gameId)).toEqual(['game-1']);
    expect(snapshot.rounds?.map((round) => round.roundId)).toEqual(['round-1']);
    expect(snapshot.roundTotal?.games).toBe(1);
    expect(snapshot.extensions?.scopeLabel).toBe('Preliminary · Pool A');
  });
});
