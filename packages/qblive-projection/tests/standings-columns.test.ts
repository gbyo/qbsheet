/**
 * Scenario: the Live standings table carries the YellowFruit-equivalent
 * canonical columns (games, TUH, bonus facts, PPTUH) with honest unknowns,
 * and every row stays exactly as wide as the header (#753).
 */

import { describe, expect, test } from 'vitest';
import { defaultRules, emptyDirectorState, type DirectorState } from '@qbsheet/tournament-domain';
import { buildStandingsTable } from '../src/tables';

const at = '2026-09-05T10:00:00.000Z';

function liveState(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-live-standings',
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
    createdAt: at,
    updatedAt: at,
  };
  state.teams = [
    { id: 'team-a', organizationId: null, displayName: 'Aiken', teamLetter: 'A', seed: null, status: 'confirmed', createdAt: at, updatedAt: at },
    { id: 'team-b', organizationId: null, displayName: 'Wren', teamLetter: 'A', seed: null, status: 'confirmed', createdAt: at, updatedAt: at },
    { id: 'team-c', organizationId: null, displayName: 'Abbeville', teamLetter: 'A', seed: null, status: 'confirmed', createdAt: at, updatedAt: at },
  ];
  state.rounds = [
    { id: 'round-1', phaseId: 'phase-1', name: 'Round 1', number: 1, revision: 1, status: 'closed', packetId: null, scheduledGameIds: ['scheduled-1'], dayOrder: 0, scheduledStart: null, releasedAt: null, startedAt: null, closedAt: null },
  ];
  state.scheduledGames = [
    { id: 'scheduled-1', roundId: 'round-1', roomId: null, packetId: null, leftTeamId: 'team-a', rightTeamId: 'team-b', bye: false, status: 'accepted', assignmentRevision: 1 },
  ];
  const teamScore = (teamId: string, score: number, extra: Record<string, number> = {}) => ({
    teamId,
    score,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonuses: 0,
    bonusPoints: 0,
    bouncebacks: 0,
    ...extra,
  });
  state.games = [
    {
      id: 'game-1',
      scheduledGameId: 'scheduled-1',
      roundId: 'round-1',
      packetId: null,
      status: 'accepted',
      scores: [
        teamScore('team-a', 320, { powers: 4, gets: 8, negs: 1, bonuses: 12, bonusPoints: 130 }),
        teamScore('team-b', 110, { powers: 1, gets: 5, negs: 2, bonuses: 6, bonusPoints: 40 }),
      ],
      playerStats: [
        { playerId: 'player-a', teamId: 'team-a', superpowers: 0, powers: 4, gets: 8, negs: 1, bonusPoints: 0, tossupsHeard: 20 },
        { playerId: 'player-b', teamId: 'team-b', superpowers: 0, powers: 1, gets: 5, negs: 2, bonusPoints: 0, tossupsHeard: null },
      ],
      source: 'manual',
      detailedStats: 'complete',
    },
  ];
  return state;
}

const naming = {
  teamName: (teamId: string) => teamId,
  playerName: () => null,
};

const overall = { id: 'overall', label: 'Overall' };

function cell(table: ReturnType<typeof buildStandingsTable>, teamId: string, columnId: string) {
  const index = table.columns.findIndex((column) => column.id === columnId);
  expect(index).toBeGreaterThanOrEqual(0);
  const row = table.rows.find((entry) => entry.teamId === teamId);
  expect(row).toBeDefined();
  return row!.cells[index]!;
}

describe('Live standings parity columns', () => {
  test('every row is exactly as wide as the header', () => {
    const table = buildStandingsTable(liveState(), overall, naming);

    expect(table.columns.map((column) => column.id)).toEqual([
      'rank',
      'team',
      'record',
      'pct',
      'pf',
      'pa',
      'ppg',
      'margin',
      'games',
      'tuh',
      'bonuses',
      'bonuspoints',
      'pptuh',
    ]);
    for (const row of table.rows) expect(row.cells).toHaveLength(table.columns.length);
  });

  test('known teams carry exact G/TUH/bonus/PPTUH values', () => {
    const table = buildStandingsTable(liveState(), overall, naming);

    expect(cell(table, 'team-a', 'games')).toEqual({ value: 1, display: '1' });
    expect(cell(table, 'team-a', 'tuh')).toEqual({ value: 20, display: '20' });
    expect(cell(table, 'team-a', 'bonuses')).toEqual({ value: 12, display: '12' });
    expect(cell(table, 'team-a', 'bonuspoints')).toEqual({ value: 130, display: '130' });
    expect(cell(table, 'team-a', 'pptuh')).toEqual({ value: 16, display: '16.00' });
    expect(cell(table, 'team-a', 'pct')).toEqual({ value: 1, display: '1.000' });
  });

  test('unknown TUH unknowns PPTUH too, and an unplayed team has no win rate', () => {
    const table = buildStandingsTable(liveState(), overall, naming);

    // team-b's scoresheet omitted TUH: unknown in, unknown out — never zero.
    expect(cell(table, 'team-b', 'tuh')).toEqual({ value: null, display: '—' });
    expect(cell(table, 'team-b', 'pptuh')).toEqual({ value: null, display: '—' });
    // team-c never played: no rate, no TUH, no PPTUH.
    expect(cell(table, 'team-c', 'pct')).toEqual({ value: null, display: '—' });
    expect(cell(table, 'team-c', 'games')).toEqual({ value: 0, display: '0' });
    expect(cell(table, 'team-c', 'tuh')).toEqual({ value: 0, display: '0' });
  });
});
