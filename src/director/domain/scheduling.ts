import {
  type DirectorId,
  type DirectorState,
  type FormatDefinition,
  type Phase,
  type Pool,
  type Round,
  type ScheduledGame,
  type Team,
  newDirectorId,
  isoNow,
} from './model';
import {
  generateRoundRobinSchedule,
  type ScheduledGame as CoreScheduledGame,
  type Team as CoreTeam,
} from '@qbsheet/tournament-core';

export interface ScheduleOptions {
  roundName?: string;
  roundNumber?: number;
  phaseId?: DirectorId;
  roomIds?: DirectorId[];
  packetId?: DirectorId | null;
  poolId?: DirectorId | null;
  avoidRematches?: boolean;
  avoidSameOrganization?: boolean;
  allowByes?: boolean;
  formatKind?: 'round-robin' | 'double-round-robin';
  roundsPerTeam?: number | null;
  seed?: number;
}

export interface ScheduleConflict {
  code:
    | 'not-enough-rooms'
    | 'same-organization'
    | 'rematch'
    | 'no-bye-allowed'
    | 'unsupported-format'
    | 'missing-format'
    | 'missing-phase'
    | 'missing-pools'
    | 'format-complete'
    | 'invalid-generation';
  severity: 'error' | 'warning';
  message: string;
  teamIds?: DirectorId[];
}

export interface ScheduleGenerationResult {
  round: Round;
  games: ScheduledGame[];
  conflicts: ScheduleConflict[];
  hardFailure: boolean;
}

export interface FormatGenerationAvailability {
  supported: boolean;
  message: string;
}

export function currentFormat(state: DirectorState): FormatDefinition | null {
  const formatId = state.tournament?.formatId;
  return formatId ? (state.formats.find((format) => format.id === formatId) ?? null) : null;
}

export function currentPhase(state: DirectorState): Phase | null {
  const phaseId = state.tournament?.currentPhaseId;
  if (phaseId) return state.phases.find((phase) => phase.id === phaseId) ?? null;
  const currentRoundId = state.tournament?.currentRoundId;
  if (!currentRoundId) return null;
  const round = state.rounds.find((candidate) => candidate.id === currentRoundId);
  return round ? (state.phases.find((phase) => phase.id === round.phaseId) ?? null) : null;
}

export function currentPacket(state: DirectorState): DirectorState['packets'][number] | null {
  const packetId = state.tournament?.currentPacketId;
  return packetId ? (state.packets.find((packet) => packet.id === packetId) ?? null) : null;
}

export function formatGenerationAvailability(state: DirectorState): FormatGenerationAvailability {
  const format = currentFormat(state);
  if (!format) return { supported: false, message: 'Choose a valid current format before generating.' };
  if (state.tournament?.status === 'complete' || state.tournament?.status === 'archived') {
    return {
      supported: false,
      message: `This tournament is ${state.tournament.status}; schedule generation is disabled.`,
    };
  }
  const phase = currentPhase(state);
  if (!phase || phase.formatId !== format.id) {
    return { supported: false, message: 'Choose a valid current phase for this format before generating.' };
  }
  const confirmedCount = state.teams.filter((team) => team.status === 'confirmed').length;
  if (confirmedCount < 2) {
    return { supported: false, message: 'Add at least two confirmed teams before generating a round.' };
  }
  if (phase.status === 'complete') {
    return {
      supported: false,
      message: 'This phase is complete; select or add another phase for additional play.',
    };
  }
  if (format.kind === 'pools' || format.kind === 'playoff-pools') {
    const pools = state.pools.filter((pool) => phase.poolIds.includes(pool.id));
    if (pools.length === 0) {
      return { supported: false, message: 'Configure at least one pool before generating this format.' };
    }
    const configurationProblem = poolConfigurationProblem(
      state,
      phase,
      pools,
      format.allowByes,
      format.kind !== 'playoff-pools',
    );
    if (configurationProblem) return { supported: false, message: configurationProblem };
    const phaseRoundCount = state.rounds.filter((round) => round.phaseId === phase.id).length;
    if (format.roundsPerTeam !== null && phaseRoundCount >= format.roundsPerTeam) {
      return {
        supported: false,
        message: `This format has reached its configured limit of ${format.roundsPerTeam} round${format.roundsPerTeam === 1 ? '' : 's'} per team.`,
      };
    }
    return { supported: true, message: 'Pool round-robin generation is available for this phase.' };
  }
  if (format.kind === 'round-robin' || format.kind === 'double-round-robin') {
    const phaseRoundCount = state.rounds.filter((round) => round.phaseId === phase.id).length;
    const naturalLimit =
      format.kind === 'double-round-robin' ? roundRobinCycleLength(confirmedCount) * 2 : null;
    const maximumRoundCount =
      naturalLimit === null
        ? format.roundsPerTeam
        : Math.min(format.roundsPerTeam ?? naturalLimit, naturalLimit);
    if (maximumRoundCount !== null && phaseRoundCount >= maximumRoundCount) {
      if (naturalLimit !== null && phaseRoundCount >= naturalLimit) {
        return {
          supported: false,
          message: 'This double round robin is complete; add a new phase for additional play.',
        };
      }
      return {
        supported: false,
        message: `This format has reached its configured limit of ${maximumRoundCount} round${maximumRoundCount === 1 ? '' : 's'} per team.`,
      };
    }
    return { supported: true, message: 'Round-robin generation is available for this format.' };
  }
  return {
    supported: false,
    message: `${format.name} is not implemented in Director yet; generation is disabled.`,
  };
}

