import type {
  EntityId,
  Pool,
  RematchPolicy,
  Room,
  ScheduledBye,
  ScheduledGame,
  ScheduledMatch,
  Team,
} from './model';

export type ScheduleIssueSeverity = 'error' | 'warning' | 'recommendation';

export interface ScheduleIssue {
  readonly code: string;
  readonly severity: ScheduleIssueSeverity;
  readonly message: string;
  readonly roundId: EntityId | null;
  readonly gameIds: readonly EntityId[];
  readonly teamIds: readonly EntityId[];
}

export interface ScheduleRoundDefinition {
  readonly id: EntityId;
  readonly number?: number;
  readonly poolId?: EntityId | null;
}

export interface ScheduleIdFactory {
  readonly game?: (input: {
    readonly phaseId: EntityId;
    readonly poolId: EntityId | null;
    readonly roundIndex: number;
    readonly sequence: number;
    readonly kind: 'game' | 'bye';
  }) => EntityId;
}

export interface RoundRobinScheduleOptions {
  readonly phaseId: EntityId;
  readonly poolId?: EntityId | null;
  readonly teams: readonly Team[];
  readonly rooms?: readonly Room[];
  readonly roomIds?: readonly EntityId[];
  readonly packetIds?: readonly EntityId[];
  readonly rounds?: readonly ScheduleRoundDefinition[];
  readonly roundCount?: number;
  readonly repetitions?: number;
  readonly seed?: string | number;
  readonly rematchPolicy?: RematchPolicy;
  readonly avoidSameOrganization?: boolean;
  readonly requireRoomAssignments?: boolean;
  readonly idFactory?: ScheduleIdFactory;
}

export interface PoolScheduleOptions extends Omit<RoundRobinScheduleOptions, 'poolId' | 'teams' | 'rounds'> {
  readonly pools: readonly Pool[];
  readonly teams: readonly Team[];
  readonly rounds?: readonly ScheduleRoundDefinition[];
  readonly roundDefinitionsByPool?: Readonly<Record<EntityId, readonly ScheduleRoundDefinition[]>>;
}

export interface GeneratedSchedule {
  readonly games: readonly ScheduledGame[];
  readonly issues: readonly ScheduleIssue[];
  readonly expectedGamesPerTeam: number | null;
  readonly roundCount: number;
}

interface Pairing {
  readonly teamAId: EntityId | null;
  readonly teamBId: EntityId | null;
}

interface PairingRound {
  readonly pairings: readonly Pairing[];
}

interface PlannedRound {
  readonly phaseId: EntityId;
  readonly roundIndex: number;
  readonly roundDefinition: ScheduleRoundDefinition;
  readonly poolId: EntityId | null;
  readonly pairings: readonly Pairing[];
}

