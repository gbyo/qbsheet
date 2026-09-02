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
  /** Exact number of games each team should receive. */
  readonly roundsPerTeam?: number;
  readonly repetitions?: number;
  readonly seed?: string | number;
  readonly rematchPolicy?: RematchPolicy;
  readonly avoidSameOrganization?: boolean;
  readonly allowByes?: boolean;
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

interface PairingPlan {
  readonly rounds: readonly PairingRound[];
  readonly issues: readonly ScheduleIssue[];
}

interface PlannedRoundPlan {
  readonly rounds: readonly PlannedRound[];
  readonly issues: readonly ScheduleIssue[];
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

function sameOrganization(left: Team | undefined, right: Team | undefined): boolean {
  return Boolean(
    left?.organizationId && right?.organizationId && left.organizationId === right.organizationId,
  );
}

function preferredPartnerMap(pairing: PairingRound): Map<EntityId, EntityId | null> {
  const partners = new Map<EntityId, EntityId | null>();
  for (const pair of pairing.pairings) {
    if (pair.teamAId) partners.set(pair.teamAId, pair.teamBId);
    if (pair.teamBId) partners.set(pair.teamBId, pair.teamAId);
  }
  return partners;
}

function preferredPairingRank(pairing: PairingRound): Map<string, number> {
  const ranks = new Map<string, number>();
  pairing.pairings.forEach((pair, index) => {
    if (pair.teamAId && pair.teamBId) ranks.set(pairKey(pair.teamAId, pair.teamBId), index);
  });
  return ranks;
}

/**
 * Enumerate complete matchings for one round in a deterministic, preferred-first order.
 *
 * The old Director implementation repaired one edge at a time. That can displace the team
 * originally paired with the replacement and make it disappear from the round. This search always
 * consumes both endpoints together (and consumes exactly one bye slot for an odd field), so every
 * returned candidate is a whole-round matching before resources are assigned.
 */
function matchingCandidates(
  teamIds: readonly EntityId[],
  teamById: ReadonlyMap<EntityId, Team>,
  preferred: PairingRound,
  usedPairs: ReadonlySet<string>,
  avoidRematches: boolean,
  avoidSameOrganization: boolean,
  limit: number,
): PairingRound[] {
  const preferredPartners = preferredPartnerMap(preferred);
  const preferredRanks = preferredPairingRank(preferred);
  const positions = new Map(teamIds.map((teamId, index) => [teamId, index]));
  const remaining = new Set(teamIds);
  const pairings: Pairing[] = [];
  const candidates: PairingRound[] = [];
  const oddField = teamIds.length % 2 === 1;

  const partnerOptions = (teamId: EntityId): EntityId[] =>
    [...remaining]
      .filter((candidateId) => candidateId !== teamId)
      .filter((candidateId) => {
        if (avoidRematches && usedPairs.has(pairKey(teamId, candidateId))) return false;
        if (avoidSameOrganization && sameOrganization(teamById.get(teamId), teamById.get(candidateId)))
          return false;
        return true;
      })
      .sort((candidateLeft, candidateRight) => {
        const leftPreferred = preferredPartners.get(teamId) === candidateLeft ? 0 : 1;
        const rightPreferred = preferredPartners.get(teamId) === candidateRight ? 0 : 1;
        const leftRank = preferredRanks.get(pairKey(teamId, candidateLeft)) ?? Number.POSITIVE_INFINITY;
        const rightRank = preferredRanks.get(pairKey(teamId, candidateRight)) ?? Number.POSITIVE_INFINITY;
        return (
          leftPreferred - rightPreferred ||
          leftRank - rightRank ||
          (positions.get(candidateLeft) ?? 0) - (positions.get(candidateRight) ?? 0) ||
          candidateLeft.localeCompare(candidateRight)
        );
      });

  const chooseLeft = (): EntityId | null => {
    if (remaining.size === 0) return null;
    const ordered = [...remaining].sort((left, right) => {
      const leftOptions = partnerOptions(left).length + (oddField ? 1 : 0);
      const rightOptions = partnerOptions(right).length + (oddField ? 1 : 0);
      return leftOptions - rightOptions || (positions.get(left) ?? 0) - (positions.get(right) ?? 0);
    });
    return ordered[0] ?? null;
  };

  const search = (byeUsed: boolean): void => {
    if (candidates.length >= limit) return;
    if (remaining.size === 0) {
      if (!oddField || byeUsed) candidates.push({ pairings: [...pairings] });
      return;
    }
    const left = chooseLeft();
    if (!left) return;

    const preferredBye = preferredPartners.get(left) === null;
    const tryBye = oddField && !byeUsed && (preferredBye || remaining.size === 1);
    const branch = (): void => {
      remaining.delete(left);
      pairings.push({ teamAId: left, teamBId: null });
      search(true);
      pairings.pop();
      remaining.add(left);
    };
    if (tryBye) branch();

    for (const right of partnerOptions(left)) {
      if (candidates.length >= limit) return;
      remaining.delete(left);
      remaining.delete(right);
      pairings.push({ teamAId: left, teamBId: right });
      search(byeUsed);
      pairings.pop();
      remaining.add(left);
      remaining.add(right);
    }
    if (oddField && !byeUsed && !tryBye) branch();
  };

  search(false);
  return candidates;
}

function addPairingsToSet(pairing: PairingRound, usedPairs: Set<string>): void {
  for (const pair of pairing.pairings) {
    if (pair.teamAId && pair.teamBId) usedPairs.add(pairKey(pair.teamAId, pair.teamBId));
  }
}

function constrainedPairingPlan(
  teamIds: readonly EntityId[],
  teams: readonly Team[],
  repetitions: number,
  seed: string | number,
  rematchPolicy: RematchPolicy,
  avoidSameOrganization: boolean,
  requestedRoundCount: number,
): PairingPlan {
  const baseRounds = cyclePlans(teamIds, repetitions, seed, rematchPolicy);
  const count = Math.min(baseRounds.length, Math.max(0, requestedRoundCount));
  if (count === 0) return { rounds: [], issues: [] };
  if (!avoidSameOrganization) return { rounds: baseRounds.slice(0, count), issues: [] };

  const teamById = new Map(teams.map((team) => [team.id, team]));
  const fullCycleRounds = teamIds.length % 2 === 0 ? Math.max(0, teamIds.length - 1) : teamIds.length;
  const strictRematchRounds = rematchPolicy === 'allow' ? 0 : Math.min(count, fullCycleRounds);

  const searchSchedule = (avoidRematches: boolean, avoidOrganizations: boolean): PairingRound[] | null => {
    const selected: PairingRound[] = [];
    const usedPairs = new Set<string>();
    const search = (index: number): boolean => {
      if (index === count) return true;
      const strictRematches = avoidRematches && index < strictRematchRounds;
      const candidates = matchingCandidates(
        teamIds,
        teamById,
        baseRounds[index],
        usedPairs,
        strictRematches,
        avoidOrganizations,
        Math.max(64, teamIds.length * 8),
      );
      for (const candidate of candidates) {
        selected.push(candidate);
        const before = new Set(usedPairs);
        addPairingsToSet(candidate, usedPairs);
        if (search(index + 1)) return true;
        usedPairs.clear();
        for (const value of before) usedPairs.add(value);
        selected.pop();
      }
      return false;
    };
    return search(0) ? selected : null;
  };

  const strict = searchSchedule(rematchPolicy !== 'allow', true);
  if (strict) return { rounds: strict, issues: [] };

  const relaxedRematches = searchSchedule(false, true);
  if (relaxedRematches) {
    return {
      rounds: relaxedRematches,
      issues: [
        issue(
          'rematches-unavoidable',
          'warning',
          'The organization constraint can be satisfied only by allowing a rematch in a later round.',
        ),
      ],
    };
  }

  const relaxedOrganizations = searchSchedule(false, false);
  if (relaxedOrganizations) {
    return {
      rounds: relaxedOrganizations,
      issues: [
        issue(
          'same-organization-unavoidable',
          'warning',
          'No complete schedule satisfies the organization constraint; structurally valid same-organization games were retained.',
        ),
      ],
    };
  }

  // The circle method is a known complete fallback. It is used only if the constrained search was
  // unable to find a schedule, and validation below still guards the structural invariants.
  return {
    rounds: baseRounds.slice(0, count),
    issues: [
      issue(
        'matching-constraint-unsatisfied',
        'warning',
        'The requested organization/rematch constraints could not be satisfied for every round; the complete circle schedule was retained.',
      ),
    ],
  };
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
  if (options.roomIds) return [...new Set(options.roomIds)];
  return [...new Set(options.rooms?.filter((room) => room.active).map((room) => room.id) ?? [])];
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
  // Everything below is keyed by the round *entity*, not by a pool's own index into its rotation.
  // Several pools can share one tournament round — that is what makes their rounds simultaneous —
  // and in that round there is one set of rooms, one packet, and one sequence numbering.
  const byRound = new Map<EntityId, ScheduledGame[]>();
  const roomsByRound = new Map<EntityId, Set<EntityId>>();
  const sequenceByRound = new Map<EntityId, number>();
  const packetIndexByRound = new Map<EntityId, number>();

  for (const planned of plannedRounds) {
    const roundGames: ScheduledGame[] = [];
    const roundId = planned.roundDefinition.id;
    const roundRoomIds = roomsByRound.get(roundId) ?? new Set<EntityId>();
    roomsByRound.set(roundId, roundRoomIds);
    if (!packetIndexByRound.has(roundId)) packetIndexByRound.set(roundId, packetIndexByRound.size);
    planned.pairings.forEach((pair) => {
      const sequence = sequenceByRound.get(roundId) ?? 0;
      sequenceByRound.set(roundId, sequence + 1);
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

      // One packet per round, which is how a quiz bowl round is read: every room hears the same
      // questions at the same time. A per-game override is applied by the caller afterwards.
      const packetId =
        packetIds.length > 0 ? packetIds[(packetIndexByRound.get(roundId) ?? 0) % packetIds.length] : null;
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
    });
    const allRoundGames = byRound.get(roundId) ?? [];
    allRoundGames.push(...roundGames);
    byRound.set(roundId, allRoundGames);
  }

  for (const roundGames of byRound.values()) {
    games.push(...roundGames);
  }
  return { games, issues };
}

function planRounds(
  phaseId: EntityId,
  poolId: EntityId | null,
  teams: readonly Team[],
  rounds: readonly ScheduleRoundDefinition[] | undefined,
  roundCount: number | undefined,
  roundsPerTeam: number | undefined,
  repetitions: number,
  seed: string | number,
  rematchPolicy: RematchPolicy,
  avoidSameOrganization: boolean,
): PlannedRoundPlan {
  const teamIds = teamOrder(teams);
  const fullCycleRounds = teamIds.length % 2 === 0 ? Math.max(0, teamIds.length - 1) : teamIds.length;
  const fullRoundCount = fullCycleRounds * repetitions;
  const gamesPerFullCycle = Math.max(0, teamIds.length - 1);
  const requestedRoundCount =
    roundsPerTeam === undefined
      ? (roundCount ?? rounds?.length ?? fullRoundCount)
      : teamIds.length % 2 === 0
        ? roundsPerTeam
        : (roundsPerTeam / Math.max(1, gamesPerFullCycle)) * teamIds.length;
  const count = Math.min(fullRoundCount, Math.max(0, requestedRoundCount));
  const pairingPlan = constrainedPairingPlan(
    teamIds,
    teams,
    repetitions,
    seed,
    rematchPolicy,
    avoidSameOrganization,
    count,
  );
  return {
    rounds: pairingPlan.rounds.map((pairing, index) => ({
      phaseId,
      roundIndex: index,
      roundDefinition: roundDefinitionAt(rounds, phaseId, poolId, index),
      poolId,
      pairings: pairing.pairings,
    })),
    issues: pairingPlan.issues,
  };
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

function hasStructuralScheduleError(issues: readonly ScheduleIssue[]): boolean {
  // Do not return a value that callers can persist alongside an error describing why it is
  // invalid. Warnings and recommendations can remain attached to an otherwise valid schedule.
  return issues.some((current) => current.severity === 'error');
}

/** Generate a deterministic single-pool round-robin schedule. */
export function generateRoundRobinSchedule(options: RoundRobinScheduleOptions): GeneratedSchedule {
  const requestedRoundsPerTeam = options.roundsPerTeam;
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
  if (
    requestedRoundsPerTeam !== undefined &&
    (!Number.isInteger(requestedRoundsPerTeam) || requestedRoundsPerTeam < 1)
  ) {
    return {
      games: [],
      issues: [issue('invalid-rounds-per-team', 'error', 'roundsPerTeam must be a positive integer.')],
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
  if (options.teams.length % 2 === 1 && options.allowByes === false) {
    issues.push(
      issue(
        'byes-not-allowed',
        'error',
        'This field needs a bye, but allowByes is false.',
        null,
        [],
        options.teams.map((team) => team.id),
      ),
    );
  }
  if (issues.some((current) => current.severity === 'error')) {
    return { games: [], issues, expectedGamesPerTeam: null, roundCount: 0 };
  }

  const gamesPerFullCycle = options.teams.length - 1;
  if (
    requestedRoundsPerTeam !== undefined &&
    options.teams.length % 2 === 1 &&
    requestedRoundsPerTeam % gamesPerFullCycle !== 0
  ) {
    issues.push(
      issue(
        'rounds-per-team-unachievable',
        'error',
        `An odd field can give every team the same number of games only in complete cycles of ${gamesPerFullCycle} games per team.`,
      ),
    );
    return { games: [], issues, expectedGamesPerTeam: null, roundCount: 0 };
  }

  const effectiveRepetitions =
    requestedRoundsPerTeam === undefined
      ? repetitions
      : Math.max(repetitions, Math.ceil(requestedRoundsPerTeam / Math.max(1, gamesPerFullCycle)));
  const seed = options.seed ?? `${options.phaseId}:${options.poolId ?? 'main'}`;
  const planned = planRounds(
    options.phaseId,
    options.poolId ?? null,
    options.teams,
    options.rounds,
    options.roundCount,
    requestedRoundsPerTeam,
    effectiveRepetitions,
    seed,
    rematchPolicy,
    options.avoidSameOrganization ?? false,
  );
  issues.push(...planned.issues);
  const fullCycleRounds =
    options.teams.length % 2 === 0 ? Math.max(0, options.teams.length - 1) : options.teams.length;
  if (rematchPolicy === 'forbid' && planned.rounds.length > fullCycleRounds) {
    issues.push(
      issue(
        'rematches-required',
        'error',
        'The requested number of rounds requires at least one rematch, but rematchPolicy is forbid.',
      ),
    );
  }
  const assigned = assignResources(planned.rounds, options);
  issues.push(...assigned.issues);
  const fullRoundCount = fullCycleRounds * effectiveRepetitions;
  const expectedGamesPerTeam =
    requestedRoundsPerTeam ??
    (planned.rounds.length === fullRoundCount
      ? Math.max(0, options.teams.length - 1) * effectiveRepetitions
      : options.teams.length % 2 === 0
        ? planned.rounds.length
        : null);
  const effectiveRounds = planned.rounds.map((round) => round.roundDefinition);
  const validation = validateSchedule(assigned.games, options.teams, {
    rooms: options.rooms,
    roomIds: options.roomIds,
    expectedGamesPerTeam: expectedGamesPerTeam ?? undefined,
    rematchPolicy,
    avoidSameOrganization: options.avoidSameOrganization,
    requireRoomAssignments: options.requireRoomAssignments,
    requireExplicitByes: options.teams.length % 2 === 1,
    requireCompleteRounds: true,
    phaseId: options.phaseId,
    poolId: options.poolId ?? null,
    rounds: effectiveRounds,
  });
  issues.push(...validation);
  const games = hasStructuralScheduleError(issues) ? [] : assigned.games;
  return {
    games,
    issues,
    expectedGamesPerTeam,
    roundCount: games.length === 0 ? 0 : planned.rounds.length,
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
  const requestedRoundsPerTeam = options.roundsPerTeam;

  if (!Number.isInteger(options.repetitions ?? 1) || (options.repetitions ?? 1) < 1) {
    return {
      games: [],
      issues: [issue('invalid-repetitions', 'error', 'Repetitions must be a positive integer.')],
      expectedGamesPerTeam: null,
      roundCount: 0,
    };
  }
  if (
    requestedRoundsPerTeam !== undefined &&
    (!Number.isInteger(requestedRoundsPerTeam) || requestedRoundsPerTeam < 1)
  ) {
    return {
      games: [],
      issues: [issue('invalid-rounds-per-team', 'error', 'roundsPerTeam must be a positive integer.')],
      expectedGamesPerTeam: null,
      roundCount: 0,
    };
  }
  const duplicatePoolIds = new Set<EntityId>();
  const teamPoolById = new Map<EntityId, EntityId>();
  for (const pool of options.pools) {
    if (duplicatePoolIds.has(pool.id)) {
      issues.push(issue('duplicate-pool-id', 'error', `Pool “${pool.id}” appears more than once.`, pool.id));
    }
    duplicatePoolIds.add(pool.id);
    if (pool.phaseId !== options.phaseId) {
      issues.push(
        issue(
          'invalid-pool-phase',
          'error',
          `Pool “${pool.name}” does not belong to phase “${options.phaseId}”.`,
          pool.id,
        ),
      );
    }
    if (pool.teamIds.length < 2) {
      issues.push(
        issue(
          'too-few-teams',
          'error',
          `Pool “${pool.name}” needs at least two teams for a round-robin schedule.`,
          pool.id,
          [],
          pool.teamIds,
        ),
      );
    }
    const teamIdsInPool = new Set<EntityId>();
    for (const teamId of pool.teamIds) {
      if (teamIdsInPool.has(teamId)) {
        issues.push(
          issue(
            'duplicate-pool-team',
            'error',
            `Team “${teamId}” appears more than once in pool “${pool.name}”.`,
            pool.id,
            [],
            [teamId],
          ),
        );
      } else {
        teamIdsInPool.add(teamId);
      }
      const previousPoolId = teamPoolById.get(teamId);
      if (teamPoolById.has(teamId) && previousPoolId !== pool.id) {
        issues.push(
          issue(
            'duplicate-pool-team',
            'error',
            `Team “${teamId}” is assigned to more than one pool.`,
            pool.id,
            [],
            [teamId],
          ),
        );
      } else if (!teamPoolById.has(teamId)) {
        teamPoolById.set(teamId, pool.id);
      }
    }
    if (pool.teamIds.length % 2 === 1 && options.allowByes === false) {
      issues.push(
        issue(
          'byes-not-allowed',
          'error',
          `Pool “${pool.name}” needs a bye, but allowByes is false.`,
          null,
          [],
          pool.teamIds,
        ),
      );
    }
    if (
      requestedRoundsPerTeam !== undefined &&
      pool.teamIds.length > 1 &&
      pool.teamIds.length % 2 === 1 &&
      requestedRoundsPerTeam % (pool.teamIds.length - 1) !== 0
    ) {
      issues.push(
        issue(
          'rounds-per-team-unachievable',
          'error',
          `Pool “${pool.name}” cannot give every team exactly ${requestedRoundsPerTeam} games in complete rounds.`,
          pool.id,
          [],
          pool.teamIds,
        ),
      );
    }
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
  if (issues.some((current) => current.severity === 'error')) {
    return { games: [], issues, expectedGamesPerTeam: null, roundCount: 0 };
  }

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
    const poolGamesPerCycle = Math.max(1, poolTeams.length - 1);
    const poolRepetitions =
      requestedRoundsPerTeam === undefined
        ? (options.repetitions ?? 1)
        : Math.max(options.repetitions ?? 1, Math.ceil(requestedRoundsPerTeam / poolGamesPerCycle));
    const poolPlan = planRounds(
      options.phaseId,
      pool.id,
      poolTeams,
      poolRounds,
      options.roundsPerTeam === undefined ? (poolRounds?.length ?? options.roundCount) : undefined,
      requestedRoundsPerTeam,
      poolRepetitions,
      options.seed ?? `${options.phaseId}:${pool.id}`,
      rematchPolicy,
      options.avoidSameOrganization ?? false,
    );
    issues.push(...poolPlan.issues);
    maxRoundCount = Math.max(maxRoundCount, poolPlan.rounds.length);
    const fullCycleRounds = poolTeams.length % 2 === 0 ? Math.max(0, poolTeams.length - 1) : poolTeams.length;
    const fullRoundCount = fullCycleRounds * poolRepetitions;
    if (rematchPolicy === 'forbid' && poolPlan.rounds.length > fullCycleRounds) {
      issues.push(
        issue(
          'rematches-required',
          'error',
          `Pool “${pool.name}” requires a rematch for the requested number of rounds, but rematchPolicy is forbid.`,
          pool.id,
        ),
      );
    }
    const poolExpectedGamesPerTeam =
      requestedRoundsPerTeam ??
      (poolPlan.rounds.length === fullRoundCount
        ? Math.max(0, poolTeams.length - 1) * poolRepetitions
        : poolTeams.length % 2 === 0
          ? poolPlan.rounds.length
          : null);
    if (expectedGamesPerTeam === null) expectedGamesPerTeam = poolExpectedGamesPerTeam;
    else if (expectedGamesPerTeam !== poolExpectedGamesPerTeam) expectedGamesPerTeam = null;
    poolPlans.set(pool.id, {
      teamIds: poolTeams.map((team) => team.id),
      rounds: poolPlan.rounds,
      expectedGamesPerTeam: poolExpectedGamesPerTeam,
    });
    planned.push(...poolPlan.rounds);
  }

  const assigned = assignResources(planned, options);
  issues.push(...assigned.issues);
  const validation = validateSchedule(assigned.games, options.teams, {
    rooms: options.rooms,
    roomIds: options.roomIds,
    rematchPolicy,
    avoidSameOrganization: options.avoidSameOrganization,
    requireRoomAssignments: options.requireRoomAssignments,
    allowMixedPoolsPerRound: true,
    validateByeParity: false,
  });
  issues.push(...validation);
  for (const [poolId, plan] of poolPlans) {
    const effectivePoolRounds = plan.rounds.map((round) => round.roundDefinition);
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
          requireCompleteRounds: true,
          phaseId: options.phaseId,
          poolId,
          rounds: effectivePoolRounds,
        },
      ),
    );
  }
  const games = hasStructuralScheduleError(issues) ? [] : assigned.games;
  return { games, issues, expectedGamesPerTeam, roundCount: games.length === 0 ? 0 : maxRoundCount };
}

export interface ScheduleValidationOptions {
  readonly rooms?: readonly Room[];
  readonly roomIds?: readonly EntityId[];
  readonly phaseId?: EntityId;
  readonly poolId?: EntityId | null;
  readonly rounds?: readonly ScheduleRoundDefinition[];
  /** Permit synchronized pool schedules to share a round id without treating that as malformed. */
  readonly allowMixedPoolsPerRound?: boolean;
  /** Disable the global even/odd bye check when validating an aggregate of separate pools. */
  readonly validateByeParity?: boolean;
  readonly expectedGamesPerTeam?: number;
  readonly rematchPolicy?: RematchPolicy;
  readonly avoidSameOrganization?: boolean;
  readonly requireRoomAssignments?: boolean;
  readonly requireExplicitByes?: boolean;
  readonly requireCompleteRounds?: boolean;
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
  const roundDefinitions = new Map((options.rounds ?? []).map((round) => [round.id, round]));

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

    if (options.phaseId && game.phaseId !== options.phaseId) {
      issues.push(
        issue(
          'round-phase-mismatch',
          'error',
          `Game “${game.id}” belongs to phase “${game.phaseId}”, not “${options.phaseId}”.`,
          game.roundId,
          [game.id],
        ),
      );
    }
    if (options.poolId !== undefined && game.poolId !== options.poolId) {
      issues.push(
        issue(
          'round-pool-mismatch',
          'error',
          `Game “${game.id}” does not belong to the expected pool.`,
          game.roundId,
          [game.id],
        ),
      );
    }
    const roundDefinition = roundDefinitions.get(game.roundId);
    if (options.rounds && !roundDefinition) {
      issues.push(
        issue(
          'unknown-round',
          'error',
          `Game “${game.id}” references a round that is not in the supplied round definitions.`,
          game.roundId,
          [game.id],
        ),
      );
    } else if (roundDefinition) {
      if (roundDefinition.poolId !== undefined && roundDefinition.poolId !== game.poolId) {
        issues.push(
          issue(
            'round-pool-mismatch',
            'error',
            `Game “${game.id}” does not match the pool recorded for round “${game.roundId}”.`,
            game.roundId,
            [game.id],
          ),
        );
      }
    }

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

    if (!game.teamAId || !game.teamBId) {
      issues.push(
        issue(
          'missing-opponent',
          'error',
          `Game “${game.id}” is missing one of its two opponents.`,
          game.roundId,
          [game.id],
          [game.teamAId, game.teamBId].filter(Boolean),
        ),
      );
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
    const matchIdsByTeam = new Map<EntityId, EntityId[]>();
    const byeIdsByTeam = new Map<EntityId, EntityId[]>();
    const roomsInRound = new Map<EntityId, EntityId[]>();
    const sequences = new Set<string>();
    const phaseIds = new Set<EntityId>();
    const poolIds = new Set<EntityId | null>();
    for (const game of roundGames) {
      phaseIds.add(game.phaseId);
      poolIds.add(game.poolId);
      if (!Number.isInteger(game.sequence) || game.sequence < 0) {
        issues.push(
          issue(
            'invalid-sequence',
            'error',
            `Round “${roundId}” contains an invalid sequence number.`,
            roundId,
            [game.id],
          ),
        );
      }
      const sequenceKey = options.allowMixedPoolsPerRound
        ? `${game.poolId ?? ''}\u0000${game.sequence}`
        : String(game.sequence);
      if (sequences.has(sequenceKey)) {
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
      sequences.add(sequenceKey);
      const participants = game.kind === 'bye' ? [game.byeTeamId] : [game.teamAId, game.teamBId];
      for (const teamId of participants) {
        if (!teamId) continue;
        const previous = teamsInRound.get(teamId) ?? [];
        previous.push(game.id);
        teamsInRound.set(teamId, previous);
        const idsByKind = game.kind === 'bye' ? byeIdsByTeam : matchIdsByTeam;
        const kindIds = idsByKind.get(teamId) ?? [];
        kindIds.push(game.id);
        idsByKind.set(teamId, kindIds);
      }
      if (game.kind !== 'bye' && game.roomId) {
        const roomGames = roomsInRound.get(game.roomId) ?? [];
        roomGames.push(game.id);
        roomsInRound.set(game.roomId, roomGames);
      }
    }
    if (phaseIds.size > 1 || (!options.allowMixedPoolsPerRound && poolIds.size > 1)) {
      issues.push(
        issue(
          'mixed-round-membership',
          'error',
          `Round “${roundId}” contains games from more than one phase or pool.`,
          roundId,
          roundGames.map((game) => game.id),
        ),
      );
    }
    for (const [teamId, byeIds] of byeIdsByTeam) {
      if (byeIds.length > 1) {
        issues.push(
          issue(
            'duplicate-bye',
            'error',
            `Team “${teamId}” has more than one bye in round “${roundId}”.`,
            roundId,
            byeIds,
            [teamId],
          ),
        );
      }
      const matchIds = matchIdsByTeam.get(teamId) ?? [];
      if (matchIds.length > 0) {
        issues.push(
          issue(
            'team-game-and-bye',
            'error',
            `Team “${teamId}” has both a game and a bye in round “${roundId}”.`,
            roundId,
            [...matchIds, ...byeIds],
            [teamId],
          ),
        );
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
    const byeCount = roundGames.filter((game) => game.kind === 'bye').length;
    if ((options.validateByeParity ?? true) && teams.length % 2 === 0 && byeCount > 0) {
      issues.push(
        issue(
          'unexpected-bye',
          'error',
          `Round “${roundId}” contains a bye even though the field has an even number of teams.`,
          roundId,
          roundGames.filter((game) => game.kind === 'bye').map((game) => game.id),
        ),
      );
    }
    if (options.requireExplicitByes && teams.length % 2 === 1) {
      if (byeCount === 0) {
        issues.push(
          issue(
            'missing-explicit-bye',
            'error',
            `Round “${roundId}” has an odd field but no explicit bye.`,
            roundId,
          ),
        );
      }
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
    if (options.requireCompleteRounds) {
      for (const team of teams) {
        if (!teamsInRound.has(team.id)) {
          issues.push(
            issue(
              'missing-team-in-round',
              'error',
              `Team “${team.displayName}” is not present in round “${roundId}”.`,
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
