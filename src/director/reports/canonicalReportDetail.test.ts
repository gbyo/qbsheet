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

function detailState(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament',
    name: 'Report Detail Test',
    date: '2026-09-09',
    venue: '',
    organizer: '',
    status: 'running',
    timeZone: 'America/New_York',
    rules: structuredClone(defaultRules),
    formatId: null,
    currentPhaseId: 'phase-1',
    currentPacketId: 'packet-1',
    currentRoundId: 'round-1',
    createdAt: at,
    updatedAt: at,
  };
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
  state.players = [
    { id: 'a1', teamId: 'team-a', name: 'A One', captain: true, active: true },
    { id: 'a2', teamId: 'team-a', name: 'A Two', captain: false, active: true },
    { id: 'b1', teamId: 'team-b', name: 'B One', captain: true, active: true },
  ];
  state.packets = [
    {
      id: 'packet-1',
      name: 'Packet 1',
      source: 'manual',
      assignedRoundIds: ['round-1'],
      assignedGameIds: ['scheduled-1'],
      usedGameIds: ['scheduled-1'],
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
      packetId: null,
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
      poolId: 'pool-a',
      roomId: null,
      packetId: null,
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
      playerStats: [
        {
          playerId: 'a1',
          teamId: 'team-a',
          superpowers: 0,
          powers: 2,
          gets: 3,
          negs: 1,
          bonusPoints: 20,
          tossupsHeard: 20,
        },
        {
          playerId: 'b1',
          teamId: 'team-b',
          superpowers: 0,
          powers: 1,
          gets: 3,
          negs: 2,
          bonusPoints: 10,
          tossupsHeard: 20,
        },
      ],
      source: 'manual',
      detailedStats: 'complete',
      // Canonical per-game team TUH is the exact match count, not summed lines (#746).
      tossupsRead: 20,
      overtimeTossupsRead: 0,
    },
    {
      id: 'game-2',
      scheduledGameId: 'scheduled-2',
      roundId: 'round-2',
      packetId: null,
      status: 'accepted',
      scores: [score('team-b', 250), score('team-a', 240)],
      playerStats: [],
      source: 'paper',
      detailedStats: 'unknown',
    },
  ];
  return state;
}

describe('canonical per-game report detail', () => {
  test('carries team and actual player lines without inventing roster participation', () => {
    const snapshot = buildCanonicalSnapshot(detailState(), { label: 'Overall' }, at);
    const game = snapshot.games[0]!;

    expect(game).toMatchObject({
      gameId: 'game-1',
      phaseId: 'phase-1',
      poolId: 'pool-a',
      packetId: 'packet-1',
      packetName: 'Packet 1',
      tossupsRead: 20,
      overtimeTossupsRead: 0,
    });
    // Parts come from the game's own regular definition (#748, #751): team-a heard 6
    // bonuses worth 90 (18 parts of 10), leaving the opponent's 4-for-50 (120) with
    // 7 unconverted parts heard and 0 converted; lightning stays unknown because a
    // manual result without the breakdown is unknown, never zero.
    expect(game.teamStats).toEqual([
      {
        teamId: 'team-a',
        teamName: 'Aiken',
        points: 300,
        // Recorded zero overtime tossups: the absent breakdown is a known zero.
        overtimePoints: 0,
        superpowers: 0,
        powers: 2,
        gets: 4,
        negs: 1,
        tossupsHeard: 20,
        bonusesHeard: 6,
        bonusPoints: 90,
        ppb: 15,
        bouncebacks: 0,
        lightningPoints: null,
        bouncebackPartsHeard: 7,
        bouncebackPartsConverted: 0,
        bonusPartsConverted: 9,
        bonusPartsHeard: 18,
      },
      {
        teamId: 'team-b',
        teamName: 'Dorman',
        points: 200,
        overtimePoints: 0,
        superpowers: 0,
        powers: 1,
        gets: 3,
        negs: 2,
        tossupsHeard: 20,
        bonusesHeard: 4,
        bonusPoints: 50,
        ppb: 12.5,
        bouncebacks: 0,
        lightningPoints: null,
        bouncebackPartsHeard: 9,
        bouncebackPartsConverted: 0,
        bonusPartsConverted: 5,
        bonusPartsHeard: 12,
      },
    ]);
    expect(game.playerStats?.map((row) => row.playerId)).toEqual(['a1', 'b1']);
    expect(game.playerStats?.some((row) => row.playerId === 'a2')).toBe(false);
    expect(game.playerStats?.[0]).toMatchObject({
      playerId: 'a1',
      playerName: 'A One',
      tossupsHeard: 20,
      powers: 2,
      gets: 3,
      negs: 1,
      points: 75,
    });
  });

  test('score-only results keep detail unknown instead of fabricating zero statistics', () => {
    const snapshot = buildCanonicalSnapshot(detailState(), { label: 'Overall' }, at);
    const game = snapshot.games[1]!;

    expect(game.detail).toBe('partial');
    expect(game.playerStats).toEqual([]);
    expect(game.teamStats).toHaveLength(2);
    expect(game.teamStats?.[0]).toMatchObject({
      teamId: 'team-b',
      points: 250,
      powers: null,
      gets: null,
      negs: null,
      tossupsHeard: null,
      bonusesHeard: null,
      bonusPoints: null,
      ppb: null,
    });
  });

  test('phase and pool scopes carry only detail for the same accepted game set', () => {
    const snapshot = buildCanonicalSnapshot(
      detailState(),
      { phaseId: 'phase-1', poolId: 'pool-a', label: 'Prelims · Pool A' },
      at,
    );

    expect(snapshot.games.map((game) => game.gameId)).toEqual(['game-1', 'game-2']);
    expect(snapshot.games.every((game) => game.poolId === 'pool-a')).toBe(true);
    expect(snapshot.extensions?.scopeLabel).toBe('Prelims · Pool A');
  });
});
