import type {
  EntityId,
  GameResult,
  Player,
  ScheduledGame,
  ScheduledMatch,
  Team,
  Tiebreaker,
  TournamentRules,
} from './model';
import { ruleTiebreakers } from './model';

export interface StatisticsInput {
  readonly teams: readonly Team[];
  readonly players?: readonly Player[];
  readonly scheduledGames: readonly ScheduledGame[];
  readonly acceptedResults: readonly GameResult[];
  readonly phaseId?: EntityId;
  readonly poolId?: EntityId | null;
  readonly tiebreakers?: readonly Tiebreaker[];
  readonly scoring?: Pick<TournamentRules, 'tossupPoints' | 'powerPoints' | 'negPoints'>;
}

export interface TeamStatistics {
  readonly teamId: EntityId;
  readonly poolId: EntityId | null;
  readonly gamesPlayed: number;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly winPercentage: number;
  readonly pointsFor: number;
  readonly pointsAgainst: number;
  readonly pointsPerGame: number;
  readonly pointsAgainstPerGame: number;
  readonly margin: number;
  readonly powers: number;
  readonly gets: number;
  readonly negs: number;
  readonly tossupsHeard: number;
  readonly pointsPerTossupHeard: number;
  readonly bonusPoints: number;
  readonly bonusesHeard: number;
  readonly pointsPerBonus: number;
  readonly bouncebacks: number;
  readonly lightningPoints: number;
  readonly overtimePoints: number;
  readonly seed: number | null;
}

export interface PlayerStatistics {
  readonly playerId: EntityId;
  readonly teamId: EntityId;
  readonly gamesPlayed: number;
  readonly tossupsHeard: number;
  readonly powers: number;
  readonly gets: number;
  readonly negs: number;
  readonly tossupPoints: number;
  readonly points: number;
  readonly bonusesHeard: number;
  readonly bonusPoints: number;
  readonly pointsPerTossupHeard: number;
  readonly pointsPerBonus: number;
  readonly bouncebacks: number;
}

export interface TeamStandingRow extends TeamStatistics {
  readonly rank: number;
  readonly tieStatus: 'clear' | 'unresolved';
}

export interface UnresolvedTie {
  readonly teamIds: readonly EntityId[];
  readonly poolId: EntityId | null;
  readonly reason: string;
}

export interface StandingsReport {
  readonly rows: readonly TeamStandingRow[];
  readonly playerRows: readonly PlayerStatistics[];
  readonly unresolvedTies: readonly UnresolvedTie[];
  readonly includedResultIds: readonly EntityId[];
  readonly ignoredResultIds: readonly EntityId[];
}

interface TeamAccumulator {
  readonly teamId: EntityId;
  readonly poolId: EntityId | null;
  gamesPlayed: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  powers: number;
  gets: number;
  negs: number;
  tossupsHeard: number;
  bonusPoints: number;
  bonusesHeard: number;
  bouncebacks: number;
  lightningPoints: number;
  overtimePoints: number;
}

