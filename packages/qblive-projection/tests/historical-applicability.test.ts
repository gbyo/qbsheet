/**
 * Scenario: QBLive standings columns follow the historical scoring definitions of
 * the accepted games in scope, not the tournament's current rules (#868).
 *
 * Changing current rules for future games must not remove historical lightning /
 * bounceback columns, relabel historical tiers, or rewrite the Lightning/G
 * denominator with forfeit games.
 */

import { describe, expect, test } from 'vitest';
import {
  defaultRules,
  emptyDirectorState,
  type DirectorState,
  type TournamentRules,
} from '@qbsheet/tournament-domain';
import {
  buildPlayerStatisticsTable,
  buildStandingsTable,
  buildTeamStatisticsTable,
} from '../src/tables';

const at = '2026-09-10T10:00:00.000Z';

const historical: TournamentRules = {
  ...structuredClone(defaultRules),
  powerValue: 15,
  useBonuses: true,
  bouncebacks: true,
  lightning: true,
};

const current: TournamentRules = {
  ...structuredClone(defaultRules),
  powerValue: 20,
  useBonuses: true,
  bouncebacks: false,
  lightning: false,
};

function teamScore(teamId: string, score: number, extra: Record<string, number | null> = {}) {
  return {
    teamId,
    score,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonuses: 6,
    bonusPoints: 60,
    bouncebacks: 10,
    lightningPoints: 0,
    ...extra,
  };
}

function historicalState(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-historical',
    name: 'Mid-season event',
    date: '2026-09-10',
    venue: '',
    organizer: '',
    status: 'running',
    timeZone: 'America/New_York',
    rules: structuredClone(current),
    formatId: null,
    currentPhaseId: null,
    currentPacketId: null,
    currentRoundId: null,
    createdAt: at,
    updatedAt: at,
  };
  for (const [id, name] of [
    ['team-a', 'Aiken'],
    ['team-b', 'Wren'],
  ] as const) {
    state.teams.push({
      id,
      organizationId: null,
      displayName: name,
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      createdAt: at,
      updatedAt: at,
    });
  }
  state.rounds = [
    {
      id: 'round-1',
      phaseId: 'phase-1',
      name: 'Round 1',
      number: 1,
      revision: 1,
      status: 'closed',
      packetId: null,
      scheduledGameIds: ['scheduled-1', 'scheduled-2'],
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
      assignmentRevision: 1,
    },
    {
      id: 'scheduled-2',
      roundId: 'round-1',
      roomId: null,
      packetId: null,
      leftTeamId: 'team-a',
      rightTeamId: 'team-b',
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
      packetId: null,
      status: 'accepted',
      tossupsRead: 20,
      definitionDigest: 'd1',
      scores: [
        teamScore('team-a', 320, { lightningPoints: 30 }),
        teamScore('team-b', 110, { lightningPoints: 10 }),
      ],
      playerStats: [],
      source: 'manual',
      detailedStats: 'complete',
    },
    {
      // Pure-forfeit placeholder: counts in W/L but never in rate denominators.
      id: 'game-2',
      scheduledGameId: 'scheduled-2',
      roundId: 'round-1',
      packetId: null,
      status: 'forfeit',
      forfeitedTeamId: 'team-a',
      tossupsRead: 0,
      definitionDigest: 'd1',
      scores: [
        { ...teamScore('team-a', 0), bouncebacks: null, lightningPoints: 0 },
        { ...teamScore('team-b', 200), bouncebacks: null, lightningPoints: 0 },
      ],
      playerStats: [],
      source: 'manual',
      detailedStats: 'complete',
    },
  ];
  state.gameDefinitions = [
    {
      id: 'def-1',
      scheduledGameId: 'scheduled-1',
      revision: 1,
      createdAt: at,
      rules: structuredClone(historical),
      roundId: 'round-1',
      packetId: null,
      leftTeamId: 'team-a',
      rightTeamId: 'team-b',
      leftRoster: [],
      rightRoster: [],
      assignmentRevision: 1,
      digest: 'd1',
    },
    {
      id: 'def-2',
      scheduledGameId: 'scheduled-2',
      revision: 1,
      createdAt: at,
      rules: structuredClone(historical),
      roundId: 'round-1',
      packetId: null,
      leftTeamId: 'team-a',
      rightTeamId: 'team-b',
      leftRoster: [],
      rightRoster: [],
      assignmentRevision: 1,
      digest: 'd1',
    },
  ];
  return state;
}

const naming = {
  teamName: (teamId: string) => teamId,
  playerName: () => null,
};

const overall = { id: 'overall', label: 'Overall' };

function cell(
  table: {
    columns: { id: string }[];
    rows: { teamId?: string; cells: { value: unknown; display: string }[] }[];
  },
  teamId: string,
  columnId: string,
) {
  const index = table.columns.findIndex((column) => column.id === columnId);
  expect(index).toBeGreaterThanOrEqual(0);
  const row = table.rows.find((entry) => entry.teamId === teamId);
  expect(row).toBeDefined();
  return row!.cells[index]!;
}

describe('QBLive historical applicability (#868)', () => {
  test('standings keep historical columns and tier labels after a rules change', () => {
    const table = buildStandingsTable(historicalState(), overall, naming);
    const ids = table.columns.map((column) => column.id);

    expect(ids).toContain('lightning');
    expect(ids).toContain('lightningpg');
    expect(ids).toContain('bb');
    const powers = table.columns.find((column) => column.id === 'powers');
    expect(powers?.label).toBe('15');
    for (const row of table.rows) expect(row.cells).toHaveLength(table.columns.length);
  });

  test('Lightning/G divides by applicable non-forfeit games, not games played', () => {
    const table = buildStandingsTable(historicalState(), overall, naming);

    // team-a: 30 lightning points in one real game plus a pure-forfeit placeholder.
    expect(cell(table, 'team-a', 'games')).toEqual({ value: 2, display: '2' });
    expect(cell(table, 'team-a', 'lightningpg')).toEqual({ value: 30, display: '30.0' });
    expect(cell(table, 'team-b', 'lightningpg')).toEqual({ value: 10, display: '10.0' });
  });

  test('team statistics table follows the same historical scope', () => {
    const table = buildTeamStatisticsTable(historicalState(), overall, naming);
    const ids = table.columns.map((column) => column.id);

    expect(ids).toContain('lightning');
    expect(ids).toContain('bb');
    const powers = table.columns.find((column) => column.id === 'powers');
    expect(powers?.label).toBe('15');
    expect(cell(table, 'team-a', 'lightningpg')).toEqual({ value: 30, display: '30.0' });
    for (const row of table.rows) expect(row.cells).toHaveLength(table.columns.length);
  });

  test('player statistics table keeps historical tier labels after a rules change (#871)', () => {
    const table = buildPlayerStatisticsTable(historicalState(), overall, naming);
    const powers = table.columns.find((column) => column.id === 'powers');
    // Historical 15-point powers, not the current 20-point definition.
    expect(powers?.label).toBe('15');
    for (const row of table.rows) expect(row.cells).toHaveLength(table.columns.length);
  });
});
