/**
 * SQBS exports encode the statistical game set for their scope (#894).
 *
 * A carryover playoff stage must include qualifying prior-phase head-to-head
 * games exactly once (the way canonical Director standings count them), and
 * games on tiebreaker packets must stay out unless the tournament rules count
 * them statistically. Previously the export used physically-assigned games
 * only, so playoff files dropped carryover history while silently keeping
 * non-statistical tiebreakers.
 */
import { describe, expect, test } from 'vitest';
import { parseSqbsTournamentFile } from '@qbsheet/tournament-formats';
import { defaultRules, emptyDirectorState, type DirectorState, type GameRecord } from '../domain/model';
import { exportSqbsTournament, sqbsTournamentScopes } from './interchange';

function team(id: string, name: string) {
  return {
    id,
    organizationId: null,
    displayName: name,
    teamLetter: name[0]!,
    seed: null,
    status: 'confirmed' as const,
    createdAt: '2026-09-11T09:00:00Z',
    updatedAt: '2026-09-11T09:00:00Z',
  };
}

function player(id: string, teamId: string, name: string) {
  return { id, teamId, name, captain: false, active: true };
}

function stats(playerId: string, teamId: string): GameRecord['playerStats'][number] {
  return {
    playerId,
    teamId,
    superpowers: 0,
    powers: 1,
    gets: 5,
    negs: 0,
    bonusPoints: 0,
    tossupsHeard: 20,
  };
}

function scores(
  leftTeam: string,
  leftScore: number,
  rightTeam: string,
  rightScore: number,
): GameRecord['scores'] {
  const side = (teamId: string, score: number): GameRecord['scores'][number] => ({
    teamId,
    score,
    superpowers: 0,
    powers: 1,
    gets: 5,
    negs: 0,
    bonuses: 6,
    bonusPoints: 100,
  });
  return [side(leftTeam, leftScore), side(rightTeam, rightScore)];
}

function acceptedGame(
  id: string,
  scheduledGameId: string,
  roundId: string,
  leftTeam: string,
  leftScore: number,
  rightTeam: string,
  rightScore: number,
  acceptedAt: string,
  packetId?: string,
): GameRecord {
  return {
    id,
    scheduledGameId,
    roundId,
    packetId: packetId ?? null,
    status: 'accepted',
    scores: scores(leftTeam, leftScore, rightTeam, rightScore),
    playerStats: [stats(`${leftTeam}-p1`, leftTeam), stats(`${rightTeam}-p1`, rightTeam)],
    tossupsRead: 20,
    source: 'manual',
    detailedStats: 'complete',
    acceptedAt,
  };
}