function poolConfigurationProblem(
  state: DirectorState,
  phase: Phase,
  pools: Pool[],
  allowByes: boolean,
  requireAllConfirmedTeams: boolean,
): string | null {
  const teamsById = new Map(state.teams.map((team) => [team.id, team]));
  const confirmedTeamIds = state.teams.filter((team) => team.status === 'confirmed').map((team) => team.id);
  const counts = new Map<DirectorId, number>();
  for (const pool of pools) {
    if (pool.phaseId !== phase.id) return `Pool ${pool.name} belongs to a different phase.`;
    for (const teamId of pool.teamIds) counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
  }
  // Preliminary pools partition the entire confirmed field. A playoff-pools phase instead
  // receives the advancing teams as its pool membership, so confirmed teams left outside those
  // pools are valid and must not block generation.
  const expectedTeamIds = requireAllConfirmedTeams
    ? confirmedTeamIds
    : [...new Set(pools.flatMap((pool) => pool.teamIds))];
  const missing = expectedTeamIds.filter((teamId) => !counts.has(teamId));
  if (missing.length > 0) {
    return `Assign every confirmed team to exactly one pool before generating: ${missing
      .map((teamId) => teamsById.get(teamId)?.displayName ?? teamId)
      .join(', ')}.`;
  }
  const duplicate = [...counts.entries()].filter(([, count]) => count > 1).map(([teamId]) => teamId);
  if (duplicate.length > 0) {
    return `Remove duplicate pool membership before generating: ${duplicate
      .map((teamId) => teamsById.get(teamId)?.displayName ?? teamId)
      .join(', ')}.`;
  }
  for (const pool of pools) {
    const confirmed = pool.teamIds.filter((teamId) => teamsById.get(teamId)?.status === 'confirmed');
    const invalid = pool.teamIds.filter((teamId) => teamsById.get(teamId)?.status !== 'confirmed');
    if (invalid.length > 0) return `Pool ${pool.name} contains a missing or non-confirmed team.`;
    if (confirmed.length === 0) return `Pool ${pool.name} has no confirmed teams.`;
    if (confirmed.length % 2 === 1 && !allowByes) {
      return `Pool ${pool.name} needs a bye, but byes are disabled.`;
    }
  }
  return null;
}

