/**
 * Scenario L (full SQBS tournament export), Director level: a completed
 * tournament exports through the canonical engine and parses back with
 * teams, players, games, scores, and detail intact. Multi-stage input
 * produces explicit selection/splitting warnings instead of a silent
 * flatten.
 */

import { describe, expect, test } from 'vitest';
import { parseSqbsTournamentFile } from '@qbsheet/tournament-formats';
import { emptyDirectorState, type DirectorState } from '../domain';
import {
  exportSqbs,
  exportSqbsTournament,
  sqbsTournamentFileName,
  sqbsTournamentScopes,
} from './interchange';

const NOW = '2026-09-05T12:00:00.000Z';

function scenarioState(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-1',
    name: 'Saturday Invitational',
    date: '2026-09-05',
    venue: '',
    organizer: '',
    status: 'complete',
    timeZone: 'America/New_York',
    rules: {
      tossupValue: 10,
      superpowerValue: null,
      powerValue: 15,
      negValue: -5,
      useBonuses: true,
      bonusValue: 10,
      tossupCount: 20,
      bonusParts: 3,
      minimumBonusParts: null,
      maximumBonusScore: null,
      bonusDivisor: null,
      bouncebacks: false,
      overtime: false,
      overtimeTossupCount: 1,
      overtimeBonuses: false,
      timed: false,
      lightning: false,
      lightningCountPerTeam: 0,
      lightningDivisor: 10,
      maximumTossupCount: null,
      maximumActivePlayers: 4,
      regulationMinutes: 26,
      tiebreakers: ['record', 'points'],
    },
    formatId: null,
    currentPhaseId: null,
    currentPacketId: null,
    currentRoundId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  state.organizations = [{ id: 'org-wren', name: 'Wren', shortName: '', notes: '' }];
  const team = (id: string, displayName: string, organizationId: string | null) => ({
    id,
    organizationId,
    displayName,
    teamLetter: 'A' as const,
    seed: null as number | null,
    status: 'confirmed' as const,
    createdAt: NOW,
    updatedAt: NOW,
  });
  state.teams = [
    team('team-a', 'Wren A', 'org-wren'),
    team('team-b', 'Wren B', 'org-wren'),
    team('team-c', 'Aiken', null),
    team('team-d', 'Dorman', null),
  ];
  const player = (id: string, teamId: string, name: string, schoolYear?: number) => ({
    id,
    teamId,
    name,
    captain: false,
    active: true,
    ...(schoolYear !== undefined ? { schoolYear } : {}),
    rosterNumber: undefined as string | number | undefined,
  });
  state.players = [
    player('player-a1', 'team-a', 'Ava', 10),
    player('player-a2', 'team-a', 'Ben'),
    player('player-b1', 'team-b', 'Cal'),
    player('player-c1', 'team-c', 'Eli'),
    player('player-d1', 'team-d', 'Fay'),
  ];
  state.phases = [
    {
      id: 'phase-prelims',
      name: 'Prelims',
      kind: 'preliminary',
      order: 1,
      formatId: 'format-1',
      poolIds: ['pool-1', 'pool-2'],
      roundIds: ['round-1'],
      advancementRule: null,
      carryover: false,
      status: 'complete',
    },
    {
      id: 'phase-playoffs',
      name: 'Playoffs',
      kind: 'playoff',
      order: 2,
      formatId: 'format-1',
      poolIds: [],
      roundIds: ['round-2'],
      advancementRule: null,
      carryover: false,
      status: 'complete',
    },
  ];
  state.pools = [
    { id: 'pool-1', phaseId: 'phase-prelims', name: 'Pool A', teamIds: ['team-a', 'team-c'], order: 0 },
    { id: 'pool-2', phaseId: 'phase-prelims', name: 'Pool B', teamIds: ['team-b', 'team-d'], order: 1 },
  ];
  state.packets = [
    {
      id: 'packet-1',
      name: 'Packet 1',
      source: 'manual',
      assignedRoundIds: ['round-1'],
      assignedGameIds: [],
      usedGameIds: [],
      replacementForPacketId: null,
      tiebreaker: false,
    },
  ];
  state.rounds = [
    {
      id: 'round-1',
      phaseId: 'phase-prelims',
      name: 'Round 1',
      number: 1,
      revision: 1,
      status: 'closed',
      packetId: 'packet-1',
      scheduledGameIds: ['scheduled-1', 'scheduled-2'],
      dayOrder: 0,
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
    },
    {
      id: 'round-2',
      phaseId: 'phase-playoffs',
      name: 'Round 2',
      number: 2,
      revision: 1,
      status: 'closed',
      packetId: null,
      scheduledGameIds: ['scheduled-3'],
      dayOrder: 1,
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
    },
  ];
  const scheduled = (
    id: string,
    roundId: string,
    poolId: string | null,
    leftTeamId: string,
    rightTeamId: string,
  ) => ({
    id,
    roundId,
    poolId,
    roomId: null as string | null,
    packetId: null as string | null,
    leftTeamId,
    rightTeamId,
    bye: false,
    status: 'accepted' as const,
    assignmentRevision: 1,
  });
  state.scheduledGames = [
    scheduled('scheduled-1', 'round-1', 'pool-1', 'team-a', 'team-c'),
    scheduled('scheduled-2', 'round-1', 'pool-2', 'team-b', 'team-d'),
    scheduled('scheduled-3', 'round-2', null, 'team-a', 'team-b'),
  ];
  const score = (
    teamId: string,
    points: number,
    detail?: { powers: number; gets: number; negs: number; bonuses: number; bonusPoints: number },
  ) => ({
    teamId,
    score: points,
    superpowers: 0,
    powers: detail?.powers ?? 0,
    gets: detail?.gets ?? 0,
    negs: detail?.negs ?? 0,
    bonuses: detail?.bonuses ?? 0,
    bonusPoints: detail?.bonusPoints ?? 0,
    bouncebacks: 0,
  });
  state.games = [
    {
      id: 'game-1',
      scheduledGameId: 'scheduled-1',
      roundId: 'round-1',
      packetId: 'packet-1',
      status: 'accepted',
      scores: [
        score('team-a', 320, { powers: 2, gets: 8, negs: 0, bonuses: 10, bonusPoints: 200 }),
        score('team-c', 150, { powers: 0, gets: 6, negs: 1, bonuses: 6, bonusPoints: 100 }),
      ],
      playerStats: [
        {
          playerId: 'player-a1',
          teamId: 'team-a',
          superpowers: 0,
          powers: 2,
          gets: 5,
          negs: 0,
          bonusPoints: 0,
          tossupsHeard: 20,
        },
        {
          playerId: 'player-a2',
          teamId: 'team-a',
          superpowers: 0,
          powers: 0,
          gets: 3,
          negs: 0,
          bonusPoints: 0,
          tossupsHeard: 20,
        },
        {
          playerId: 'player-c1',
          teamId: 'team-c',
          superpowers: 0,
          powers: 0,
          gets: 6,
          negs: 1,
          bonusPoints: 0,
          tossupsHeard: 20,
        },
      ],
      source: 'manual',
      detailedStats: 'complete',
      // Exact match TUH, as ingest persists it: team TUH and GP derive from
      // this game fact, never from summed player exposure (#746).
      tossupsRead: 20,
      overtimeTossupsRead: 0,
    },
    {
      // Forfeit: Dorman forfeits to Wren B.
      id: 'game-2',
      scheduledGameId: 'scheduled-2',
      roundId: 'round-1',
      packetId: 'packet-1',
      status: 'forfeit',
      forfeitedTeamId: 'team-d',
      scores: [score('team-b', 0), score('team-d', 0)],
      playerStats: [],
      source: 'manual',
      detailedStats: 'unknown',
    },
    {
      // Manual final score with no detail.
      id: 'game-3',
      scheduledGameId: 'scheduled-3',
      roundId: 'round-2',
      packetId: null,
      status: 'accepted',
      scores: [score('team-a', 260), score('team-b', 240)],
      playerStats: [],
      source: 'paper',
      detailedStats: 'unknown',
    },
  ];
  return state;
}