interface PlayerAccumulator {
  readonly playerId: EntityId;
  readonly teamId: EntityId;
  gamesPlayed: number;
  tossupsHeard: number;
  powers: number;
  gets: number;
  negs: number;
  bonusesHeard: number;
  bonusPoints: number;
  bouncebacks: number;
  points: number;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function toTeamStatistics(accumulator: TeamAccumulator, seed: number | null): TeamStatistics {
  return {
    teamId: accumulator.teamId,
    poolId: accumulator.poolId,
    gamesPlayed: accumulator.gamesPlayed,
    wins: accumulator.wins,
    losses: accumulator.losses,
    ties: accumulator.ties,
    winPercentage: ratio(accumulator.wins + accumulator.ties * 0.5, accumulator.gamesPlayed),
    pointsFor: accumulator.pointsFor,
    pointsAgainst: accumulator.pointsAgainst,
    pointsPerGame: ratio(accumulator.pointsFor, accumulator.gamesPlayed),
    pointsAgainstPerGame: ratio(accumulator.pointsAgainst, accumulator.gamesPlayed),
    margin: accumulator.pointsFor - accumulator.pointsAgainst,
    powers: accumulator.powers,
    gets: accumulator.gets,
    negs: accumulator.negs,
    tossupsHeard: accumulator.tossupsHeard,
    pointsPerTossupHeard: ratio(accumulator.pointsFor, accumulator.tossupsHeard),
    bonusPoints: accumulator.bonusPoints,
    bonusesHeard: accumulator.bonusesHeard,
    pointsPerBonus: ratio(accumulator.bonusPoints, accumulator.bonusesHeard),
    bouncebacks: accumulator.bouncebacks,
    lightningPoints: accumulator.lightningPoints,
    overtimePoints: accumulator.overtimePoints,
    seed,
  };
}

function toPlayerStatistics(
  accumulator: PlayerAccumulator,
  scoring: Pick<TournamentRules, 'tossupPoints' | 'powerPoints' | 'negPoints'>,
): PlayerStatistics {
  const tossupPoints =
    accumulator.powers * scoring.powerPoints +
    accumulator.gets * scoring.tossupPoints +
    accumulator.negs * scoring.negPoints;
  return {
    playerId: accumulator.playerId,
    teamId: accumulator.teamId,
    gamesPlayed: accumulator.gamesPlayed,
    tossupsHeard: accumulator.tossupsHeard,
    powers: accumulator.powers,
    gets: accumulator.gets,
    negs: accumulator.negs,
    tossupPoints,
    points: accumulator.points,
    bonusesHeard: accumulator.bonusesHeard,
    bonusPoints: accumulator.bonusPoints,
    pointsPerTossupHeard: ratio(accumulator.points, accumulator.tossupsHeard),
    pointsPerBonus: ratio(accumulator.bonusPoints, accumulator.bonusesHeard),
    bouncebacks: accumulator.bouncebacks,
  };
}

function acceptedResultForGame(results: readonly GameResult[]): Map<EntityId, GameResult> {
  const selected = new Map<EntityId, GameResult>();
  for (const result of results) {
    if (result.reviewStatus !== 'accepted') continue;
    const previous = selected.get(result.scheduledGameId);
    if (
      !previous ||
      result.revision > previous.revision ||
      (result.acceptedAt ?? '') > (previous.acceptedAt ?? '')
    ) {
      selected.set(result.scheduledGameId, result);
    }
  }
  return selected;
}

function resultForMatch(result: GameResult, match: ScheduledMatch): boolean {
  return (
    result.scheduledGameId === match.id &&
    result.phaseId === match.phaseId &&
    result.roundId === match.roundId
  );
}

function headToHeadValue(
  teamId: EntityId,
  group: readonly TeamStatistics[],
  resultByGame: ReadonlyMap<EntityId, GameResult>,
  gamesById: ReadonlyMap<EntityId, ScheduledGame>,
): number {
  const groupIds = new Set(group.map((row) => row.teamId));
  let value = 0;
  for (const [gameId, result] of resultByGame) {
    const game = gamesById.get(gameId);
    if (!game || game.kind === 'bye' || !groupIds.has(game.teamAId) || !groupIds.has(game.teamBId)) continue;
    const own = result.teamScores.find((score) => score.teamId === teamId);
    const opponent = result.teamScores.find((score) => score.teamId !== teamId && groupIds.has(score.teamId));
    if (!own || !opponent) continue;
    value += own.score > opponent.score ? 2 : own.score === opponent.score ? 1 : 0;
  }
  return value;
}

function comparisonValue(
  row: TeamStatistics,
  tiebreaker: Tiebreaker,
  group: readonly TeamStatistics[],
  resultByGame: ReadonlyMap<EntityId, GameResult>,
  gamesById: ReadonlyMap<EntityId, ScheduledGame>,
): number {
  switch (tiebreaker) {
    case 'wins':
      return row.wins;
    case 'head-to-head':
      return headToHeadValue(row.teamId, group, resultByGame, gamesById);
    case 'point-differential':
      return row.margin;
    case 'points-for':
      return row.pointsFor;
    case 'powers':
      return row.powers;
    case 'gets':
      return row.gets;
    case 'negs':
      return -row.negs;
    case 'bonus-points':
      return row.bonusPoints;
    case 'ppg':
      return row.pointsPerGame;
    case 'seed':
      return row.seed === null ? Number.NEGATIVE_INFINITY : -row.seed;
  }
}

function sameComparisonValue(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

interface RankedGroups {
  readonly groups: readonly (readonly TeamStatistics[])[];
  readonly unresolvedTies: readonly (readonly TeamStatistics[])[];
}

function rankGroups(
  rows: readonly TeamStatistics[],
  tiebreakers: readonly Tiebreaker[],
  index: number,
  resultByGame: ReadonlyMap<EntityId, GameResult>,
  gamesById: ReadonlyMap<EntityId, ScheduledGame>,
): RankedGroups {
  if (rows.length <= 1) return { groups: rows.length === 0 ? [] : [rows], unresolvedTies: [] };
  if (index >= tiebreakers.length) return { groups: [rows], unresolvedTies: [rows] };
  const tiebreaker = tiebreakers[index];
  const sorted = [...rows].sort(
    (left, right) =>
      comparisonValue(right, tiebreaker, rows, resultByGame, gamesById) -
        comparisonValue(left, tiebreaker, rows, resultByGame, gamesById) ||
      left.teamId.localeCompare(right.teamId),
  );
  const partitions: TeamStatistics[][] = [];
  for (const row of sorted) {
    const previous = partitions.at(-1);
    if (
      previous &&
      sameComparisonValue(
        comparisonValue(previous[0], tiebreaker, rows, resultByGame, gamesById),
        comparisonValue(row, tiebreaker, rows, resultByGame, gamesById),
      )
    ) {
      previous.push(row);
    } else {
      partitions.push([row]);
    }
  }
  if (partitions.length === 1) return rankGroups(rows, tiebreakers, index + 1, resultByGame, gamesById);
  const groups: TeamStatistics[][] = [];
  const unresolvedTies: TeamStatistics[][] = [];
  for (const partition of partitions) {
    const ranked = rankGroups(partition, tiebreakers, index + 1, resultByGame, gamesById);
    groups.push(...ranked.groups.map((group) => [...group]));
    unresolvedTies.push(...ranked.unresolvedTies.map((group) => [...group]));
  }
  return { groups, unresolvedTies };
}

/**
 * Derive standings and player statistics only from accepted, non-cancelled results.
 *
 * If an accepted game has more than one accepted revision, the latest revision wins and older
 * revisions are reported as ignored rather than being counted twice.
 */
export function deriveStandings(input: StatisticsInput): StandingsReport {
  const teamById = new Map(input.teams.map((team) => [team.id, team]));
  const games = input.scheduledGames.filter(
    (game): game is ScheduledMatch =>
      game.kind !== 'bye' &&
      (input.phaseId === undefined || game.phaseId === input.phaseId) &&
      (input.poolId === undefined || game.poolId === input.poolId),
  );
  const gamesById = new Map<EntityId, ScheduledGame>(games.map((game) => [game.id, game]));
  const selectedResults = acceptedResultForGame(input.acceptedResults);
  const includedResultIds: EntityId[] = [];
  const ignoredResultIds: EntityId[] = [];
  const selectedResultIds = new Set<EntityId>();
  const accumulators = new Map<EntityId, TeamAccumulator>();
  const includedTeamIds = new Set(games.flatMap((game) => [game.teamAId, game.teamBId]));
  const selectedTeams = input.teams.filter(
    (team) => input.poolId === undefined || includedTeamIds.has(team.id),
  );
  for (const team of selectedTeams) {
    accumulators.set(team.id, {
      teamId: team.id,
      poolId: input.poolId ?? null,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      powers: 0,
      gets: 0,
      negs: 0,
      tossupsHeard: 0,
      bonusPoints: 0,
      bonusesHeard: 0,
      bouncebacks: 0,
      lightningPoints: 0,
      overtimePoints: 0,
    });
  }
  const acceptedByGame = new Map<EntityId, GameResult>();
  for (const game of games) {
    const result = selectedResults.get(game.id);
    if (
      !result ||
      !resultForMatch(result, game) ||
      result.outcome === 'cancelled' ||
      result.outcome === 'partial'
    )
      continue;
    const first = result.teamScores.find((score) => score.teamId === game.teamAId);
    const second = result.teamScores.find((score) => score.teamId === game.teamBId);
    if (!first || !second) {
      ignoredResultIds.push(result.id);
      continue;
    }
    const firstAccumulator = accumulators.get(first.teamId);
    const secondAccumulator = accumulators.get(second.teamId);
    if (!firstAccumulator || !secondAccumulator) {
      ignoredResultIds.push(result.id);
      continue;
    }
    acceptedByGame.set(game.id, result);
    includedResultIds.push(result.id);
    selectedResultIds.add(result.id);
    firstAccumulator.gamesPlayed += 1;
    secondAccumulator.gamesPlayed += 1;
    firstAccumulator.pointsFor += first.score;
    firstAccumulator.pointsAgainst += second.score;
    secondAccumulator.pointsFor += second.score;
    secondAccumulator.pointsAgainst += first.score;
    for (const [accumulator, score] of [
      [firstAccumulator, first],
      [secondAccumulator, second],
    ] as const) {
      accumulator.powers += score.powers;
      accumulator.gets += score.gets;
      accumulator.negs += score.negs;
      accumulator.tossupsHeard += score.tossupsHeard;
      accumulator.bonusPoints += score.bonusPoints;
      accumulator.bonusesHeard += score.bonusesHeard;
      accumulator.bouncebacks += score.bouncebacks;
      accumulator.lightningPoints += score.lightningPoints;
      accumulator.overtimePoints += score.overtimePoints;
    }
    if (first.score > second.score) {
      firstAccumulator.wins += 1;
      secondAccumulator.losses += 1;
    } else if (second.score > first.score) {
      secondAccumulator.wins += 1;
      firstAccumulator.losses += 1;
    } else {
      firstAccumulator.ties += 1;
      secondAccumulator.ties += 1;
    }
  }
  for (const result of input.acceptedResults) {
    if (!selectedResultIds.has(result.id)) ignoredResultIds.push(result.id);
  }

  const teamRows = [...accumulators.values()].map((accumulator) =>
    toTeamStatistics(accumulator, teamById.get(accumulator.teamId)?.seed ?? null),
  );
  const tiebreakers = input.tiebreakers ?? [
    'wins',
    'head-to-head',
    'point-differential',
    'points-for',
    'seed',
  ];
  const ranked = rankGroups(teamRows, tiebreakers, 0, acceptedByGame, gamesById);
  const unresolvedTies: UnresolvedTie[] = ranked.unresolvedTies.map((group) => ({
    teamIds: group.map((row) => row.teamId),
    poolId: input.poolId ?? null,
    reason: 'The configured tiebreakers did not separate these teams.',
  }));
  const rows: TeamStandingRow[] = [];
  let offset = 0;
  for (const group of ranked.groups) {
    const unresolved = ranked.unresolvedTies.some(
      (tie) => tie.length > 1 && tie.every((row) => group.some((member) => member.teamId === row.teamId)),
    );
    const rank = offset + 1;
    for (const row of group) rows.push({ ...row, rank, tieStatus: unresolved ? 'unresolved' : 'clear' });
    offset += group.length;
  }

  const playerAccumulators = new Map<EntityId, PlayerAccumulator>();
  for (const player of input.players ?? []) {
    if (!accumulators.has(player.teamId ?? '')) continue;
    playerAccumulators.set(player.id, {
      playerId: player.id,
      teamId: player.teamId as EntityId,
      gamesPlayed: 0,
      tossupsHeard: 0,
      powers: 0,
      gets: 0,
      negs: 0,
      bonusesHeard: 0,
      bonusPoints: 0,
      bouncebacks: 0,
      points: 0,
    });
  }
  for (const result of acceptedByGame.values()) {
    for (const stat of result.playerStats) {
      const player = input.players?.find((candidate) => candidate.id === stat.playerId);
      if (player && !accumulators.has(player.teamId ?? '')) continue;
      const accumulator = playerAccumulators.get(stat.playerId) ?? {
        playerId: stat.playerId,
        teamId: stat.teamId,
        gamesPlayed: 0,
        tossupsHeard: 0,
        powers: 0,
        gets: 0,
        negs: 0,
        bonusesHeard: 0,
        bonusPoints: 0,
        bouncebacks: 0,
        points: 0,
      };
      accumulator.gamesPlayed += 1;
      accumulator.tossupsHeard += stat.tossupsHeard;
      accumulator.powers += stat.powers;
      accumulator.gets += stat.gets;
      accumulator.negs += stat.negs;
      accumulator.bonusesHeard += stat.bonusesHeard;
      accumulator.bonusPoints += stat.bonusPoints;
      accumulator.bouncebacks += stat.bouncebacks;
      accumulator.points += stat.points;
      playerAccumulators.set(stat.playerId, accumulator);
    }
  }
  const playerRows = [...playerAccumulators.values()]
    .map((accumulator) =>
      toPlayerStatistics(accumulator, input.scoring ?? { tossupPoints: 10, powerPoints: 15, negPoints: -5 }),
    )
    .sort((left, right) => right.points - left.points || left.playerId.localeCompare(right.playerId));
  return { rows, playerRows, unresolvedTies, includedResultIds, ignoredResultIds };
}

/** Convenience helper for hosts that already have a snapshot-like object. */
export function deriveSnapshotStandings(
  snapshot: {
    readonly teams: readonly Team[];
    readonly players: readonly Player[];
    readonly scheduledGames: readonly ScheduledGame[];
    readonly results: readonly GameResult[];
    readonly rules: Pick<TournamentRules, 'tiebreakers' | 'tossupPoints' | 'powerPoints' | 'negPoints'>;
  },
  filter: { readonly phaseId?: EntityId; readonly poolId?: EntityId | null } = {},
): StandingsReport {
  return deriveStandings({
    teams: snapshot.teams,
    players: snapshot.players,
    scheduledGames: snapshot.scheduledGames,
    acceptedResults: snapshot.results,
    phaseId: filter.phaseId,
    poolId: filter.poolId,
    tiebreakers: snapshot.rules.tiebreakers,
    scoring: snapshot.rules,
  });
}

export function defaultTiebreakersForStatistics(rules: {
  readonly tiebreakers: readonly Tiebreaker[];
}): readonly Tiebreaker[] {
  return ruleTiebreakers(rules as Parameters<typeof ruleTiebreakers>[0]);
}