/** A small deterministic PRNG; repeatable schedules matter when a director regenerates a preview. */
function seededRandom(seed: number): () => number {
  let value = Math.abs(Math.trunc(seed)) || 1;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function activeTeams(state: DirectorState, seed?: number): Team[] {
  const teams = state.teams.filter((team) => team.status === 'confirmed');
  if (seed === undefined) return [...teams].sort((a, b) => (a.seed ?? 9999) - (b.seed ?? 9999));
  const random = seededRandom(seed);
  return [...teams]
    .map((team) => ({ team, sort: random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ team }) => team);
}

function hasPlayed(state: DirectorState, leftId: DirectorId, rightId: DirectorId): boolean {
  return state.scheduledGames.some(
    (game) =>
      game.status !== 'cancelled' &&
      ((game.leftTeamId === leftId && game.rightTeamId === rightId) ||
        (game.leftTeamId === rightId && game.rightTeamId === leftId)),
  );
}

function organizationId(state: DirectorState, teamId: DirectorId): DirectorId | null {
  return state.teams.find((team) => team.id === teamId)?.organizationId ?? null;
}

/**
 * Generate one round while solving all pairings together.
 *
 * The old implementation repaired one pairing at a time. That can steal an opponent from a later
 * pairing and leave the displaced team absent from the round. A complete matching is built before
 * any Director objects are created, so a failed constraint search can never produce a partial
 * schedule.
 */
export function generateRoundRobinRound(
  state: DirectorState,
  options: ScheduleOptions = {},
): ScheduleGenerationResult {
  const teams = activeTeams(state, options.seed);
  const conflicts: ScheduleConflict[] = [];
  const allowByes = options.allowByes ?? true;
  const roundNumber = options.roundNumber ?? nextRoundNumber(state);
  const roundId = newDirectorId('round');
  if (teams.length < 2) {
    conflicts.push({
      code: 'invalid-generation',
      severity: 'error',
      message: 'At least two confirmed teams are required to generate a round.',
    });
    return buildGenerationResult(roundId, roundNumber, options, [], conflicts);
  }
  if (teams.length % 2 === 1 && !allowByes) {
    conflicts.push({
      code: 'no-bye-allowed',
      severity: 'error',
      message: 'This field needs a bye, but byes are disabled.',
    });
    return buildGenerationResult(roundId, roundNumber, options, [], conflicts);
  }

  const phaseRounds = options.phaseId
    ? state.rounds
        .filter((round) => round.phaseId === options.phaseId)
        .sort((left, right) => left.number - right.number || left.id.localeCompare(right.id))
    : [];
  const roundIndex = phaseRounds.length;
  const cycleLength = roundRobinCycleLength(teams.length);
  if (options.formatKind === 'double-round-robin' && roundIndex >= cycleLength * 2) {
    conflicts.push({
      code: 'format-complete',
      severity: 'error',
      message: 'This double round robin already contains both complete rotations.',
    });
    return buildGenerationResult(roundId, roundNumber, options, [], conflicts);
  }
  const naturalLimit = options.formatKind === 'double-round-robin' ? cycleLength * 2 : null;
  const maximumRoundCount =
    naturalLimit === null
      ? (options.roundsPerTeam ?? null)
      : Math.min(options.roundsPerTeam ?? naturalLimit, naturalLimit);
  if (maximumRoundCount !== null && roundIndex >= maximumRoundCount) {
    conflicts.push({
      code: 'format-complete',
      severity: 'error',
      message: `This format has reached its configured limit of ${maximumRoundCount} round${maximumRoundCount === 1 ? '' : 's'} per team.`,
    });
    return buildGenerationResult(roundId, roundNumber, options, [], conflicts);
  }
  const intentionalRematch = options.formatKind === 'double-round-robin' && roundIndex >= cycleLength;
  const firstCycleOptions =
    options.formatKind === 'double-round-robin' && !intentionalRematch
      ? { ...options, avoidRematches: true }
      : options;
  const pairings = intentionalRematch
    ? (repeatRoundPairings(state, teams, phaseRounds[roundIndex - cycleLength]) ??
      pairRoundRobinTeams(state, teams, options, roundNumber))
    : pairRoundRobinTeams(state, teams, firstCycleOptions, roundNumber);
  if (!pairings) {
    conflicts.push({
      code: 'invalid-generation',
      severity: 'error',
      message: 'No complete valid pairing could be generated for this field.',
    });
    return buildGenerationResult(roundId, roundNumber, options, [], conflicts);
  }

  const games = pairings.map(([left, right]) =>
    buildGame(roundNumber, left?.id ?? '', right?.id ?? null, options),
  );
  appendPairingConflicts(conflicts, state, pairings, options, intentionalRematch);
  const roomIds = options.roomIds ?? assignableRoomIds(state);
  let roomIndex = 0;
  for (const game of games) {
    if (game.bye) continue;
    game.roomId = roomIds[roomIndex] ?? null;
    roomIndex += 1;
  }
  if (roomIndex > roomIds.length) {
    conflicts.push({
      code: 'not-enough-rooms',
      severity: 'warning',
      message: `${games.filter((game) => !game.bye).length} games need rooms, but only ${roomIds.length} are available.`,
    });
  }

  return buildGenerationResult(roundId, roundNumber, options, games, conflicts, teams);
}

function pairRoundRobinTeams(
  state: DirectorState,
  teams: Team[],
  options: ScheduleOptions,
  roundNumber: number,
): Array<[Team | null, Team | null]> | null {
  const useConstraints = Boolean(options.avoidRematches || options.avoidSameOrganization);
  const constrained = useConstraints
    ? findCompleteMatching(teams, (left, right) => legalPair(state, left, right, options))
    : null;
  if (constrained) return constrained;

  // The tested tournament-core scheduler supplies the deterministic baseline when no complete
  // constraint solution exists. We still validate and adapt its output before it reaches Director.
  const corePairings = coreRoundPairings(
    teams,
    options.phaseId ?? 'director-phase',
    roundNumber,
    options.seed,
  );
  if (corePairings && hasCompleteTeamCoverage(corePairings, teams)) {
    return corePairings;
  }

  return findCompleteMatching(teams, () => true);
}

function appendPairingConflicts(
  conflicts: ScheduleConflict[],
  state: DirectorState,
  pairings: Array<[Team | null, Team | null]>,
  options: ScheduleOptions,
  intentionalRematch: boolean,
): void {
  if (!options.avoidRematches && !options.avoidSameOrganization) return;
  for (const [left, right] of pairings) {
    if (!left || !right || legalPair(state, left, right, options)) continue;
    if (options.avoidRematches && hasPlayed(state, left.id, right.id) && !intentionalRematch) {
      conflicts.push({
        code: 'rematch',
        severity: 'warning',
        message: `${left.displayName} and ${right.displayName} are a rematch because no fully constrained pairing was available.`,
        teamIds: [left.id, right.id],
      });
    } else if (
      options.avoidSameOrganization &&
      organizationId(state, left.id) !== null &&
      organizationId(state, left.id) === organizationId(state, right.id)
    ) {
      conflicts.push({
        code: 'same-organization',
        severity: 'warning',
        message: `${left.displayName} and ${right.displayName} share an organization because no fully constrained pairing was available.`,
        teamIds: [left.id, right.id],
      });
    }
  }
}

function repeatRoundPairings(
  state: DirectorState,
  teams: Team[],
  round: Round | undefined,
): Array<[Team | null, Team | null]> | null {
  if (!round) return null;
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const pairings = state.scheduledGames
    .filter((game) => game.roundId === round.id)
    .map((game): [Team | null, Team | null] => [
      teamById.get(game.leftTeamId) ?? null,
      game.rightTeamId ? (teamById.get(game.rightTeamId) ?? null) : null,
    ]);
  if (pairings.length !== Math.ceil(teams.length / 2)) return null;
  const seen = new Set<DirectorId>();
  for (const [left, right] of pairings) {
    if (!left) return null;
    if (right && (left.id === right.id || seen.has(left.id) || seen.has(right.id))) return null;
    if (!right && seen.has(left.id)) return null;
    seen.add(left.id);
    if (right) seen.add(right.id);
  }
  return seen.size === teams.length ? pairings : null;
}

function legalPair(
  state: DirectorState,
  left: Team | null,
  right: Team | null,
  options: ScheduleOptions,
): boolean {
  if (!left || !right) return true;
  if (left.id === right.id) return false;
  if (options.avoidRematches && hasPlayed(state, left.id, right.id)) return false;
  if (
    options.avoidSameOrganization &&
    organizationId(state, left.id) !== null &&
    organizationId(state, left.id) === organizationId(state, right.id)
  )
    return false;
  return true;
}

function findCompleteMatching(
  teams: Team[],
  allowed: (left: Team | null, right: Team | null) => boolean,
): Array<[Team | null, Team | null]> | null {
  const remaining: Array<Team | null> = [...teams];
  if (remaining.length % 2 === 1) remaining.push(null);
  const result: Array<[Team | null, Team | null]> = [];

  const search = (): boolean => {
    if (remaining.length === 0) return true;

    let selectedIndex = 0;
    let selectedCandidates: number[] = [];
    for (let index = 0; index < remaining.length; index += 1) {
      const candidates = candidateIndexes(remaining, index, allowed);
      if (selectedCandidates.length === 0 || candidates.length < selectedCandidates.length) {
        selectedIndex = index;
        selectedCandidates = candidates;
      }
      if (selectedCandidates.length === 0) return false;
    }

    const first = remaining[selectedIndex];
    for (const candidateIndex of selectedCandidates) {
      const second = remaining[candidateIndex];
      remaining.splice(Math.max(selectedIndex, candidateIndex), 1);
      remaining.splice(Math.min(selectedIndex, candidateIndex), 1);
      result.push(first === null ? [second, first] : [first, second]);
      if (search()) return true;
      result.pop();
      const lowIndex = Math.min(selectedIndex, candidateIndex);
      const highIndex = Math.max(selectedIndex, candidateIndex);
      if (selectedIndex < candidateIndex) {
        remaining.splice(lowIndex, 0, first);
        remaining.splice(highIndex, 0, second);
      } else {
        remaining.splice(lowIndex, 0, second);
        remaining.splice(highIndex, 0, first);
      }
    }
    return false;
  };

  return search() ? result : null;
}

function candidateIndexes(
  remaining: Array<Team | null>,
  selectedIndex: number,
  allowed: (left: Team | null, right: Team | null) => boolean,
): number[] {
  const first = remaining[selectedIndex];
  return remaining
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ index }) => index !== selectedIndex)
    .filter(({ candidate }) => allowed(first, candidate))
    .map(({ index }) => index);
}

