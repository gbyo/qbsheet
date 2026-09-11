import { describe, expect, test } from 'vitest';
import {
  defaultRules,
  deriveTeamStandings,
  emptyDirectorState,
  scopeScoringApplicability,
  type DirectorState,
  type GameRecord,
  type TeamGameScore,
  type TournamentRules,
} from '../src/index.js';

const at = '2026-09-10T12:00:00.000Z';

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
    ...detail,
  };
}

function game(
  id: string,
  scores: [TeamGameScore, TeamGameScore],
  detail: Partial<GameRecord> = {},
): GameRecord {
  return {
    id,
    scheduledGameId: `s-${id}`,
    roundId: 'round-1',
    packetId: 'packet-1',
    status: 'accepted',
    scores,
    playerStats: [],
    source: 'manual',
    detailedStats: 'complete',
    ...detail,
  };
}

function stateWithCurrentRules(games: GameRecord[], current: TournamentRules): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 't',
    name: 'Scope applicability',
    date: '2026-09-10',
    venue: '',
    organizer: '',
    status: 'running',
    timeZone: 'America/New_York',
    rules: structuredClone(current),
    formatId: null,
    currentPhaseId: 'phase-1',
    currentPacketId: null,
    currentRoundId: null,
    createdAt: at,
    updatedAt: at,
  };
  const teamIds = [...new Set(games.flatMap((entry) => entry.scores.map((score) => score.teamId)))];
  state.teams = teamIds.map((id) => ({
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
      id: 'round-1',
      phaseId: 'phase-1',
      name: 'Round 1',
      number: 1,
      revision: 1,
      status: 'closed',
      packetId: 'packet-1',
      scheduledGameIds: games.map((entry) => entry.scheduledGameId),
      dayOrder: 0,
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
    },
  ];
  state.scheduledGames = games.map((entry) => ({
    id: entry.scheduledGameId,
    roundId: 'round-1',
    roomId: null,
    packetId: 'packet-1',
    leftTeamId: entry.scores[0]!.teamId,
    rightTeamId: entry.scores[1]!.teamId,
    bye: false,
    status: 'accepted' as const,
    assignmentRevision: 1,
  }));
  state.games = games;
  return state;
}

function withDefinition(
  state: DirectorState,
  scheduledGameId: string,
  digest: string,
  rules: TournamentRules,
): void {
  state.gameDefinitions.push({
    id: `def-${digest}`,
    scheduledGameId,
    revision: 1,
    createdAt: at,
    rules: structuredClone(rules),
    roundId: 'round-1',
    packetId: 'packet-1',
    leftTeamId: 'a',
    rightTeamId: 'b',
    leftRoster: [],
    rightRoster: [],
    assignmentRevision: 1,
    digest,
  });
}

const historical: TournamentRules = {
  ...structuredClone(defaultRules),
  powerValue: 15,
  bouncebacks: true,
  lightning: true,
};

const current: TournamentRules = {
  ...structuredClone(defaultRules),
  powerValue: 20,
  bouncebacks: false,
  lightning: false,
};

describe('scope scoring applicability (#868)', () => {
  test('historical definitions survive a current-rules change', () => {
    const state = stateWithCurrentRules(
      [
        game(
          'g1',
          [teamScore('a', 300, { lightningPoints: 30 }), teamScore('b', 200, { lightningPoints: 10 })],
          { definitionDigest: 'd1' },
        ),
      ],
      current,
    );
    withDefinition(state, 's-g1', 'd1', historical);

    const scope = scopeScoringApplicability(state, state.games);
    expect(scope.lightning).toBe(true);
    expect(scope.bouncebacks).toBe(true);
    expect(scope.tiers.find((tier) => tier.id === 'powers')?.values).toEqual([15]);
    expect(scope.mixed).toBe(false);
  });

  test('mixed historical definitions union tiers and flag mixed', () => {
    const state = stateWithCurrentRules(
      [
        game('g1', [teamScore('a', 300), teamScore('b', 200)], { definitionDigest: 'd1' }),
        game('g2', [teamScore('a', 250), teamScore('b', 150)], { definitionDigest: 'd2' }),
      ],
      current,
    );
    withDefinition(state, 's-g1', 'd1', historical);
    withDefinition(state, 's-g2', 'd2', current);

    const scope = scopeScoringApplicability(state, state.games);
    expect(scope.tiers.find((tier) => tier.id === 'powers')?.values).toEqual([15, 20]);
    expect(scope.mixed).toBe(true);
    // Either side still played lightning/bouncebacks, so the columns stay.
    expect(scope.lightning).toBe(true);
    expect(scope.bouncebacks).toBe(true);
  });

  test('empty scope falls back to current rules', () => {
    const state = stateWithCurrentRules([], current);
    const scope = scopeScoringApplicability(state, []);
    expect(scope.lightning).toBe(false);
    expect(scope.tiers.find((tier) => tier.id === 'powers')?.values).toEqual([20]);
  });
});

describe('lightning denominator (#755)', () => {
  test('counts lightning-applicable games, never pure-forfeit placeholders', () => {
    const state = stateWithCurrentRules(
      [
        game(
          'g1',
          [teamScore('a', 300, { lightningPoints: 30 }), teamScore('b', 200, { lightningPoints: 10 })],
          { definitionDigest: 'd1' },
        ),
        game('g2', [teamScore('a', 0, { bouncebacks: null }), teamScore('b', 200, { bouncebacks: null })], {
          status: 'forfeit',
          forfeitedTeamId: 'a',
          definitionDigest: 'd1',
        }),
      ],
      historical,
    );
    withDefinition(state, 's-g1', 'd1', historical);
    withDefinition(state, 's-g2', 'd1', historical);

    const standings = deriveTeamStandings(state);
    // Both teams played twice, but only the real game counts for Lightning/G.
    expect(standings.find((entry) => entry.teamId === 'a')?.gamesPlayed).toBe(2);
    expect(standings.find((entry) => entry.teamId === 'a')?.lightningGames).toBe(1);
    expect(standings.find((entry) => entry.teamId === 'b')?.lightningGames).toBe(1);
  });

  test('games under rules without lightning do not enter the denominator', () => {
    const state = stateWithCurrentRules(
      [
        game('g1', [
          teamScore('a', 300, { lightningPoints: 0 }),
          teamScore('b', 200, { lightningPoints: 0 }),
        ]),
      ],
      current,
    );

    const standings = deriveTeamStandings(state);
    expect(standings.find((entry) => entry.teamId === 'a')?.lightningGames).toBe(0);
  });
});
