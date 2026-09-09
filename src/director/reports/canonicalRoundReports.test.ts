import { describe, expect, test } from 'vitest';
import {
  acceptedGame,
  playedTournament,
  player,
  playerStat,
  scheduledGame,
  score,
  team,
} from '../../../tests/directorFixtures';
import type { DirectorState } from '../domain';
import { buildCanonicalRoundStatsSnapshot } from './canonicalRoundReports';

const generatedAt = '2026-09-09T20:00:00.000Z';

function historicalQbj(regulationTossups: number, tossupsRead: number, packet = 'Packet 18'): unknown {
  return {
    version: '2.1.1',
    objects: [
      {
        type: 'ScoringRules',
        id: `rules-${regulationTossups}`,
        regulation_tossup_count: regulationTossups,
        maximum_regulation_tossup_count: regulationTossups,
        minimum_overtime_question_count: 1,
        maximum_bonus_score: 30,
        minimum_parts_per_bonus: 3,
        maximum_parts_per_bonus: 3,
        points_per_bonus_part: 10,
        bonuses_bounce_back: false,
        answer_types: [
          { type: 'AnswerType', id: 'power', value: 15, label: 'Power', short_label: 'P' },
          { type: 'AnswerType', id: 'get', value: 10, label: 'Correct', short_label: 'C' },
          { type: 'AnswerType', id: 'neg', value: -5, label: 'Neg', short_label: 'N' },
        ],
      },
      {
        type: 'Packet',
        id: 'packet-qbj',
        name: packet,
      },
      {
        type: 'Match',
        id: 'match',
        tossups_read: tossupsRead,
        overtime_tossups_read: 0,
      },
    ],
  };
}

function multiScopeState(): DirectorState {
  const state = playedTournament();
  state.tournament!.status = 'running';
  state.tournament!.rules.tossupCount = 24;
  state.tournament!.rules.maximumTossupCount = 24;

  state.packets.push({
    id: 'packet-18',
    name: 'Packet 18',
    source: 'manual',
    assignedRoundIds: ['round-1'],
    assignedGameIds: ['scheduled-1'],
    usedGameIds: ['game-1'],
    replacementForPacketId: null,
    tiebreaker: false,
  });
  state.rounds[0]!.packetId = 'packet-18';
  state.scheduledGames[0]!.packetId = 'packet-18';
  state.games[0]!.packetId = 'packet-18';
  state.games[0]!.rawQbj = historicalQbj(18, 18);

  state.pools.push({
    id: 'pool-a',
    phaseId: 'phase-1',
    name: 'Pool A',
    teamIds: ['team-a', 'team-b'],
    order: 1,
  });
  state.phases[0]!.poolIds = ['pool-a'];
  state.scheduledGames[0]!.poolId = 'pool-a';

  state.phases.push({
    id: 'phase-2',
    name: 'Playoff',
    kind: 'playoff',
    order: 2,
    formatId: 'format-1',
    poolIds: [],
    roundIds: ['round-2'],
    advancementRule: null,
    carryover: true,
    status: 'active',
  });
  state.rounds.push({
    id: 'round-2',
    phaseId: 'phase-2',
    name: 'Round 2',
    number: 2,
    revision: 1,
    status: 'closed',
    packetId: null,
    scheduledGameIds: ['scheduled-2'],
    scheduledStart: null,
    releasedAt: generatedAt,
    startedAt: generatedAt,
    closedAt: generatedAt,
  });
  state.teams.push(team('team-c', 'C'), team('team-d', 'D'));
  state.players.push(player('player-c', 'team-c', 'C Player'), player('player-d', 'team-d', 'D Player'));
  state.scheduledGames.push(
    scheduledGame('scheduled-2', 'team-c', 'team-d', { roundId: 'round-2', poolId: null }),
  );
  const second = acceptedGame(
    'game-2',
    'scheduled-2',
    [
      score('team-c', 260, { powers: 2, gets: 7, negs: 1, bonuses: 9, bonusPoints: 140 }),
      score('team-d', 180, { powers: 1, gets: 7, negs: 2, bonuses: 8, bonusPoints: 100 }),
    ],
    [
      playerStat('player-c', 'team-c', { tossupsHeard: 20, powers: 2, gets: 7, negs: 1 }),
      playerStat('player-d', 'team-d', { tossupsHeard: 20, powers: 1, gets: 7, negs: 2 }),
    ],
  );
  second.roundId = 'round-2';
  second.rawQbj = historicalQbj(20, 20, 'Packet 20');
  state.games.push(second);
  return state;
}

