/**
 * A whole tournament day, driven through the canonical engines.
 *
 * The point of this fixture is that it uses nothing a Director view could not: `generatePoolSchedule`
 * for the morning, `deriveStandings` per pool for the lunch table, `previewDivisionPlacement` for the
 * divisions, and `planSingleEliminationBracket` / `resolveBracket` for the afternoon. If a step here
 * needed private knowledge, the product would too.
 */

import {
  generatePoolSchedule,
  type GeneratedSchedule,
  type ScheduleRoundDefinition,
} from '../src/scheduling';
import { deriveStandings, type StandingsReport } from '../src/statistics';
import {
  previewDivisionPlacement,
  type DivisionDefinition,
  type DivisionPlacementPreview,
  type PoolStandings,
} from '../src/divisions';
import {
  placeBracketRounds,
  planSingleEliminationBracket,
  resolveBracket,
  type BracketGameOutcome,
  type BracketPlan,
  type ResolvedBracket,
} from '../src/brackets';
import type { EntityId, GameResult, Pool, Room, ScheduledGame, ScheduledMatch, Team } from '../src/model';
import { makeTeamGameStat } from '../src/results';
import { fixedClock } from './helpers';

export const phaseId = 'phase-prelim';

export function seededTeams(count: number): Team[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `team-${String(index + 1).padStart(2, '0')}`,
    name: `Team ${index + 1}`,
    displayName: `Team ${index + 1}`,
    letter: null,
    organizationId: `org-${Math.floor(index / 2) + 1}`,
    seed: index + 1,
    status: 'active' as const,
    playerIds: [],
    notes: '',
    createdAt: fixedClock.now(),
    updatedAt: fixedClock.now(),
  }));
}

export function rooms(count: number): Room[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `room-${index + 1}`,
    name: `Room ${index + 1}`,
    building: null,
    floor: null,
    capacity: null,
    accessible: true,
    directions: '',
    active: true,
    availability: [],
    notes: '',
  }));
}

/** Snake the seeded field across `poolSizes.length` pools, largest pool first. */
export function snakePools(teams: readonly Team[], poolSizes: readonly number[]): Pool[] {
  const pools: Pool[] = poolSizes.map((_, index) => ({
    id: `pool-${String.fromCharCode(65 + index)}`,
    phaseId,
    name: `Pool ${String.fromCharCode(65 + index)}`,
    order: index + 1,
    teamIds: [],
    sourcePoolIds: [],
  }));
  const capacity = [...poolSizes];
  const assigned: EntityId[][] = pools.map(() => []);
  const ordered = [...teams].sort((left, right) => (left.seed ?? 0) - (right.seed ?? 0));
  let index = 0;
  let row = 0;
  while (index < ordered.length) {
    const order =
      row % 2 === 0 ? pools.map((_, slot) => slot) : pools.map((_, slot) => pools.length - 1 - slot);
    for (const slot of order) {
      if (index >= ordered.length) break;
      if (assigned[slot].length >= capacity[slot]) continue;
      assigned[slot].push(ordered[index].id);
      index += 1;
    }
    row += 1;
  }
  return pools.map((pool, slot) => ({ ...pool, teamIds: assigned[slot] }));
}

export function prelimRoundDefinitions(count: number): ScheduleRoundDefinition[] {
  // One round entity per tournament round number, shared by every pool, so all pools play their
  // round 3 at the same time and a printed schedule reads 1…5 rather than per-pool numbering.
  return Array.from({ length: count }, (_, index) => ({
    id: `round-${index + 1}`,
    number: index + 1,
    poolId: null,
  }));
}

export function generatePrelims(
  teams: readonly Team[],
  pools: readonly Pool[],
  roundCount: number,
  roomCount: number,
): GeneratedSchedule {
  return generatePoolSchedule({
    phaseId,
    pools,
    teams,
    rooms: rooms(roomCount),
    rounds: prelimRoundDefinitions(roundCount),
    seed: 'fixture',
    rematchPolicy: 'forbid',
  });
}

/**
 * Score every scheduled game so the better seed wins by a margin nobody else matches.
 *
 * Deterministic and, importantly, tie-free: the fixture is testing placement and bracket mechanics,
 * so it must not accidentally test the tiebreak path as well.
 */
export function playAll(games: readonly ScheduledGame[]): GameResult[] {
  return games
    .filter((game): game is ScheduledMatch => game.kind !== 'bye')
    .map((game) => {
      const seedOf = (teamId: EntityId) => Number(teamId.replace('team-', ''));
      const better = seedOf(game.teamAId) < seedOf(game.teamBId) ? game.teamAId : game.teamBId;
      const worse = better === game.teamAId ? game.teamBId : game.teamAId;
      const winnerScore = 400 - seedOf(better) * 7;
      const loserScore = 100 + seedOf(worse);
      const teamScores = [
        makeTeamGameStat({
          teamId: game.teamAId,
          score: game.teamAId === better ? winnerScore : loserScore,
          tossupsHeard: 20,
          gets: 6,
          bonusesHeard: 6,
          bonusPoints: 60,
        }),
        makeTeamGameStat({
          teamId: game.teamBId,
          score: game.teamBId === better ? winnerScore : loserScore,
          tossupsHeard: 20,
          gets: 4,
          bonusesHeard: 4,
          bonusPoints: 40,
        }),
      ];
      return {
        id: `result-${game.id}`,
        scheduledGameId: game.id,
        phaseId: game.phaseId,
        roundId: game.roundId,
        roomId: game.roomId,
        packetId: game.packetId,
        outcome: 'played' as const,
        teamScores,
        playerStats: [],
        notes: '',
        fingerprint: `fp-${game.id}`,
        source: 'manual' as const,
        receivedAt: fixedClock.now(),
        acceptedAt: fixedClock.now(),
        acceptedBy: 'director',
        reviewStatus: 'accepted' as const,
        revision: 1,
        originalSubmissionId: null,
        supersedesResultId: null,
      };
    });
}