describe('SQBS tournament export from Director state', () => {
  test('a prelim scope exports divisions, detail, and honest forfeits', () => {
    const exported = exportSqbsTournament(scenarioState(), { phaseId: 'phase-prelims' });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.scopeLabel).toBe('Prelims');
    expect(exported.teamCount).toBe(4);
    expect(exported.gameCount).toBe(2);

    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const tournament = parsed.value;
    // Same-organization teams stay distinct; the sophomore keeps her year.
    expect(tournament.teams.map((entry) => entry.name)).toEqual(['Wren A', 'Wren B', 'Aiken', 'Dorman']);
    expect(tournament.teams[0]!.players.map((entry) => entry.name)).toEqual(['Ava (10)', 'Ben']);
    expect(tournament.divisions).toEqual(['Pool A', 'Pool B']);
    expect(tournament.teams.map((entry) => entry.divisionIndex)).toEqual([0, 1, 0, 1]);
    expect(tournament.pointValues).toEqual([15, 10, -5, 0]);
    expect(tournament.packetNames).toEqual(['Packet 1']);

    const [played, forfeit] = tournament.games;
    expect([played!.left.score, played!.right.score]).toEqual([320, 150]);
    expect(played!.tossupsHeard).toBe(20);
    expect(played!.left.players[0]).toMatchObject({ playerIndex: 0, gamesPlayed: 1, points: 80 });
    // Forfeit winner (Wren B) is exported on the left with -1 scores.
    expect(forfeit!.forfeit).toBe(true);
    expect(tournament.teams[forfeit!.left.teamIndex]!.name).toBe('Wren B');
    expect([forfeit!.left.score, forfeit!.right.score]).toEqual([-1, -1]);
  });

  test('the whole-tournament scope warns that pool semantics are lost', () => {
    const exported = exportSqbsTournament(scenarioState(), {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.scopeLabel).toBe('Entire tournament');
    expect(exported.gameCount).toBe(3);
    expect(exported.warnings.join('\n')).toMatch(/multiple stages/);

    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.divisions).toEqual([]);
    // The manual-score game keeps its score with honest-zero detail.
    const manual = parsed.value.games.find((game) => game.round === 2)!;
    expect([manual.left.score, manual.right.score]).toEqual([260, 240]);
    expect(manual.tossupsHeard).toBe(0);
  });

  test('an empty scope fails with an actionable error', () => {
    const state = scenarioState();
    state.games = [];
    const exported = exportSqbsTournament(state, { phaseId: 'phase-prelims' });
    expect(exported.ok).toBe(false);
    expect(exported.errors.join('\n')).toMatch(/nothing to export/);
  });

  test('a pool scope exports only that pool’s game', () => {
    const exported = exportSqbsTournament(scenarioState(), { poolId: 'pool-1' });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.scopeLabel).toBe('Prelims · Pool A');
    expect(exported.teamCount).toBe(2);
    expect(exported.gameCount).toBe(1);

    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // One pool needs no divisions, and only its own game travels.
    expect(parsed.value.divisions).toEqual([]);
    expect(parsed.value.games).toHaveLength(1);
    const [game] = parsed.value.games;
    expect([game!.left.score, game!.right.score]).toEqual([320, 150]);
    expect(parsed.value.teams.map((entry) => entry.name)).toEqual(['Wren A', 'Aiken']);
  });

  test('custom point values flow into the SQBS slots', () => {
    const state = scenarioState();
    state.tournament!.rules.superpowerValue = 20;
    const exported = exportSqbsTournament(state, { phaseId: 'phase-prelims' });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.pointValues).toEqual([20, 15, 10, -5]);
  });

  test('score-only games export honest zeroes with warnings', () => {
    const exported = exportSqbsTournament(scenarioState(), {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    // Game 3 is a manual final score with no player detail: TUH and bonus
    // fields are unknown, so the file carries zeroes and says so.
    expect(exported.warnings.join('\n')).toMatch(/unknown tossups-heard/);
    expect(exported.warnings.join('\n')).toMatch(/unknown bonus/);

    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const manual = parsed.value.games.find((game) => game.round === 2)!;
    expect([manual.left.score, manual.right.score]).toEqual([260, 240]);
    expect(manual.tossupsHeard).toBe(0);
    expect(manual.left.bonusesHeard).toBe(0);
  });

  test('more than eight participating players on one side blocks the export', () => {
    const state = scenarioState();
    for (let index = 3; index <= 9; index += 1) {
      state.players.push({
        id: `player-a${index}`,
        teamId: 'team-a',
        name: `Teammate ${index}`,
        captain: false,
        active: true,
        rosterNumber: undefined,
      });
    }
    const game = state.games.find((entry) => entry.id === 'game-1')!;
    game.playerStats = [
      ...Array.from({ length: 9 }, (_, index) => ({
        playerId: `player-a${index + 1}`,
        teamId: 'team-a',
        superpowers: 0,
        powers: index === 0 ? 2 : 0,
        gets: 1,
        negs: 0,
        bonusPoints: 0,
        tossupsHeard: 20,
      })),
      ...game.playerStats.filter((stat) => stat.teamId !== 'team-a'),
    ];
    const exported = exportSqbsTournament(state, { phaseId: 'phase-prelims' });
    expect(exported.ok).toBe(false);
    expect(exported.text).toBe('');
    expect(exported.errors.join('\n')).toMatch(/at most 8 players/);
  });

  test('a forfeit with no recorded winner blocks the export instead of guessing', () => {
    const state = scenarioState();
    const game = state.games.find((entry) => entry.id === 'game-2')!;
    game.status = 'forfeit';
    delete game.forfeitedTeamId;
    const exported = exportSqbsTournament(state, { phaseId: 'phase-prelims' });
    expect(exported.ok).toBe(false);
    expect(exported.text).toBe('');
    expect(exported.errors.join('\n')).toMatch(/no recorded winner/);
  });

  test('scope options list the tournament, its stages, and its pools', () => {
    const scopes = sqbsTournamentScopes(scenarioState());
    expect(scopes.map((option) => option.key)).toEqual([
      'entire',
      'phase:phase-prelims',
      'phase:phase-playoffs',
      'pool:pool-1',
      'pool:pool-2',
    ]);
    expect(scopes.map((option) => option.label)).toEqual([
      'Entire tournament',
      'Prelims',
      'Playoffs',
      'Prelims · Pool A',
      'Prelims · Pool B',
    ]);
    expect(scopes.map((option) => option.detail)).toEqual([
      '3 games',
      '2 games',
      '1 game',
      '1 game',
      '1 game',
    ]);
  });

  test('a single-stage unpooled tournament offers only the entire tournament', () => {
    const state = scenarioState();
    state.phases = state.phases.filter((phase) => phase.id === 'phase-prelims');
    state.pools = [];
    state.rounds = state.rounds.filter((round) => round.id === 'round-1');
    state.scheduledGames = state.scheduledGames.filter((game) => game.roundId === 'round-1');
    state.games = state.games.filter((game) => game.roundId === 'round-1');
    expect(sqbsTournamentScopes(state).map((option) => option.key)).toEqual(['entire']);
  });

  test('tournament filenames never collide with the roster-only file', () => {
    const state = scenarioState();
    expect(sqbsTournamentFileName(state, {})).toBe('Saturday-Invitational-tournament.sqbs');
    expect(sqbsTournamentFileName(state, { phaseId: 'phase-prelims' })).toBe(
      'Saturday-Invitational-Prelims.sqbs',
    );
    expect(sqbsTournamentFileName(state, { poolId: 'pool-1' })).toBe(
      'Saturday-Invitational-Prelims-Pool-A.sqbs',
    );
    for (const scope of sqbsTournamentScopes(state).map((option) => option.scope)) {
      expect(sqbsTournamentFileName(state, scope)).not.toBe('Saturday-Invitational.sqbs');
    }
  });

  test('the roster-only export still works and stays positional', () => {
    const roster = exportSqbs(scenarioState());
    expect(roster.split(/\r?\n/)[0]).toBe('4');
    expect(roster).toContain('Wren A');
  });
});