/** Prelims plus a carryover playoff stage, one tiebreaker game, one correction. */
function carryoverState(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 't-scope',
    name: 'Scope Event',
    date: '2026-09-11',
    timeZone: 'America/New_York',
    venue: 'Gym',
    organizer: 'TD',
    status: 'running',
    rules: { ...defaultRules, tiebreakerCountsStatistically: false },
    createdAt: '2026-09-11T09:00:00Z',
    updatedAt: '2026-09-11T09:00:00Z',
    formatId: null,
    currentPhaseId: null,
    currentPacketId: null,
    currentRoundId: null,
  };
  for (const [id, name] of [
    ['team-a', 'Alpha'],
    ['team-b', 'Bravo'],
    ['team-c', 'Charlie'],
    ['team-d', 'Delta'],
  ] as const) {
    state.teams.push(team(id, name));
    state.players.push(player(`${id}-p1`, id, `${name} 1`), player(`${id}-p2`, id, `${name} 2`));
  }
  state.packets.push(
    {
      id: 'packet-prelim',
      name: 'Packet 1',
      source: 'manual',
      assignedRoundIds: ['round-r1', 'round-r2'],
      assignedGameIds: [],
      usedGameIds: [],
      replacementForPacketId: null,
      tiebreaker: false,
    },
    {
      id: 'packet-tb',
      name: 'Tiebreaker',
      source: 'manual',
      assignedRoundIds: ['round-rtb'],
      assignedGameIds: [],
      usedGameIds: [],
      replacementForPacketId: null,
      tiebreaker: true,
    },
  );
  state.phases.push(
    {
      id: 'phase-pre',
      name: 'Prelims',
      kind: 'preliminary',
      order: 1,
      formatId: 'format-1',
      poolIds: [],
      roundIds: ['round-r1', 'round-rtb'],
      advancementRule: null,
      carryover: false,
      status: 'complete',
    },
    {
      id: 'phase-po',
      name: 'Playoffs',
      kind: 'playoff',
      order: 2,
      formatId: 'format-1',
      teamIds: ['team-a', 'team-b', 'team-c', 'team-d'],
      poolIds: ['pool-p1', 'pool-p2'],
      roundIds: ['round-r2'],
      advancementRule: null,
      carryover: true,
      status: 'active',
    },
  );
  state.pools.push(
    { id: 'pool-p1', phaseId: 'phase-po', name: 'Top', teamIds: ['team-a', 'team-b'], order: 1 },
    { id: 'pool-p2', phaseId: 'phase-po', name: 'Bottom', teamIds: ['team-c', 'team-d'], order: 2 },
  );
  const round = (
    id: string,
    phaseId: string,
    number: number,
    dayOrder: number,
    packetId: string,
    scheduledGameIds: string[],
  ) => ({
    id,
    phaseId,
    name: `Round ${number}`,
    number,
    revision: 1,
    status: 'closed' as const,
    packetId,
    scheduledGameIds,
    scheduledStart: null,
    dayOrder,
    releasedAt: null,
    startedAt: null,
    closedAt: '2026-09-11T14:00:00Z',
  });
  state.rounds.push(
    round('round-r1', 'phase-pre', 1, 1, 'packet-prelim', ['sched-pre-ab', 'sched-pre-cd']),
    round('round-rtb', 'phase-pre', 2, 2, 'packet-prelim', ['sched-tb']),
    round('round-r2', 'phase-po', 3, 3, 'packet-prelim', ['sched-po-ab', 'sched-po-cd']),
  );
  const scheduled = (
    id: string,
    roundId: string,
    leftTeamId: string,
    rightTeamId: string,
    poolId: string | null,
  ) => ({
    id,
    roundId,
    poolId,
    roomId: null,
    packetId: null,
    leftTeamId,
    rightTeamId,
    bye: false,
    status: 'accepted' as const,
    assignmentRevision: 1,
  });
  state.scheduledGames.push(
    scheduled('sched-pre-ab', 'round-r1', 'team-a', 'team-b', null),
    scheduled('sched-pre-cd', 'round-r1', 'team-c', 'team-d', null),
    scheduled('sched-tb', 'round-rtb', 'team-a', 'team-b', null),
    scheduled('sched-po-ab', 'round-r2', 'team-a', 'team-b', 'pool-p1'),
    scheduled('sched-po-cd', 'round-r2', 'team-c', 'team-d', 'pool-p2'),
  );
  state.games.push(
    // A superseded correction: only the current copy may export.
    acceptedGame('g1-old', 'sched-pre-ab', 'round-r1', 'team-a', 100, 'team-b', 90, '2026-09-11T10:00:00Z'),
    acceptedGame('g1', 'sched-pre-ab', 'round-r1', 'team-a', 300, 'team-b', 200, '2026-09-11T11:00:00Z'),
    acceptedGame('g2', 'sched-pre-cd', 'round-r1', 'team-c', 250, 'team-d', 150, '2026-09-11T11:00:00Z'),
    // Non-statistical tiebreaker packet game: visible per-game, never in totals.
    acceptedGame(
      'g3tb',
      'sched-tb',
      'round-rtb',
      'team-a',
      120,
      'team-b',
      100,
      '2026-09-11T12:00:00Z',
      'packet-tb',
    ),
    acceptedGame('g4', 'sched-po-ab', 'round-r2', 'team-a', 320, 'team-b', 180, '2026-09-11T13:00:00Z'),
    acceptedGame('g5', 'sched-po-cd', 'round-r2', 'team-c', 260, 'team-d', 190, '2026-09-11T13:00:00Z'),
  );
  return state;
}

