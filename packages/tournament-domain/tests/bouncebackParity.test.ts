import { describe, expect, test } from 'vitest';
import {
  bouncebackDerivationForTeam,
  bouncebacksKnownOf,
  bouncebacksOf,
  deriveRoundStats,
  deriveTeamStandings,
  emptyDirectorState,
  invalidTeamGameScoreBouncebacks,
  defaultRules,
  type DirectorState,
  type GameRecord,
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

function stateWithGames(games: GameRecord[]): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 't',
    name: 'Bounceback parity',
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

function standingOf(state: DirectorState, teamId: string) {
  const standing = deriveTeamStandings(state).find((entry) => entry.teamId === teamId);
  if (!standing) throw new Error(`missing standing for ${teamId}`);
  return standing;
}

describe('bounceback parity (#748)', () => {
  test('explicit scorer bouncebacks aggregate as known points with opponent-scoped denominators', () => {
    const state = stateWithGames([
      game('g1', [
        // A converts 30 bounceback points off B's 6 heard bonuses; A's own PPB base is 90/6.
        teamScore('a', 320, { bonuses: 6, bonusPoints: 90, bouncebacks: 30 }),
        teamScore('b', 200, { bonuses: 4, bonusPoints: 50, bouncebacks: 10 }),
      ]),
    ]);
    const standing = standingOf(state, 'a');
    expect(standing.bouncebackPoints).toBe(30);
    expect(standing.bouncebacksKnown).toBe(true);

    const derivation = bouncebackDerivationForTeam('a', state.games);
    expect(derivation.bouncebackPoints).toBe(30);
    // Opportunities come from the opponent's scoresheet, never A's own lines.
    expect(derivation.bouncebackOpportunities).toBe(4);
    expect(derivation.bouncebackConversion).toBeCloseTo(30 / 4, 10);
    // PPB stays on A's own bonuses only: bounceback points never inflate it.
    expect(derivation.ppbWithoutBouncebacks).toBeCloseTo(90 / 6, 10);
  });

  test('a manual result without a bounceback breakdown unknowns the aggregates, not zeros them', () => {
    const state = stateWithGames([
      game('g1', [
        teamScore('a', 320, { bonuses: 6, bonusPoints: 90, bouncebacks: null }),
        teamScore('b', 200, { bonuses: 4, bonusPoints: 50, bouncebacks: null }),
      ]),
    ]);
    const standing = standingOf(state, 'a');
    expect(standing.bouncebacksKnown).toBe(false);

    const derivation = bouncebackDerivationForTeam('a', state.games);
    expect(derivation.bouncebackPoints).toBeNull();
    expect(derivation.bouncebackOpportunities).toBeNull();
    expect(derivation.bouncebackConversion).toBeNull();
    // PPB is unaffected by the unknown bounceback column.
    expect(derivation.ppbWithoutBouncebacks).toBeCloseTo(90 / 6, 10);

    const round = deriveRoundStats(state).find((entry) => entry.roundId === 'round-1');
    expect(round?.bouncebacks).toBeNull();
  });

  test('one unknown game unknowns the whole derivation even when other games are explicit', () => {
    const state = stateWithGames([
      game('g1', [
        teamScore('a', 320, { bonuses: 6, bonusPoints: 90, bouncebacks: 30 }),
        teamScore('b', 200, { bonuses: 4, bonusPoints: 50, bouncebacks: 0 }),
      ]),
      game('g2', [
        teamScore('a', 250, { bonuses: 5, bonusPoints: 70, bouncebacks: null }),
        teamScore('c', 210, { bonuses: 5, bonusPoints: 60, bouncebacks: null }),
      ]),
    ]);
    const standing = standingOf(state, 'a');
    expect(standing.bouncebacksKnown).toBe(false);

    const derivation = bouncebackDerivationForTeam('a', state.games);
    expect(derivation.bouncebackPoints).toBeNull();
    expect(derivation.bouncebackConversion).toBeNull();
  });

  test('an omitted breakdown is the legacy zero shorthand, still known', () => {
    const score = teamScore('a', 300, { bonuses: 6, bonusPoints: 90 });
    expect(bouncebacksOf(score)).toBe(0);
    expect(bouncebacksKnownOf(score)).toBe(true);

    const state = stateWithGames([
      game('g1', [
        score,
        teamScore('b', 200, { bonuses: 4, bonusPoints: 50 }),
      ]),
    ]);
    expect(standingOf(state, 'a').bouncebacksKnown).toBe(true);
    const derivation = bouncebackDerivationForTeam('a', state.games);
    expect(derivation.bouncebackPoints).toBe(0);
    expect(derivation.bouncebackOpportunities).toBe(4);
    expect(derivation.bouncebackConversion).toBe(0);
  });

  test('no contributing games yields zeros with null rates, never NaN', () => {
    const state = stateWithGames([
      game('g1', [
        teamScore('a', 300, { bonuses: 6, bonusPoints: 90, bouncebacks: 10 }),
        teamScore('b', 200, { bonuses: 4, bonusPoints: 50, bouncebacks: 0 }),
      ]),
    ]);
    const derivation = bouncebackDerivationForTeam('zzz', state.games);
    expect(derivation).toEqual({
      bouncebackPoints: 0,
      bouncebackOpportunities: 0,
      bouncebackConversion: null,
      ppbWithoutBouncebacks: null,
    });
  });

  test('bounceback validators accept unknown-or-count and reject impossible values', () => {
    expect(invalidTeamGameScoreBouncebacks(teamScore('a', 0, { bouncebacks: 10 }))).toBeNull();
    expect(invalidTeamGameScoreBouncebacks(teamScore('a', 0, { bouncebacks: null }))).toBeNull();
    expect(invalidTeamGameScoreBouncebacks(teamScore('a', 0))).toBeNull();
    expect(invalidTeamGameScoreBouncebacks(teamScore('a', 0, { bouncebacks: -5 }))).toBe(
      'bouncebacks',
    );
  });
});
