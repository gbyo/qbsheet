/**
 * Explicit final placement and superpower aggregation.
 *
 * A final placement reorders calculated rows without rewriting them: raw
 * scores, W/L records, and the calculated order stay recoverable by ignoring
 * the override. Superpowers aggregate alongside powers in both team and
 * player standings.
 */

import { describe, expect, test } from 'vitest';
import {
  applyFinalPlacement,
  defaultRules,
  derivePlayerStandings,
  deriveTeamStandings,
  emptyDirectorState,
  playerPoints,
  type DirectorState,
  type FinalPlacement,
  type GameRecord,
} from '../src/index.js';

function standing(teamId: string) {
  return { teamId };
}

const placement = (order: string[]): FinalPlacement => ({
  order,
  actor: 'Director',
  at: '2026-09-05T18:00:00.000Z',
});

describe('applyFinalPlacement', () => {
  test('reorders calculated rows without rewriting them', () => {
    const calculated = [standing('a'), standing('b'), standing('c')];
    const result = applyFinalPlacement(calculated, placement(['c', 'a']));
    expect(result.map((row) => row.teamId)).toEqual(['c', 'a', 'b']);
    expect(calculated.map((row) => row.teamId)).toEqual(['a', 'b', 'c']);
  });

  test('duplicates collapse to the first occurrence and unknown ids are ignored', () => {
    const calculated = [standing('a'), standing('b')];
    const result = applyFinalPlacement(calculated, placement(['b', 'b', 'ghost', 'a']));
    expect(result.map((row) => row.teamId)).toEqual(['b', 'a']);
  });

  test('missing or empty placement returns the calculated order', () => {
    const calculated = [standing('a'), standing('b')];
    expect(applyFinalPlacement(calculated, undefined).map((row) => row.teamId)).toEqual(['a', 'b']);
    expect(applyFinalPlacement(calculated, placement([])).map((row) => row.teamId)).toEqual(['a', 'b']);
  });
});

function game(
  id: string,
  left: { team: string; score: number; superpowers: number },
  right: { team: string; score: number; superpowers: number },
): GameRecord {
  return {
    id,
    scheduledGameId: `scheduled-${id}`,
    roundId: 'round-1',
    packetId: null,
    status: 'accepted',
    scores: [
      {
        teamId: left.team,
        score: left.score,
        superpowers: left.superpowers,
        powers: 1,
        gets: 2,
        negs: 0,
        bonuses: 3,
        bonusPoints: 30,
        bouncebacks: 0,
      },
      {
        teamId: right.team,
        score: right.score,
        superpowers: right.superpowers,
        powers: 0,
        gets: 1,
        negs: 1,
        bonuses: 1,
        bonusPoints: 10,
        bouncebacks: 0,
      },
    ],
    playerStats: [
      {
        playerId: `player-${left.team}`,
        teamId: left.team,
        superpowers: left.superpowers,
        powers: 1,
        gets: 2,
        negs: 0,
        bonusPoints: 0,
        tossupsHeard: 20,
      },
    ],
    source: 'manual',
  };
}

function statsState(): DirectorState {
  const state = emptyDirectorState();
  state.teams = [
    {
      id: 'a',
      organizationId: null,
      displayName: 'Aiken',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      createdAt: '2026-09-05T12:00:00.000Z',
      updatedAt: '2026-09-05T12:00:00.000Z',
    },
    {
      id: 'b',
      organizationId: null,
      displayName: 'Wren',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      createdAt: '2026-09-05T12:00:00.000Z',
      updatedAt: '2026-09-05T12:00:00.000Z',
    },
  ];
  state.players = [
    {
      id: 'player-a',
      teamId: 'a',
      name: 'A. Player',
      captain: true,
      active: true,
      createdAt: '2026-09-05T12:00:00.000Z',
      updatedAt: '2026-09-05T12:00:00.000Z',
    },
  ];
  state.games = [
    game('game-1', { team: 'a', score: 300, superpowers: 2 }, { team: 'b', score: 100, superpowers: 0 }),
  ];
  return state;
}

describe('superpower aggregation', () => {
  test('team standings aggregate superpowers without disturbing W/L', () => {
    const [first, second] = deriveTeamStandings(statsState());
    expect(first?.teamId).toBe('a');
    expect(first?.superpowers).toBe(2);
    expect(first?.powers).toBe(1);
    expect(first?.wins).toBe(1);
    expect(second?.teamId).toBe('b');
    expect(second?.superpowers).toBe(0);
    expect(second?.losses).toBe(1);
  });

  test('player standings aggregate superpowers', () => {
    const [leader] = derivePlayerStandings(statsState());
    expect(leader?.playerId).toBe('player-a');
    expect(leader?.superpowers).toBe(2);
  });

  test('player points value superpowers with the tournament answer values', () => {
    const state = statsState();
    state.tournament = {
      id: 'tournament-points',
      name: 'Points',
      date: '',
      timeZone: 'America/New_York',
      venue: '',
      organizer: '',
      status: 'running',
      rules: {
        ...defaultRules,
        superpowerValue: 20,
        powerValue: 15,
        tossupValue: 10,
        negValue: -5,
      },
      formatId: null,
      currentPhaseId: null,
      currentPacketId: null,
      currentRoundId: null,
      createdAt: '2026-09-05T12:00:00.000Z',
      updatedAt: '2026-09-05T12:00:00.000Z',
    };
    const [leader] = derivePlayerStandings(state);
    // 2×20 + 1×15 + 2×10 = 75 points in one game.
    expect(leader?.ppg).toBe(75);
    expect(
      playerPoints({ superpowers: 2, powers: 1, gets: 2, negs: 0, bonusPoints: 0 }, state.tournament?.rules),
    ).toBe(75);
  });
});