function hashSeed(value: string | number): number {
  const text = String(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nextSeed(value: number): number {
  let state = value >>> 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

function deterministicShuffle(values: readonly EntityId[], seed: string | number): EntityId[] {
  const shuffled = [...values];
  let state = hashSeed(seed) || 1;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = nextSeed(state);
    const swapIndex = state % (index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function teamOrder(teams: readonly Team[]): EntityId[] {
  return [...teams]
    .sort((left, right) => {
      const leftSeed = left.seed ?? Number.POSITIVE_INFINITY;
      const rightSeed = right.seed ?? Number.POSITIVE_INFINITY;
      return (
        leftSeed - rightSeed ||
        left.displayName.localeCompare(right.displayName) ||
        left.id.localeCompare(right.id)
      );
    })
    .map((team) => team.id);
}

function pairingRounds(teamIds: readonly EntityId[], seed: string | number): PairingRound[] {
  if (teamIds.length < 2) return [];
  const participants = deterministicShuffle(teamIds, seed);
  if (participants.length % 2 === 1) participants.push('' as EntityId);
  const fixed = participants[0];
  let rotating = participants.slice(1);
  const rounds: PairingRound[] = [];
  for (let round = 0; round < participants.length - 1; round += 1) {
    const current = [fixed, ...rotating];
    const pairs: Pairing[] = [];
    for (let pairIndex = 0; pairIndex < participants.length / 2; pairIndex += 1) {
      const left = current[pairIndex] || null;
      const right = current[participants.length - 1 - pairIndex] || null;
      pairs.push({ teamAId: left, teamBId: right });
    }
    rounds.push({ pairings: pairs });
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, -1)];
  }
  return rounds;
}

function pairKey(teamAId: EntityId, teamBId: EntityId): string {
  return [teamAId, teamBId].sort().join('\u0000');
}

function defaultRoundDefinition(
  phaseId: EntityId,
  poolId: EntityId | null,
  index: number,
): ScheduleRoundDefinition {
  const poolPart = poolId ? `-${poolId}` : '';
  return { id: `${phaseId}${poolPart}-round-${index + 1}`, number: index + 1, poolId };
}

function roundDefinitionAt(
  definitions: readonly ScheduleRoundDefinition[] | undefined,
  phaseId: EntityId,
  poolId: EntityId | null,
  index: number,
): ScheduleRoundDefinition {
  return definitions?.[index] ?? defaultRoundDefinition(phaseId, poolId, index);
}

function issue(
  code: string,
  severity: ScheduleIssueSeverity,
  message: string,
  roundId: EntityId | null = null,
  gameIds: readonly EntityId[] = [],
  teamIds: readonly EntityId[] = [],
): ScheduleIssue {
  return { code, severity, message, roundId, gameIds, teamIds };
}

function cyclePlans(
  teamIds: readonly EntityId[],
  repetitions: number,
  seed: string | number,
  rematchPolicy: RematchPolicy,
): PairingRound[] {
  const plans: PairingRound[] = [];
  let previousLastRound: PairingRound | null = null;
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    let best = pairingRounds(teamIds, `${seed}:repeat:${repetition}:0`);
    if (rematchPolicy === 'avoid-when-possible' && previousLastRound && best.length > 0) {
      let bestAdjacentRematches = Number.POSITIVE_INFINITY;
      for (let variant = 0; variant < Math.max(4, teamIds.length); variant += 1) {
        const candidate = pairingRounds(teamIds, `${seed}:repeat:${repetition}:${variant}`);
        const first = candidate[0];
        const previousPairs = new Set(
          previousLastRound.pairings
            .filter((pair) => pair.teamAId && pair.teamBId)
            .map((pair) => pairKey(pair.teamAId as EntityId, pair.teamBId as EntityId)),
        );
        const adjacent = first.pairings.filter(
          (pair) => pair.teamAId && pair.teamBId && previousPairs.has(pairKey(pair.teamAId, pair.teamBId)),
        ).length;
        if (adjacent < bestAdjacentRematches) {
          bestAdjacentRematches = adjacent;
          best = candidate;
          if (adjacent === 0) break;
        }
      }
    }
    plans.push(...best);
    previousLastRound = best.at(-1) ?? null;
  }
  return plans;
}

function activeRoomIds(options: Pick<RoundRobinScheduleOptions, 'rooms' | 'roomIds'>): EntityId[] {
  if (options.roomIds) return [...options.roomIds];
  return options.rooms?.filter((room) => room.active).map((room) => room.id) ?? [];
}

function makeGameId(
  factory: ScheduleIdFactory | undefined,
  phaseId: EntityId,
  poolId: EntityId | null,
  roundIndex: number,
  sequence: number,
  kind: 'game' | 'bye',
): EntityId {
  return (
    factory?.game?.({ phaseId, poolId, roundIndex, sequence, kind }) ??
    `${phaseId}${poolId ? `-${poolId}` : ''}-r${roundIndex + 1}-g${sequence + 1}-${kind}`
  );
}

function assignResources(
  plannedRounds: readonly PlannedRound[],
  options: Pick<
    RoundRobinScheduleOptions,
    'rooms' | 'roomIds' | 'packetIds' | 'requireRoomAssignments' | 'idFactory'
  >,
): { games: ScheduledGame[]; issues: ScheduleIssue[] } {
  const roomIds = activeRoomIds(options);
  const packetIds = [...(options.packetIds ?? [])];
  const games: ScheduledGame[] = [];
  const issues: ScheduleIssue[] = [];
  let globalGameSequence = 0;
  const byRound = new Map<number, ScheduledGame[]>();
  const roomsByRound = new Map<number, Set<EntityId>>();

  for (const planned of plannedRounds) {
    const roundGames: ScheduledGame[] = [];
    const roundId = planned.roundDefinition.id;
    const roundRoomIds = roomsByRound.get(planned.roundIndex) ?? new Set<EntityId>();
    roomsByRound.set(planned.roundIndex, roundRoomIds);
    planned.pairings.forEach((pair, sequence) => {
      const id = makeGameId(
        options.idFactory,
        planned.phaseId,
        planned.poolId,
        planned.roundIndex,
        sequence,
        pair.teamAId && pair.teamBId ? 'game' : 'bye',
      );
      if (!pair.teamAId || !pair.teamBId) {
        const byeTeamId = pair.teamAId ?? pair.teamBId;
        if (!byeTeamId) return;
        const bye: ScheduledBye = {
          id,
          phaseId: planned.phaseId,
          roundId,
          poolId: planned.poolId,
          sequence,
          kind: 'bye',
          byeTeamId,
          status: 'scheduled',
          notes: 'Generated by the round-robin bye rotation.',
        };
        roundGames.push(bye);
        return;
      }

      let roomId: EntityId | null = null;
      if (roomIds.length > 0 && roundRoomIds.size < roomIds.length) {
        roomId = roomIds[roundRoomIds.size];
        roundRoomIds.add(roomId);
      }
      if (!roomId && options.requireRoomAssignments) {
        issues.push(
          issue(
            'room-capacity',
            'error',
            `Round “${roundId}” has more games than available rooms.`,
            roundId,
            [id],
            [pair.teamAId, pair.teamBId],
          ),
        );
      } else if (!roomId && roomIds.length === 0) {
        issues.push(
          issue(
            'room-unassigned',
            'warning',
            `Game “${id}” has no room assignment yet.`,
            roundId,
            [id],
            [pair.teamAId, pair.teamBId],
          ),
        );
      }

      const packetId = packetIds.length > 0 ? packetIds[globalGameSequence % packetIds.length] : null;
      if (!packetId && packetIds.length === 0) {
        issues.push(
          issue(
            'packet-unassigned',
            'recommendation',
            `Game “${id}” has no packet assignment yet.`,
            roundId,
            [id],
            [pair.teamAId, pair.teamBId],
          ),
        );
      }
      const match: ScheduledMatch = {
        id,
        phaseId: planned.phaseId,
        roundId,
        poolId: planned.poolId,
        sequence,
        kind: 'game',
        teamAId: pair.teamAId,
        teamBId: pair.teamBId,
        roomId,
        packetId,
        status: 'scheduled',
        notes: '',
      };
      roundGames.push(match);
      globalGameSequence += 1;
    });
    const allRoundGames = byRound.get(planned.roundIndex) ?? [];
    allRoundGames.push(...roundGames);
    byRound.set(planned.roundIndex, allRoundGames);
  }

  for (const roundGames of byRound.values()) {
    games.push(...roundGames);
  }
  return { games, issues };
}

function planRounds(
  phaseId: EntityId,
  poolId: EntityId | null,
  teamIds: readonly EntityId[],
  rounds: readonly ScheduleRoundDefinition[] | undefined,
  roundCount: number | undefined,
  repetitions: number,
  seed: string | number,
  rematchPolicy: RematchPolicy,
): PlannedRound[] {
  const fullCycleRounds = teamIds.length % 2 === 0 ? Math.max(0, teamIds.length - 1) : teamIds.length;
  const fullRoundCount = fullCycleRounds * repetitions;
  const requestedRoundCount = roundCount ?? rounds?.length ?? fullRoundCount;
  const count = Math.min(fullRoundCount, Math.max(0, requestedRoundCount));
  const plannedPairings = cyclePlans(teamIds, repetitions, seed, rematchPolicy).slice(0, count);
  return plannedPairings.map((pairing, index) => ({
    phaseId,
    roundIndex: index,
    roundDefinition: roundDefinitionAt(rounds, phaseId, poolId, index),
    poolId,
    pairings: pairing.pairings,
  }));
}

function duplicateTeamIds(teams: readonly Team[]): EntityId[] {
  const seen = new Set<EntityId>();
  const duplicates = new Set<EntityId>();
  for (const team of teams) {
    if (seen.has(team.id)) duplicates.add(team.id);
    seen.add(team.id);
  }
  return [...duplicates];
}

/** Generate a deterministic single-pool round-robin schedule. */
export function generateRoundRobinSchedule(options: RoundRobinScheduleOptions): GeneratedSchedule {
  const repetitions = options.repetitions ?? 1;
  const rematchPolicy = options.rematchPolicy ?? 'avoid-when-possible';
  const issues: ScheduleIssue[] = [];
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    return {
      games: [],
      issues: [issue('invalid-repetitions', 'error', 'Repetitions must be a positive integer.')],
      expectedGamesPerTeam: null,
      roundCount: 0,
    };
  }
  const duplicateIds = duplicateTeamIds(options.teams);
  if (duplicateIds.length > 0) {
    issues.push(
      issue(
        'duplicate-team-id',
        'error',
        'A schedule cannot contain the same team id twice.',
        null,
        [],
        duplicateIds,
      ),
    );
  }
  if (options.teams.length < 2) {
    issues.push(issue('too-few-teams', 'error', 'A schedule needs at least two teams.'));
  }
  if (rematchPolicy === 'forbid' && repetitions > 1 && options.teams.length > 1) {
    issues.push(
      issue(
        'rematches-required',
        'error',
        'Repeated round robin requires rematches, but rematchPolicy is forbid.',
      ),
    );
  }
  const ids = teamOrder(options.teams);
  const seed = options.seed ?? `${options.phaseId}:${options.poolId ?? 'main'}`;
  const planned = planRounds(
    options.phaseId,
    options.poolId ?? null,
    ids,
    options.rounds,
    options.roundCount,
    repetitions,
    seed,
    rematchPolicy,
  );
  const assigned = assignResources(planned, options);
  issues.push(...assigned.issues);
  const fullCycleRounds =
    options.teams.length % 2 === 0 ? Math.max(0, options.teams.length - 1) : options.teams.length;
  const fullRoundCount = fullCycleRounds * repetitions;
  const expectedGamesPerTeam =
    planned.length === fullRoundCount ? Math.max(0, options.teams.length - 1) * repetitions : null;
  const validation = validateSchedule(assigned.games, options.teams, {
    rooms: options.rooms,
    roomIds: options.roomIds,
    expectedGamesPerTeam: expectedGamesPerTeam ?? undefined,
    rematchPolicy,
    avoidSameOrganization: options.avoidSameOrganization,
    requireRoomAssignments: options.requireRoomAssignments,
    requireExplicitByes: options.teams.length % 2 === 1,
  });
  issues.push(...validation);
  return {
    games: assigned.games,
    issues,
    expectedGamesPerTeam,
    roundCount: planned.length,
  };
}

/** Generate synchronized round-robin schedules for several pools. */
export function generatePoolSchedule(options: PoolScheduleOptions): GeneratedSchedule {
  const issues: ScheduleIssue[] = [];
  const teamById = new Map(options.teams.map((team) => [team.id, team]));
  const planned: PlannedRound[] = [];
  const poolPlans = new Map<
    EntityId,
    {
      readonly teamIds: readonly EntityId[];
      readonly rounds: readonly PlannedRound[];
      readonly expectedGamesPerTeam: number | null;
    }
  >();
  let expectedGamesPerTeam: number | null = null;
  let maxRoundCount = 0;
  const rematchPolicy = options.rematchPolicy ?? 'avoid-when-possible';

  for (const pool of [...options.pools].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  )) {
    const poolTeams = pool.teamIds
      .map((teamId) => teamById.get(teamId))
      .filter((team): team is Team => Boolean(team));
    if (poolTeams.length !== pool.teamIds.length) {
      const missing = pool.teamIds.filter((teamId) => !teamById.has(teamId));
      issues.push(
        issue(
          'missing-pool-team',
          'error',
          `Pool “${pool.name}” references teams that are not available.`,
          null,
          [],
          missing,
        ),
      );
    }
    const poolRounds = options.roundDefinitionsByPool?.[pool.id] ?? options.rounds;
    const poolPlan = planRounds(
      options.phaseId,
      pool.id,
      teamOrder(poolTeams),
      poolRounds,
      poolRounds?.length ?? options.roundCount,
      options.repetitions ?? 1,
      options.seed ?? `${options.phaseId}:${pool.id}`,
      rematchPolicy,
    );
    maxRoundCount = Math.max(maxRoundCount, poolPlan.length);
    const fullCycleRounds = poolTeams.length % 2 === 0 ? Math.max(0, poolTeams.length - 1) : poolTeams.length;
    const fullRoundCount = fullCycleRounds * (options.repetitions ?? 1);
    const poolExpectedGamesPerTeam =
      poolPlan.length === fullRoundCount
        ? Math.max(0, poolTeams.length - 1) * (options.repetitions ?? 1)
        : null;
    if (expectedGamesPerTeam === null) expectedGamesPerTeam = poolExpectedGamesPerTeam;
    else if (expectedGamesPerTeam !== poolExpectedGamesPerTeam) expectedGamesPerTeam = null;
    poolPlans.set(pool.id, {
      teamIds: poolTeams.map((team) => team.id),
      rounds: poolPlan,
      expectedGamesPerTeam: poolExpectedGamesPerTeam,
    });
    planned.push(...poolPlan);
  }

  const assigned = assignResources(planned, options);
  issues.push(...assigned.issues);
  const validation = validateSchedule(assigned.games, options.teams, {
    rooms: options.rooms,
    roomIds: options.roomIds,
    rematchPolicy,
    avoidSameOrganization: options.avoidSameOrganization,
    requireRoomAssignments: options.requireRoomAssignments,
  });
  issues.push(...validation);
  for (const [poolId, plan] of poolPlans) {
    issues.push(
      ...validateSchedule(
        assigned.games.filter((game) => game.poolId === poolId),
        plan.teamIds.map((teamId) => teamById.get(teamId)).filter((team): team is Team => Boolean(team)),
        {
          rooms: options.rooms,
          roomIds: options.roomIds,
          expectedGamesPerTeam: plan.expectedGamesPerTeam ?? undefined,
          rematchPolicy,
          avoidSameOrganization: options.avoidSameOrganization,
          requireRoomAssignments: options.requireRoomAssignments,
          requireExplicitByes: plan.teamIds.length % 2 === 1,
        },
      ),
    );
  }
  return { games: assigned.games, issues, expectedGamesPerTeam, roundCount: maxRoundCount };
}

