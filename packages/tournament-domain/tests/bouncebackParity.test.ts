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
  test('explicit scorer bouncebacks aggregate as known points with parts denominators', () => {
    const state = stateWithGames([
      game('g1', [
        // A converts 30 bounceback points off B's sheet (4 heard, 50 pts):
        // heard = (4*30-50)/10 = 7 parts, converted = 30/10 = 3 parts.
        teamScore('a', 320, { bonuses: 6, bonusPoints: 90, bouncebacks: 30 }),
        teamScore('b', 200, { bonuses: 4, bonusPoints: 50, bouncebacks: 10 }),
      ]),
    ]);
    const standing = standingOf(state, 'a');
    expect(standing.bouncebackPoints).toBe(30);
    expect(standing.bouncebacksKnown).toBe(true);

    const derivation = bouncebackDerivationForTeam('a', state.games, state);
    expect(derivation.bouncebackPoints).toBe(30);
    // Parts come from the opponent's scoresheet, never A's own lines.
    expect(derivation.bouncebackPartsHeard).toBe(7);
    expect(derivation.bouncebackPartsConverted).toBe(3);
    expect(derivation.bouncebackConversion).toBeCloseTo(3 / 7, 10);
    // Total bonus: (9 own + 3 BB) converted parts over (18 own + 7 BB) heard parts.
    expect(derivation.totalBonusConversion).toBeCloseTo(12 / 25, 10);
    // PPB stays on A's own bonuses only: bounceback points never inflate it.
    expect(derivation.ppbWithoutBouncebacks).toBeCloseTo(90 / 6, 10);

    const round = deriveRoundStats(state).find((entry) => entry.roundId === 'round-1');
    expect(round?.bouncebacks).toBe(40);
    expect(round?.bouncebackPartsHeard).toBe(16);
    expect(round?.bouncebackPartsConverted).toBe(4);
    expect(round?.bouncebackConversion).toBeCloseTo(4 / 16, 10);
    expect(round?.totalBonusConversion).toBeCloseTo(18 / 46, 10);
    expect(round?.bouncebackUnknownGames).toBe(0);
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

    const derivation = bouncebackDerivationForTeam('a', state.games, state);
    expect(derivation.bouncebackPoints).toBeNull();
    expect(derivation.bouncebackPartsHeard).toBeNull();
    expect(derivation.bouncebackPartsConverted).toBeNull();
    expect(derivation.bouncebackConversion).toBeNull();
    expect(derivation.totalBonusConversion).toBeNull();
    // PPB is unaffected by the unknown bounceback column.
    expect(derivation.ppbWithoutBouncebacks).toBeCloseTo(90 / 6, 10);

    const round = deriveRoundStats(state).find((entry) => entry.roundId === 'round-1');
    expect(round?.bouncebacks).toBeNull();
    expect(round?.bouncebackPartsHeard).toBeNull();
    expect(round?.bouncebackConversion).toBeNull();
    expect(round?.totalBonusConversion).toBeNull();
    expect(round?.bouncebackUnknownGames).toBe(1);
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

    const derivation = bouncebackDerivationForTeam('a', state.games, state);
    expect(derivation.bouncebackPoints).toBeNull();
    expect(derivation.bouncebackPartsHeard).toBeNull();
    expect(derivation.bouncebackConversion).toBeNull();
    expect(derivation.totalBonusConversion).toBeNull();
  });

  test('an omitted breakdown is the legacy zero shorthand, still known', () => {
    const score = teamScore('a', 300, { bonuses: 6, bonusPoints: 90 });
    expect(bouncebacksOf(score)).toBe(0);
    expect(bouncebacksKnownOf(score)).toBe(true);

    const state = stateWithGames([game('g1', [score, teamScore('b', 200, { bonuses: 4, bonusPoints: 50 })])]);
    expect(standingOf(state, 'a').bouncebacksKnown).toBe(true);
    const derivation = bouncebackDerivationForTeam('a', state.games, state);
    expect(derivation.bouncebackPoints).toBe(0);
    // B heard 4 bonuses worth 50: (4*30-50)/10 = 7 parts heard, 0 converted: a known zero.
    expect(derivation.bouncebackPartsHeard).toBe(7);
    expect(derivation.bouncebackPartsConverted).toBe(0);
    expect(derivation.bouncebackConversion).toBe(0);
    expect(derivation.totalBonusConversion).toBeCloseTo(9 / 25, 10);
  });

  test('a heard-zero scope reports zero parts with a null rate, never NaN', () => {
    const state = stateWithGames([
      game('g1', [
        teamScore('a', 100, { bonuses: 0, bonusPoints: 0, bouncebacks: 0 }),
        teamScore('b', 80, { bonuses: 0, bonusPoints: 0, bouncebacks: 0 }),
      ]),
    ]);
    const derivation = bouncebackDerivationForTeam('a', state.games, state);
    expect(derivation.bouncebackPoints).toBe(0);
    expect(derivation.bouncebackPartsHeard).toBe(0);
    expect(derivation.bouncebackPartsConverted).toBe(0);
    expect(derivation.bouncebackConversion).toBeNull();
    expect(derivation.totalBonusConversion).toBeNull();
    expect(derivation.ppbWithoutBouncebacks).toBeNull();

    const round = deriveRoundStats(state).find((entry) => entry.roundId === 'round-1');
    expect(round?.bouncebackPartsHeard).toBe(0);
    expect(round?.bouncebackConversion).toBeNull();
    expect(round?.bouncebackUnknownGames).toBe(0);
  });

  test('a pure-forfeit placeholder is skipped without unknowning the scope', () => {
    const state = stateWithGames([
      game('g1', [
        teamScore('a', 320, { bonuses: 6, bonusPoints: 90, bouncebacks: 30 }),
        teamScore('b', 200, { bonuses: 4, bonusPoints: 50, bouncebacks: 10 }),
      ]),
      game('g2', [teamScore('a', 0, { bouncebacks: null }), teamScore('c', 0, { bouncebacks: null })], {
        status: 'forfeit',
      }),
    ]);
    const standing = standingOf(state, 'a');
    expect(standing.bouncebacksKnown).toBe(true);
    expect(standing.bouncebackPoints).toBe(30);

    const derivation = bouncebackDerivationForTeam('a', state.games, state);
    expect(derivation.bouncebackPoints).toBe(30);
    expect(derivation.bouncebackPartsHeard).toBe(7);
    expect(derivation.bouncebackPartsConverted).toBe(3);

    const round = deriveRoundStats(state).find((entry) => entry.roundId === 'round-1');
    expect(round?.bouncebackPartsHeard).toBe(16);
    expect(round?.bouncebackUnknownGames).toBe(0);
  });

  test('irregular bonus rules make parts uncomputable while points stay known', () => {
    const state = stateWithGames([
      game('g1', [
        teamScore('a', 320, { bonuses: 6, bonusPoints: 90, bouncebacks: 30 }),
        teamScore('b', 200, { bonuses: 4, bonusPoints: 50, bouncebacks: 10 }),
      ]),
    ]);
    state.tournament!.rules = { ...state.tournament!.rules, minimumBonusParts: 2 };
    const derivation = bouncebackDerivationForTeam('a', state.games, state);
    expect(derivation.bouncebackPoints).toBe(30);
    expect(derivation.bouncebackPartsHeard).toBeNull();
    expect(derivation.bouncebackPartsConverted).toBeNull();
    expect(derivation.bouncebackConversion).toBeNull();
    expect(derivation.totalBonusConversion).toBeNull();
    expect(derivation.ppbWithoutBouncebacks).toBeCloseTo(90 / 6, 10);

    const round = deriveRoundStats(state).find((entry) => entry.roundId === 'round-1');
    expect(round?.bouncebacks).toBe(40);
    expect(round?.bouncebackPartsHeard).toBeNull();
    expect(round?.bouncebackUnknownGames).toBe(1);
  });

  test('per-game historical definitions override live rules for that game only', () => {
    const irregular = { ...defaultRules, minimumBonusParts: 2 };
    const state = stateWithGames([
      game('g1', [
        teamScore('a', 320, { bonuses: 6, bonusPoints: 90, bouncebacks: 30 }),
        teamScore('b', 200, { bonuses: 4, bonusPoints: 50, bouncebacks: 10 }),
      ]),
      game(
        'g2',
        [
          teamScore('a', 250, { bonuses: 5, bonusPoints: 70, bouncebacks: 20 }),
          teamScore('c', 210, { bonuses: 5, bonusPoints: 60, bouncebacks: 0 }),
        ],
        { definitionDigest: 'digest-irregular' },
      ),
    ]);
    state.gameDefinitions = [
      {
        id: 'def-1',
        scheduledGameId: 's-g2',
        revision: 1,
        createdAt: at,
        rules: irregular,
        roundId: 'round-1',
        packetId: 'packet-1',
        leftTeamId: 'a',
        rightTeamId: 'c',
        leftRoster: [],
        rightRoster: [],
        assignmentRevision: 1,
        digest: 'digest-irregular',
      },
    ];
    const derivation = bouncebackDerivationForTeam('a', state.games, state);
    // g2's pinned irregular definition unknowns the scope even though live rules are regular.
    expect(derivation.bouncebackPoints).toBe(50);
    expect(derivation.bouncebackPartsHeard).toBeNull();
    expect(derivation.bouncebackConversion).toBeNull();
  });

  test('no contributing games yields zeros with null rates, never NaN', () => {
    const state = stateWithGames([
      game('g1', [
        teamScore('a', 300, { bonuses: 6, bonusPoints: 90, bouncebacks: 10 }),
        teamScore('b', 200, { bonuses: 4, bonusPoints: 50, bouncebacks: 0 }),
      ]),
    ]);
    const derivation = bouncebackDerivationForTeam('zzz', state.games, state);
    expect(derivation).toEqual({
      bouncebackPoints: 0,
      bouncebackPartsHeard: 0,
      bouncebackPartsConverted: 0,
      bouncebackConversion: null,
      totalBonusConversion: null,
      ppbWithoutBouncebacks: null,
    });
  });

  test('bounceback validators accept unknown-or-count and reject impossible values', () => {
    expect(invalidTeamGameScoreBouncebacks(teamScore('a', 0, { bouncebacks: 10 }))).toBeNull();
    expect(invalidTeamGameScoreBouncebacks(teamScore('a', 0, { bouncebacks: null }))).toBeNull();
    expect(invalidTeamGameScoreBouncebacks(teamScore('a', 0))).toBeNull();
    expect(invalidTeamGameScoreBouncebacks(teamScore('a', 0, { bouncebacks: -5 }))).toBe('bouncebacks');
  });
});
