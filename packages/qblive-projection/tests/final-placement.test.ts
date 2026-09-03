/**
 * Scenario J (final rank override reaches Live): the explicit final
 * placement reorders the overall Live standings table, while a scoped
 * (stage) table keeps its calculated order — the override answers "who
 * finished where", not "who led the prelims".
 */

import { describe, expect, test } from 'vitest';
import { defaultRules, emptyDirectorState, type DirectorState } from '@qbsheet/tournament-domain';
import { buildStandingsTable } from '../src/tables';

function liveState(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-live-final',
    name: 'Saturday Event',
    date: '2026-09-05',
    venue: '',
    organizer: '',
    status: 'running',
    timeZone: 'America/New_York',
    rules: structuredClone(defaultRules),
    formatId: null,
    currentPhaseId: null,
    currentPacketId: null,
    currentRoundId: null,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
  };
  state.teams = [
    {
      id: 'team-a',
      organizationId: null,
      displayName: 'Aiken',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:00:00.000Z',
    },
    {
      id: 'team-b',
      organizationId: null,
      displayName: 'Wren',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:00:00.000Z',
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
      packetId: null,
      scheduledGameIds: [],
      dayOrder: 0,
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
      roomId: null,
      packetId: null,
      leftTeamId: 'team-a',
      rightTeamId: 'team-b',
      bye: false,
      status: 'accepted',
    },
    {
      id: 'scheduled-2',
      roundId: 'round-1',
      roomId: null,
      packetId: null,
      leftTeamId: 'team-b',
      rightTeamId: 'team-a',
      bye: false,
      status: 'accepted',
    },
  ];
  const teamScore = (teamId: string, score: number) => ({
    teamId,
    score,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonuses: 0,
    bonusPoints: 0,
    bouncebacks: 0,
  });
  // Both teams finish 1-1, but Aiken's PPG is higher, so Aiken leads
  // the calculated order.
  state.games = [
    {
      id: 'game-1',
      scheduledGameId: 'scheduled-1',
      roundId: 'round-1',
      packetId: null,
      status: 'accepted',
      scores: [teamScore('team-a', 320), teamScore('team-b', 110)],
      playerStats: [],
      source: 'manual',
      detailedStats: 'unknown',
    },
    {
      id: 'game-2',
      scheduledGameId: 'scheduled-2',
      roundId: 'round-1',
      packetId: null,
      status: 'accepted',
      scores: [teamScore('team-b', 200), teamScore('team-a', 150)],
      playerStats: [],
      source: 'manual',
      detailedStats: 'unknown',
    },
  ];
  return state;
}

const naming = {
  teamName: (teamId: string) => teamId,
  playerName: () => null,
};

describe('Live standings and the explicit final placement', () => {
  test('overall table follows the override; scoped tables stay calculated', () => {
    const state = liveState();
    const overall = { id: 'overall', label: 'Overall' };
    const scoped = { id: 'prelims', label: 'Prelims', phaseId: 'phase-1' };

    expect(buildStandingsTable(state, overall, naming).rows.map((row) => row.teamId)).toEqual([
      'team-a',
      'team-b',
    ]);

    state.tournament!.finalPlacement = {
      order: ['team-b', 'team-a'],
      actor: 'Director',
      at: '2026-09-05T18:00:00.000Z',
      reason: 'Final decided it.',
    };

    // The public overall table leads with the override winner…
    const placed = buildStandingsTable(state, overall, naming);
    expect(placed.rows.map((row) => row.teamId)).toEqual(['team-b', 'team-a']);
    expect(placed.rows[0].cells[0]).toMatchObject({ value: 1, display: '1' });

    // …but the stage table keeps the calculated order, and clearing the
    // override restores the calculated order everywhere.
    expect(buildStandingsTable(state, scoped, naming).rows.map((row) => row.teamId)).toEqual([
      'team-a',
      'team-b',
    ]);
    state.tournament!.finalPlacement = undefined;
    expect(buildStandingsTable(state, overall, naming).rows.map((row) => row.teamId)).toEqual([
      'team-a',
      'team-b',
    ]);
  });
});