function coreRoundPairings(
  teams: Team[],
  phaseId: DirectorId,
  roundNumber: number,
  seed: number | undefined,
): Array<[Team | null, Team | null]> | null {
  const byId = new Map(teams.map((team) => [team.id, team]));
  const schedule = generateRoundRobinSchedule({
    phaseId,
    teams: teams.map(toCoreTeam),
    roomIds: [],
    roundCount: 1,
    seed: seed ?? roundNumber,
    rematchPolicy: 'allow',
  });
  const pairings = schedule.games.map((game: CoreScheduledGame): [Team | null, Team | null] =>
    game.kind === 'bye'
      ? [byId.get(game.byeTeamId) ?? null, null]
      : [byId.get(game.teamAId) ?? null, byId.get(game.teamBId) ?? null],
  );
  return pairings.length > 0 ? pairings : null;
}

function hasCompleteTeamCoverage(pairings: Array<[Team | null, Team | null]>, teams: Team[]): boolean {
  const seen = new Set(pairings.flatMap(([left, right]) => [left?.id, right?.id].filter(Boolean)));
  return seen.size === teams.length && teams.every((team) => seen.has(team.id));
}

function toCoreTeam(team: Team): CoreTeam {
  return {
    id: team.id,
    name: team.displayName,
    displayName: team.displayName,
    letter: team.teamLetter || null,
    organizationId: team.organizationId,
    seed: team.seed,
    status: 'active',
    playerIds: [],
    notes: team.notes ?? '',
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

function buildGenerationResult(
  roundId: DirectorId,
  roundNumber: number,
  options: ScheduleOptions,
  games: ScheduledGame[],
  conflicts: ScheduleConflict[],
  expectedTeams: Team[] = [],
  expectedByeCount = expectedTeams.length % 2,
): ScheduleGenerationResult {
  games.forEach((game) => {
    game.roundId = roundId;
  });
  const round: Round = {
    id: roundId,
    phaseId: options.phaseId ?? '',
    name: options.roundName ?? `Round ${roundNumber}`,
    number: roundNumber,
    revision: 1,
    status: 'planned',
    packetId: options.packetId ?? null,
    scheduledGameIds: games.map((game) => game.id),
    startedAt: null,
    closedAt: null,
  };
  const valid =
    expectedTeams.length === 0
      ? scheduleIsValid(games)
      : scheduleIsValid(games, expectedTeams, { expectedByeCount });
  if (!valid) {
    conflicts.push({
      code: 'invalid-generation',
      severity: 'error',
      message: 'The generated round failed structural validation and was discarded.',
    });
    return { round: { ...round, scheduledGameIds: [] }, games: [], conflicts, hardFailure: true };
  }
  return {
    round,
    games,
    conflicts,
    hardFailure: conflicts.some((conflict) => conflict.severity === 'error'),
  };
}

function buildGame(
  roundNumber: number,
  leftTeamId: DirectorId,
  rightTeamId: DirectorId | null,
  options: ScheduleOptions,
): ScheduledGame {
  return {
    id: newDirectorId('game'),
    roundId: '',
    poolId: options.poolId ?? null,
    roomId: null,
    packetId: options.packetId ?? null,
    leftTeamId,
    rightTeamId,
    bye: rightTeamId === null,
    status: 'scheduled',
    assignmentRevision: 1,
    notes: rightTeamId === null ? `Bye in round ${roundNumber}` : undefined,
  };
}

function nextRoundNumber(state: DirectorState): number {
  return state.rounds.reduce((maximum, round) => Math.max(maximum, round.number), 0) + 1;
}

/**
 * Route a Director generation request to an implementation that matches the selected format.
 * Unsupported formats return a hard error and never get a round-robin fallback.
 */
export function generateDirectorRound(
  state: DirectorState,
  options: Pick<ScheduleOptions, 'seed' | 'avoidRematches' | 'avoidSameOrganization'> = {},
): ScheduleGenerationResult {
  const format = currentFormat(state);
  if (!format) {
    return failedGenerationResult(
      state,
      { ...options },
      'missing-format',
      'Choose a valid current format first.',
    );
  }
  const phase = currentPhase(state);
  if (!phase || phase.formatId !== format.id) {
    return failedGenerationResult(
      state,
      { ...options },
      'missing-phase',
      'Choose a valid current phase for the selected format first.',
    );
  }
  if (state.tournament?.status === 'complete' || state.tournament?.status === 'archived') {
    return failedGenerationResult(
      state,
      { ...options, phaseId: phase.id },
      'format-complete',
      `This tournament is ${state.tournament?.status}; schedule generation is disabled.`,
    );
  }
  if (phase.status === 'complete') {
    return failedGenerationResult(
      state,
      { ...options, phaseId: phase.id },
      'format-complete',
      'This phase is complete; select or add another phase for additional play.',
    );
  }
  const packet = currentPacket(state);
  const scheduleOptions: ScheduleOptions = {
    ...options,
    phaseId: phase.id,
    packetId: packet?.id ?? null,
    formatKind: format.kind === 'double-round-robin' ? 'double-round-robin' : 'round-robin',
    roundsPerTeam: format.roundsPerTeam,
    avoidRematches: options.avoidRematches ?? format.avoidRematches,
    avoidSameOrganization: options.avoidSameOrganization ?? format.avoidSameOrganization,
    allowByes: format.allowByes,
  };

  if (format.kind === 'round-robin' || format.kind === 'double-round-robin') {
    return generateRoundRobinRound(state, scheduleOptions);
  }
  if (format.kind === 'pools' || format.kind === 'playoff-pools') {
    return generatePoolRound(state, phase, scheduleOptions);
  }
  return failedGenerationResult(
    state,
    scheduleOptions,
    'unsupported-format',
    `${format.name} is not implemented in Director yet; generation is disabled.`,
  );
}

function failedGenerationResult(
  state: DirectorState,
  options: ScheduleOptions,
  code:
    | 'missing-format'
    | 'missing-phase'
    | 'missing-pools'
    | 'format-complete'
    | 'unsupported-format'
    | 'invalid-generation',
  message: string,
): ScheduleGenerationResult {
  return buildGenerationResult(
    newDirectorId('round'),
    options.roundNumber ?? nextRoundNumber(state),
    options,
    [],
    [{ code, severity: 'error', message }],
  );
}

function generatePoolRound(
  state: DirectorState,
  phase: Phase,
  options: ScheduleOptions,
): ScheduleGenerationResult {
  const phaseRoundCount = state.rounds.filter((round) => round.phaseId === phase.id).length;
  if (
    options.roundsPerTeam !== null &&
    options.roundsPerTeam !== undefined &&
    phaseRoundCount >= options.roundsPerTeam
  ) {
    return failedGenerationResult(
      state,
      options,
      'format-complete',
      `This format has reached its configured limit of ${options.roundsPerTeam} round${options.roundsPerTeam === 1 ? '' : 's'} per team.`,
    );
  }
  const pools = state.pools
    .filter((pool) => phase.poolIds.includes(pool.id))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  if (pools.length === 0) {
    return failedGenerationResult(
      state,
      options,
      'missing-pools',
      'This pool format has no configured pools; generation is disabled until pools are configured.',
    );
  }

  const teamsById = new Map(state.teams.map((team) => [team.id, team]));
  const confirmedTeamIds = state.teams.filter((team) => team.status === 'confirmed').map((team) => team.id);
  const poolTeamIds = pools.flatMap((pool) => pool.teamIds);
  const poolTeamCounts = new Map<DirectorId, number>();
  for (const teamId of poolTeamIds) poolTeamCounts.set(teamId, (poolTeamCounts.get(teamId) ?? 0) + 1);
  const format = currentFormat(state);
  const expectedTeamIds = format?.kind === 'playoff-pools' ? [...new Set(poolTeamIds)] : confirmedTeamIds;
  const missingFromPools = expectedTeamIds.filter((teamId) => !poolTeamCounts.has(teamId));
  const duplicatePoolTeams = [...poolTeamCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([teamId]) => teamId);
  const conflicts: ScheduleConflict[] = [];
  if (missingFromPools.length > 0) {
    conflicts.push({
      code: 'invalid-generation',
      severity: 'error',
      message: `Confirmed teams are not assigned to a pool: ${missingFromPools
        .map((teamId) => teamsById.get(teamId)?.displayName ?? teamId)
        .join(', ')}.`,
      teamIds: missingFromPools,
    });
  }
  if (duplicatePoolTeams.length > 0) {
    conflicts.push({
      code: 'invalid-generation',
      severity: 'error',
      message: `A confirmed team is assigned to more than one pool: ${duplicatePoolTeams
        .map((teamId) => teamsById.get(teamId)?.displayName ?? teamId)
        .join(', ')}.`,
      teamIds: duplicatePoolTeams,
    });
  }
  const activeTeamsByPool = pools.map((pool) => ({
    pool,
    teams: pool.teamIds
      .map((teamId) => teamsById.get(teamId))
      .filter((team): team is Team => team?.status === 'confirmed'),
  }));
  const expectedTeams = activeTeamsByPool.flatMap(({ teams }) => teams);
  const expectedByeCount = activeTeamsByPool.reduce((count, { teams }) => count + (teams.length % 2), 0);
  for (const { pool, teams } of activeTeamsByPool) {
    if (teams.length === 0) {
      conflicts.push({
        code: 'invalid-generation',
        severity: 'error',
        message: `Pool ${pool.name} has no confirmed teams.`,
        teamIds: pool.teamIds,
      });
    }
    const missing = pool.teamIds.filter((teamId) => !teams.some((team) => team.id === teamId));
    if (missing.length > 0) {
      conflicts.push({
        code: 'invalid-generation',
        severity: 'error',
        message: `Pool ${pool.name} contains teams that are missing or not confirmed.`,
        teamIds: missing,
      });
    }
    if (teams.length % 2 === 1 && options.allowByes === false) {
      conflicts.push({
        code: 'no-bye-allowed',
        severity: 'error',
        message: `Pool ${pool.name} needs a bye, but byes are disabled.`,
      });
    }
  }
  if (conflicts.some((conflict) => conflict.severity === 'error')) {
    return failedGenerationResultWithConflicts(state, options, conflicts);
  }

  const resolvedRoundNumber = options.roundNumber ?? nextRoundNumber(state);
  const roomIds = options.roomIds ?? assignableRoomIds(state);
  let roomIndex = 0;
  const games: ScheduledGame[] = [];
  for (const { pool, teams } of activeTeamsByPool) {
    const pairings = pairRoundRobinTeams(state, teams, { ...options, poolId: pool.id }, resolvedRoundNumber);
    if (!pairings) {
      conflicts.push({
        code: 'invalid-generation',
        severity: 'error',
        message: `No complete valid pairing could be generated for pool ${pool.name}.`,
        teamIds: teams.map((team) => team.id),
      });
      continue;
    }
    appendPairingConflicts(conflicts, state, pairings, options, false);
    for (const [left, right] of pairings) {
      const game = buildGame(resolvedRoundNumber, left?.id ?? '', right?.id ?? null, {
        ...options,
        poolId: pool.id,
      });
      if (!game.bye) {
        game.roomId = roomIds[roomIndex] ?? null;
        roomIndex += 1;
      }
      games.push(game);
    }
  }
  if (roomIndex > roomIds.length) {
    conflicts.push({
      code: 'not-enough-rooms',
      severity: 'warning',
      message: `${roomIndex} games need rooms, but only ${roomIds.length} are available.`,
    });
  }
  const round = buildGenerationResult(
    newDirectorId('round'),
    options.roundNumber ?? nextRoundNumber(state),
    { ...options, phaseId: phase.id },
    games,
    conflicts,
    expectedTeams,
    expectedByeCount,
  );
  for (const { pool, teams } of activeTeamsByPool) {
    const poolGames = games.filter((game) => game.poolId === pool.id);
    if (!scheduleIsValid(poolGames, teams, { expectedByeCount: teams.length % 2 })) {
      round.conflicts.push({
        code: 'invalid-generation',
        severity: 'error',
        message: `Pool ${pool.name} failed structural schedule validation and was discarded.`,
        teamIds: teams.map((team) => team.id),
      });
    }
  }
  if (round.conflicts.some((conflict) => conflict.severity === 'error')) {
    return { ...round, round: { ...round.round, scheduledGameIds: [] }, games: [], hardFailure: true };
  }
  return round;
}

function failedGenerationResultWithConflicts(
  state: DirectorState,
  options: ScheduleOptions,
  conflicts: ScheduleConflict[],
): ScheduleGenerationResult {
  return buildGenerationResult(
    newDirectorId('round'),
    options.roundNumber ?? nextRoundNumber(state),
    options,
    [],
    conflicts,
  );
}

export function scheduleGameCount(games: ScheduledGame[]): number {
  return games.filter((game) => !game.bye && game.status !== 'cancelled').length;
}

function assignableRoomIds(state: DirectorState): DirectorId[] {
  return state.rooms.filter((room) => room.available && room.status === 'available').map((room) => room.id);
}

function roundRobinCycleLength(teamCount: number): number {
  return teamCount % 2 === 0 ? Math.max(0, teamCount - 1) : teamCount;
}

export function scheduleIsValid(
  games: ScheduledGame[],
  expectedTeams: readonly Team[] = [],
  options: { allowByes?: boolean; expectedByeCount?: number } = {},
): boolean {
  const gameIds = new Set<DirectorId>();
  const teams = new Set<DirectorId>();
  const byes = new Set<DirectorId>();
  const expectedTeamIds = new Set(expectedTeams.map((team) => team.id));
  if (expectedTeamIds.size !== expectedTeams.length) return false;
  for (const game of games) {
    if (!game.id || gameIds.has(game.id)) return false;
    gameIds.add(game.id);
    if (!game.leftTeamId) return false;
    if (game.bye) {
      if (game.rightTeamId !== null || byes.has(game.leftTeamId) || teams.has(game.leftTeamId)) return false;
      byes.add(game.leftTeamId);
      continue;
    }
    if (!game.rightTeamId || game.leftTeamId === game.rightTeamId) return false;
    if (teams.has(game.leftTeamId) || teams.has(game.rightTeamId)) return false;
    if (byes.has(game.leftTeamId) || byes.has(game.rightTeamId)) return false;
    teams.add(game.leftTeamId);
    teams.add(game.rightTeamId);
  }
  if (options.allowByes === false && byes.size > 0) return false;
  if (expectedTeams.length > 0) {
    if (games.length === 0) return false;
    const allParticipants = new Set([...teams, ...byes]);
    if (allParticipants.size !== expectedTeamIds.size) return false;
    if ([...allParticipants].some((teamId) => !expectedTeamIds.has(teamId))) return false;
    if (byes.size !== (options.expectedByeCount ?? expectedTeams.length % 2)) return false;
  }
  return true;
}

export function closeRound(round: Round, at = isoNow()): Round {
  return { ...round, status: 'closed', closedAt: at };
}