export function poolStandings(
  teams: readonly Team[],
  pools: readonly Pool[],
  games: readonly ScheduledGame[],
  results: readonly GameResult[],
): PoolStandings[] {
  return pools.map((pool) => ({
    poolId: pool.id,
    poolName: pool.name,
    rows: standingsFor(teams, pool, games, results).rows,
  }));
}

export function standingsFor(
  teams: readonly Team[],
  pool: Pool,
  games: readonly ScheduledGame[],
  results: readonly GameResult[],
): StandingsReport {
  return deriveStandings({
    teams: teams.filter((team) => pool.teamIds.includes(team.id)),
    scheduledGames: games,
    acceptedResults: results,
    phaseId,
    poolId: pool.id,
  });
}

export const threeDivisions: DivisionDefinition[] = [
  { id: 'championship', name: 'Championship', order: 1, placements: [1, 2] },
  { id: 'division-2', name: 'Division II', order: 2, placements: [3, 4] },
  { id: 'division-3', name: 'Division III', order: 3, remainder: true },
];

export interface DivisionBracket {
  readonly id: EntityId;
  readonly name: string;
  readonly plan: BracketPlan;
  readonly seeding: readonly { readonly seed: number; readonly teamId: EntityId }[];
  readonly roundNumbers: readonly number[];
  readonly unusedRoundNumbers: readonly number[];
}

export function drawBrackets(
  placement: DivisionPlacementPreview,
  playoffRoundNumbers: readonly number[],
): DivisionBracket[] {
  return placement.divisions.map((division) => {
    const plan = planSingleEliminationBracket(division.members.length);
    const placed = placeBracketRounds(plan.roundCount, playoffRoundNumbers, 'championship-last');
    return {
      id: division.id,
      name: division.name,
      plan,
      seeding: division.members.map((member) => ({ seed: member.seed, teamId: member.teamId })),
      roundNumbers: placed.placements.map((entry) => entry.roundNumber),
      unusedRoundNumbers: placed.unusedRoundNumbers,
    };
  });
}

/**
 * Play a bracket one round at a time, resolving dependencies between rounds.
 *
 * Each pass only plays games whose participants are already known, which is what a real afternoon
 * does: round 7 cannot be scored until round 6 is accepted.
 */
export function playBracket(
  division: DivisionBracket,
  winnerOf: (teamAId: EntityId, teamBId: EntityId) => EntityId,
): { readonly bracket: ResolvedBracket; readonly perRound: readonly ResolvedBracket[] } {
  const outcomes: BracketGameOutcome[] = [];
  const roundPlacements = division.roundNumbers.map((roundNumber, roundIndex) => ({
    roundIndex,
    roundNumber,
  }));
  const perRound: ResolvedBracket[] = [];
  for (let roundIndex = 0; roundIndex < division.plan.roundCount; roundIndex += 1) {
    const resolved = resolveBracket({
      plan: division.plan,
      seeding: division.seeding,
      outcomes,
      roundPlacements,
    });
    perRound.push(resolved);
    for (const game of resolved.games) {
      if (game.roundIndex !== roundIndex || !game.ready || game.winnerTeamId) continue;
      const teamAId = game.slotA.teamId as EntityId;
      const teamBId = game.slotB.teamId as EntityId;
      const winnerTeamId = winnerOf(teamAId, teamBId);
      outcomes.push({
        gameKey: game.key,
        winnerTeamId,
        loserTeamId: winnerTeamId === teamAId ? teamBId : teamAId,
      });
    }
  }
  return {
    bracket: resolveBracket({
      plan: division.plan,
      seeding: division.seeding,
      outcomes,
      roundPlacements,
    }),
    perRound,
  };
}

/** The better preliminary seed wins, which makes every afternoon outcome predictable. */
export const betterSeedWins = (teamAId: EntityId, teamBId: EntityId): EntityId =>
  Number(teamAId.replace('team-', '')) < Number(teamBId.replace('team-', '')) ? teamAId : teamBId;

export interface TournamentDay {
  readonly teams: readonly Team[];
  readonly pools: readonly Pool[];
  readonly schedule: GeneratedSchedule;
  readonly results: readonly GameResult[];
  readonly poolStandings: readonly PoolStandings[];
  readonly placement: DivisionPlacementPreview;
  readonly brackets: readonly DivisionBracket[];
}

export function runMorning(teamCount: number, poolSizes: readonly number[], roomCount = 9): TournamentDay {
  const teams = seededTeams(teamCount);
  const pools = snakePools(teams, poolSizes);
  const schedule = generatePrelims(teams, pools, 5, roomCount);
  const results = playAll(schedule.games);
  const standings = poolStandings(teams, pools, schedule.games, results);
  const placement = previewDivisionPlacement({
    method: 'pool-placement',
    divisions: threeDivisions,
    poolStandings: standings,
    rankingBasis: 'win-percentage',
  });
  return {
    teams,
    pools,
    schedule,
    results,
    poolStandings: standings,
    placement,
    brackets: drawBrackets(placement, [6, 7, 8]),
  };
}