/** Wins/losses recomputed from SQBS game lines, independent of repo selectors. */
function sqbsRecords(text: string): Map<string, { wins: number; losses: number }> {
  const parsed = parseSqbsTournamentFile(text);
  if (!parsed.ok)
    throw new Error(`SQBS parse failed: ${parsed.errors.map((entry) => entry.message).join('; ')}`);
  const table = new Map<string, { wins: number; losses: number }>();
  const name = (index: number) => parsed.value.teams[index]?.name ?? `team-${index}`;
  for (const game of parsed.value.games) {
    if (game.forfeit) continue;
    const left = name(game.left.teamIndex);
    const right = name(game.right.teamIndex);
    for (const side of [left, right]) {
      if (!table.has(side)) table.set(side, { wins: 0, losses: 0 });
    }
    if (game.left.score === game.right.score) continue;
    const winner = game.left.score > game.right.score ? left : right;
    const loser = winner === left ? right : left;
    table.get(winner)!.wins += 1;
    table.get(loser)!.losses += 1;
  }
  return table;
}

describe('SQBS statistical stage scope (#894)', () => {
  test('carryover playoff export includes qualifying prior games exactly once', () => {
    const exported = exportSqbsTournament(carryoverState(), { phaseId: 'phase-po' });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.warnings.filter((entry) => /carryover/i.test(entry))).toHaveLength(1);
    expect(exported.gameCount).toBe(4);

    const records = sqbsRecords(exported.text);
    // Canonical playoff table: prelim A-B and C-D carry in, then playoff games.
    expect(records.get('Alpha')).toEqual({ wins: 2, losses: 0 });
    expect(records.get('Bravo')).toEqual({ wins: 0, losses: 2 });
    expect(records.get('Charlie')).toEqual({ wins: 2, losses: 0 });
    expect(records.get('Delta')).toEqual({ wins: 0, losses: 2 });
    // The superseded correction and the tiebreaker never appear.
    expect(exported.text).not.toMatch(/1\s*\n100(\.00)?\s*\n/);
  });

  test('playoff export without carryover keeps stage games only', () => {
    const state = carryoverState();
    state.phases.find((entry) => entry.id === 'phase-po')!.carryover = false;
    const exported = exportSqbsTournament(state, { phaseId: 'phase-po' });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.warnings.filter((entry) => /carryover/i.test(entry))).toEqual([]);
    expect(exported.gameCount).toBe(2);
    const records = sqbsRecords(exported.text);
    expect(records.get('Alpha')).toEqual({ wins: 1, losses: 0 });
    expect(records.get('Charlie')).toEqual({ wins: 1, losses: 0 });
  });

  test('prelim export omits the non-statistical tiebreaker with a warning', () => {
    const exported = exportSqbsTournament(carryoverState(), { phaseId: 'phase-pre' });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.gameCount).toBe(2);
    expect(exported.warnings.filter((entry) => /tiebreaker/i.test(entry))).toHaveLength(1);
    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.games.some((game) => game.left.score === 120 || game.right.score === 120)).toBe(
      false,
    );
  });

  test('tiebreaker games count when tournament rules say they count', () => {
    const state = carryoverState();
    if (!state.tournament) throw new Error('fixture: no tournament');
    state.tournament.rules = { ...state.tournament.rules, tiebreakerCountsStatistically: true };
    const exported = exportSqbsTournament(state, { phaseId: 'phase-pre' });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.gameCount).toBe(3);
    expect(exported.warnings.filter((entry) => /tiebreaker/i.test(entry))).toEqual([]);
  });

  test('entire-tournament export has no duplicate carryover copies', () => {
    const exported = exportSqbsTournament(carryoverState(), {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.gameCount).toBe(4);
    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const lines = parsed.value.games.map((game) =>
      [game.left.score, game.right.score].sort((a, b) => b - a).join('-'),
    );
    expect([...lines].sort()).toEqual(['300-200', '250-150', '320-180', '260-190'].sort());
  });

  test('carryover pool export includes qualifying prior head-to-head games', () => {
    const exported = exportSqbsTournament(carryoverState(), { poolId: 'pool-p1' });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.gameCount).toBe(2);
    const records = sqbsRecords(exported.text);
    expect(records.get('Alpha')).toEqual({ wins: 2, losses: 0 });
    expect(records.get('Bravo')).toEqual({ wins: 0, losses: 2 });
    expect(records.has('Charlie')).toBe(false);
  });

  test('scope picker counts describe the statistical game set', () => {
    const scopes = new Map(sqbsTournamentScopes(carryoverState()).map((entry) => [entry.key, entry.detail]));
    expect(scopes.get('entire')).toBe('4 games');
    expect(scopes.get('phase:phase-po')).toBe('4 games');
    expect(scopes.get('phase:phase-pre')).toBe('2 games');
    expect(scopes.get('pool:pool-p1')).toBe('2 games');
  });
});