describe('buildCanonicalRoundStatsSnapshot', () => {
  test('uses exact historical QBJ definition and tossups-read before current tournament defaults', () => {
    const state = multiScopeState();
    // Current defaults are intentionally 24; the accepted Round 1 QBJ says 18.
    expect(state.tournament!.rules.tossupCount).toBe(24);

    const snapshot = buildCanonicalRoundStatsSnapshot(
      state,
      { phaseId: 'phase-1', label: 'Preliminary' },
      generatedAt,
    );
    expect(snapshot.games).toHaveLength(1);
    const game = snapshot.games[0]!;
    expect(game.roundStatDefinition).toMatchObject({
      source: 'qbj',
      regulationTossups: 18,
      powers: true,
      bonuses: true,
      maximumBonusScore: 30,
    });
    expect(game.tossupsRead).toBe(18);
    expect(game.phaseName).toBe('Preliminary');
    expect(game.packetName).toBe('Packet 18');

    const row = snapshot.roundStats!.rows[0]!;
    expect(row.regulationTossups).toBe(18);
    expect(row.pointsPerTeamPerXTuh).toBeCloseTo((300 + 210) / 2);
    expect(row.phaseName).toBe('Preliminary');
    expect(row.packetName).toBe('Packet 18');
  });

  test('phase and pool scopes are applied before round aggregation', () => {
    const state = multiScopeState();
    const overall = buildCanonicalRoundStatsSnapshot(state, { label: 'Overall' }, generatedAt);
    expect(overall.roundStats!.rows.map((row) => row.roundId)).toEqual(['round-1', 'round-2']);
    expect(overall.roundStats!.showPhase).toBe(true);
    // 18 and 20 are both honest per-round X values; Overall declines a single X.
    expect(overall.roundStats!.total.regulationTossups).toBeNull();
    expect(overall.roundStats!.total.pointsPerTeamPerXTuh).toBeNull();

    const phase = buildCanonicalRoundStatsSnapshot(
      state,
      { phaseId: 'phase-2', label: 'Playoff' },
      generatedAt,
    );
    expect(phase.games.map((game) => game.gameId)).toEqual(['game-2']);
    expect(phase.roundStats!.rows.map((row) => row.roundId)).toEqual(['round-2']);

    const pool = buildCanonicalRoundStatsSnapshot(state, { poolId: 'pool-a', label: 'Pool A' }, generatedAt);
    expect(pool.games.map((game) => game.gameId)).toEqual(['game-1']);
    expect(pool.roundStats!.total.games).toBe(1);
  });

  test('does not reinterpret a legacy accepted game using current tournament rules', () => {
    const state = playedTournament();
    state.tournament!.rules.tossupCount = 42;
    state.tournament!.rules.maximumTossupCount = 42;
    state.tournament!.rules.overtime = false;

    const snapshot = buildCanonicalRoundStatsSnapshot(state, { label: 'Overall' }, generatedAt);
    expect(snapshot.games[0]!.roundStatDefinition).toEqual({
      regulationTossups: null,
      regulationLengthFixed: null,
      overtimeEnabled: null,
      powers: null,
      superpowers: null,
      bonuses: null,
      maximumBonusScore: null,
      source: 'unknown',
    });
    expect(snapshot.roundStats!.rows[0]!.regulationTossups).toBeNull();
    expect(snapshot.roundStats!.rows[0]!.pointsPerTeamPerXTuh).toBeNull();
  });
});