export interface ScheduleValidationOptions {
  readonly rooms?: readonly Room[];
  readonly roomIds?: readonly EntityId[];
  readonly expectedGamesPerTeam?: number;
  readonly rematchPolicy?: RematchPolicy;
  readonly avoidSameOrganization?: boolean;
  readonly requireRoomAssignments?: boolean;
  readonly requireExplicitByes?: boolean;
}

function hasSameOrganization(left: Team | undefined, right: Team | undefined): boolean {
  return Boolean(
    left?.organizationId && right?.organizationId && left.organizationId === right.organizationId,
  );
}

/** Validate an existing schedule without changing it or hiding unsatisfied constraints. */
export function validateSchedule(
  games: readonly ScheduledGame[],
  teams: readonly Team[],
  options: ScheduleValidationOptions = {},
): readonly ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const validRoomIds = new Set(
    options.roomIds ?? options.rooms?.filter((room) => room.active).map((room) => room.id) ?? [],
  );
  const byRound = new Map<EntityId, ScheduledGame[]>();
  const pairOccurrences = new Map<string, ScheduledMatch[]>();
  const gameIds = new Set<EntityId>();
  const teamGameCounts = new Map<EntityId, number>();
  const duplicateTeamIds = duplicateTeamIdsFromGames(games);

  if (new Set(teams.map((team) => team.id)).size !== teams.length) {
    issues.push(issue('duplicate-team-id', 'error', 'The team list contains duplicate ids.'));
  }
  if (new Set(games.map((game) => game.id)).size !== games.length) {
    issues.push(issue('duplicate-game-id', 'error', 'The schedule contains duplicate game ids.'));
  }

  for (const game of games) {
    if (gameIds.has(game.id)) continue;
    gameIds.add(game.id);
    const roundGames = byRound.get(game.roundId) ?? [];
    roundGames.push(game);
    byRound.set(game.roundId, roundGames);

    if (game.kind === 'bye') {
      if (!teamById.has(game.byeTeamId)) {
        issues.push(
          issue(
            'unknown-team',
            'error',
            `Bye “${game.id}” references an unknown team.`,
            game.roundId,
            [game.id],
            [game.byeTeamId],
          ),
        );
      }
      const count = teamGameCounts.get(game.byeTeamId) ?? 0;
      teamGameCounts.set(game.byeTeamId, count);
      continue;
    }

    if (!teamById.has(game.teamAId) || !teamById.has(game.teamBId)) {
      const unknown = [game.teamAId, game.teamBId].filter((teamId) => !teamById.has(teamId));
      issues.push(
        issue(
          'unknown-team',
          'error',
          `Game “${game.id}” references an unknown team.`,
          game.roundId,
          [game.id],
          unknown,
        ),
      );
    }
    if (game.teamAId === game.teamBId) {
      issues.push(
        issue(
          'self-match',
          'error',
          `Game “${game.id}” pairs a team against itself.`,
          game.roundId,
          [game.id],
          [game.teamAId],
        ),
      );
    }
    teamGameCounts.set(game.teamAId, (teamGameCounts.get(game.teamAId) ?? 0) + 1);
    teamGameCounts.set(game.teamBId, (teamGameCounts.get(game.teamBId) ?? 0) + 1);
    const key = pairKey(game.teamAId, game.teamBId);
    const occurrences = pairOccurrences.get(key) ?? [];
    occurrences.push(game);
    pairOccurrences.set(key, occurrences);
    if (options.requireRoomAssignments && !game.roomId) {
      issues.push(
        issue(
          'room-unassigned',
          'error',
          `Game “${game.id}” has no room assignment.`,
          game.roundId,
          [game.id],
          [game.teamAId, game.teamBId],
        ),
      );
    }
    if (game.roomId && validRoomIds.size > 0 && !validRoomIds.has(game.roomId)) {
      issues.push(
        issue(
          'unknown-room',
          'error',
          `Game “${game.id}” references an unknown or inactive room.`,
          game.roundId,
          [game.id],
          [game.teamAId, game.teamBId],
        ),
      );
    }
    if (
      options.avoidSameOrganization &&
      hasSameOrganization(teamById.get(game.teamAId), teamById.get(game.teamBId))
    ) {
      issues.push(
        issue(
          'same-organization-match',
          'warning',
          `Game “${game.id}” pairs teams from the same organization.`,
          game.roundId,
          [game.id],
          [game.teamAId, game.teamBId],
        ),
      );
    }
  }

  for (const [roundId, roundGames] of byRound) {
    const teamsInRound = new Map<EntityId, EntityId[]>();
    const roomsInRound = new Map<EntityId, EntityId[]>();
    const sequences = new Set<number>();
    for (const game of roundGames) {
      if (sequences.has(game.sequence)) {
        issues.push(
          issue(
            'duplicate-sequence',
            'error',
            `Round “${roundId}” uses sequence ${game.sequence} more than once.`,
            roundId,
            [game.id],
          ),
        );
      }
      sequences.add(game.sequence);
      const participants = game.kind === 'bye' ? [game.byeTeamId] : [game.teamAId, game.teamBId];
      for (const teamId of participants) {
        const previous = teamsInRound.get(teamId) ?? [];
        previous.push(game.id);
        teamsInRound.set(teamId, previous);
      }
      if (game.kind !== 'bye' && game.roomId) {
        const roomGames = roomsInRound.get(game.roomId) ?? [];
        roomGames.push(game.id);
        roomsInRound.set(game.roomId, roomGames);
      }
    }
    for (const [teamId, teamGameIds] of teamsInRound) {
      if (teamGameIds.length > 1) {
        issues.push(
          issue(
            'team-double-booked',
            'error',
            `Team “${teamId}” appears more than once in round “${roundId}”.`,
            roundId,
            teamGameIds,
            [teamId],
          ),
        );
      }
    }
    for (const [roomId, roomGameIds] of roomsInRound) {
      if (roomGameIds.length > 1) {
        issues.push(
          issue(
            'room-double-booked',
            'error',
            `Room “${roomId}” is assigned to more than one game in round “${roundId}”.`,
            roundId,
            roomGameIds,
          ),
        );
      }
    }
    if (options.requireExplicitByes && teams.length % 2 === 1) {
      for (const team of teams) {
        if (!teamsInRound.has(team.id)) {
          issues.push(
            issue(
              'missing-explicit-bye',
              'error',
              `Team “${team.displayName}” is absent from round “${roundId}” without an explicit bye.`,
              roundId,
              [],
              [team.id],
            ),
          );
        }
      }
    }
  }

  const rematchPolicy = options.rematchPolicy ?? 'allow';
  for (const [key, occurrences] of pairOccurrences) {
    if (occurrences.length <= 1) continue;
    const teamIds = key.split('\u0000');
    if (rematchPolicy === 'forbid') {
      issues.push(
        issue(
          'rematch-forbidden',
          'error',
          `Teams “${teamIds[0]}” and “${teamIds[1]}” meet more than once.`,
          null,
          occurrences.map((game) => game.id),
          teamIds,
        ),
      );
    } else if (rematchPolicy === 'avoid-when-possible') {
      const sorted = [...occurrences].sort(
        (left, right) => left.roundId.localeCompare(right.roundId) || left.sequence - right.sequence,
      );
      for (let index = 1; index < sorted.length; index += 1) {
        if (sorted[index - 1].roundId === sorted[index].roundId) {
          issues.push(
            issue(
              'same-round-rematch',
              'error',
              `Teams “${teamIds[0]}” and “${teamIds[1]}” are scheduled twice in one round.`,
              sorted[index].roundId,
              sorted.map((game) => game.id),
              teamIds,
            ),
          );
        }
      }
    }
  }

  if (options.expectedGamesPerTeam !== undefined) {
    for (const team of teams) {
      const actual = teamGameCounts.get(team.id) ?? 0;
      if (actual !== options.expectedGamesPerTeam) {
        issues.push(
          issue(
            'incorrect-game-count',
            'error',
            `Team “${team.displayName}” has ${actual} games; expected ${options.expectedGamesPerTeam}.`,
            null,
            [],
            [team.id],
          ),
        );
      }
    }
  }

  if (duplicateTeamIds.length > 0) {
    issues.push(
      issue(
        'team-double-booked',
        'error',
        'At least one team is used more than once in a round.',
        null,
        duplicateTeamIds,
      ),
    );
  }
  return deduplicateIssues(issues);
}

function duplicateTeamIdsFromGames(games: readonly ScheduledGame[]): EntityId[] {
  const byRound = new Map<EntityId, Set<EntityId>>();
  const duplicates = new Set<EntityId>();
  for (const game of games) {
    const teamIds = game.kind === 'bye' ? [game.byeTeamId] : [game.teamAId, game.teamBId];
    const seen = byRound.get(game.roundId) ?? new Set<EntityId>();
    for (const teamId of teamIds) {
      if (seen.has(teamId)) duplicates.add(teamId);
      seen.add(teamId);
    }
    byRound.set(game.roundId, seen);
  }
  return [...duplicates];
}

function deduplicateIssues(issues: readonly ScheduleIssue[]): ScheduleIssue[] {
  const seen = new Set<string>();
  const unique: ScheduleIssue[] = [];
  for (const current of issues) {
    const key = [current.code, current.roundId, current.gameIds.join(','), current.teamIds.join(',')].join(
      '|',
    );
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(current);
    }
  }
  return unique;
}
