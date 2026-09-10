import {
  type DirectorId,
  type DirectorState,
  type FormatDefinition,
  type Phase,
  type Pool,
  type Round,
  type RoundDeliveryMode,
  type ScheduledGame,
  type Team,
  type BracketState,
  newDirectorId,
  isoNow,
} from './model';
import { activePhaseTeams, activeTournamentTeams, phaseCompetitiveField } from './field';
import {
  generateRoundRobinSchedule,
  planSingleEliminationBracket,
  placeBracketRounds,
  resolveBracket,
  type BracketGameOutcome,
  type BracketNode,
  type BracketPlan,
  type ResolvedBracket,
  pairQuizbowlSwiss,
  type QuizbowlSwissPairing,
  type ScheduledGame as CoreScheduledGame,
  type Team as CoreTeam,
} from '@qbsheet/tournament-core';
import { acceptedGameRecords, deriveTeamStandings, type TeamStanding } from './stats';
import { nextDayOrder } from '@qbsheet/tournament-domain';

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
  manualPairings?: QuizbowlSwissPairing[];
  allowIncomplete?: boolean;
  formatKind?: 'round-robin' | 'double-round-robin';
  roundsPerTeam?: number | null;
  seed?: number;
  /**
   * Day-sequence position for the generated round. `generateDirectorRound`
   * stamps the next open position; every construction path funnels through
   * `buildGenerationResult`, so generated rounds never land without one.
   */
  dayOrder?: number | null;
  deliveryMode?: RoundDeliveryMode;
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
    | 'invalid-generation'
    | 'dropped-team'
    | 'incomplete-standings'
    | 'record-float'
    | 'bye'
    | 'manual-override';
  severity: 'error' | 'warning';
  message: string;
  teamIds?: DirectorId[];
}

export interface ScheduleGenerationResult {
  round: Round;
  games: ScheduledGame[];
  conflicts: ScheduleConflict[];
  hardFailure: boolean;
  /** Updated structural state for a dependent format; the controller persists it with the round. */
  bracket?: BracketState;
}

export interface FormatGenerationAvailability {
  supported: boolean;
  terminal: boolean;
  reason:
    | 'available'
    | 'missing-format'
    | 'tournament-closed'
    | 'missing-phase'
    | 'too-few-teams'
    | 'phase-complete'
    | 'missing-pools'
    | 'invalid-state'
    | 'configured-limit-reached'
    | 'format-complete'
    | 'unsupported-format';
  message: string;
}

export interface FormatDistance {
  /** The competitive endpoint, or null when the format needs an explicit decision. */
  requiredRounds: number | null;
  /** Rounds currently materialized for this phase, including planned rounds. */
  generatedRounds: number;
  /** Materialized rounds that have reached the closed state. */
  closedRounds: number;
  /** True only when a known endpoint has been materialized. */
  exhausted: boolean;
}

/**
 * Resolve the persisted bracket using only accepted/forfeit results whose assigned participants
 * still agree with the bracket. This is the shared source of truth for generation, validation,
 * correction, and phase completion.
 */
export function resolveDirectorBracket(state: DirectorState, formatId: DirectorId): ResolvedBracket | null {
  const format = state.formats.find((entry) => entry.id === formatId);
  return format?.kind === 'single-elimination' && format.bracket
    ? resolveBracketState(state, format.bracket)
    : null;
}

/**
 * Return the format distance for a phase. This is deliberately shared by generation and
 * completion: an absent future round is not evidence that an incremental format is exhausted.
 */
export function formatDistance(state: DirectorState, phaseId: DirectorId): FormatDistance {
  const phase = state.phases.find((entry) => entry.id === phaseId);
  const format = phase ? state.formats.find((entry) => entry.id === phase.formatId) : undefined;
  const rounds = state.rounds.filter((round) => round.phaseId === phaseId);
  const generatedRounds = rounds.length;
  const closedRounds = rounds.filter((round) => round.status === 'closed').length;
  if (!phase || !format) {
    return { requiredRounds: null, generatedRounds, closedRounds, exhausted: false };
  }

  const phaseField = phaseCompetitiveField(state, phaseId);
  const confirmedCount = phaseField.teams.length;
  const cycleLength = roundRobinCycleLength(confirmedCount);
  let requiredRounds: number | null;
  switch (format.kind) {
    case 'round-robin':
      requiredRounds = Math.min(format.roundsPerTeam ?? cycleLength, cycleLength);
      break;
    case 'double-round-robin':
      requiredRounds = Math.min(format.roundsPerTeam ?? cycleLength * 2, cycleLength * 2);
      break;
    case 'pools':
    case 'playoff-pools': {
      const pools = state.pools.filter((pool) => phase.poolIds.includes(pool.id) && pool.archived !== true);
      const teamsById = new Map(state.teams.map((team) => [team.id, team]));
      const naturalLimit =
        pools.length > 0
          ? Math.max(
              ...pools.map((pool) =>
                roundRobinCycleLength(
                  pool.teamIds.filter((teamId) => teamsById.get(teamId)?.status === 'confirmed').length,
                ),
              ),
            )
          : 0;
      const hasUnassignedPlannedRound = rounds.some(
        (round) => round.status === 'planned' && round.scheduledGameIds.length === 0,
      );
      requiredRounds =
        format.roundsPerTeam !== null
          ? Math.min(format.roundsPerTeam, naturalLimit || format.roundsPerTeam)
          : hasUnassignedPlannedRound
            ? null
            : naturalLimit > 0
              ? naturalLimit
              : null;
      break;
    }
    case 'swiss':
    case 'custom':
      requiredRounds = format.roundsPerTeam;
      break;
    case 'single-elimination':
      requiredRounds = null;
      break;
  }

  return {
    requiredRounds,
    generatedRounds,
    closedRounds,
    exhausted: requiredRounds !== null && generatedRounds >= requiredRounds,
  };
}

function phaseFormatCompletionBlocker(state: DirectorState, phase: Phase): string {
  const distance = formatDistance(state, phase.id);
  if (distance.requiredRounds === null) {
    return `${phase.name} has no configured automatic completion distance; explicitly complete the phase before completing the tournament.`;
  }
  if (!distance.exhausted) {
    return `${phase.name} requires ${distance.requiredRounds} rounds, but only ${distance.generatedRounds} have been generated.`;
  }
  return `${phase.name} has not reached a valid completion state.`;
}

/** A phase is complete only when its generated rounds are closed and its format is complete. */
export function phaseCanComplete(state: DirectorState, phaseId: DirectorId): boolean {
  const phase = state.phases.find((entry) => entry.id === phaseId);
  if (!phase || phase.roundIds.length === 0) return false;
  if (!phase.roundIds.every((id) => state.rounds.find((round) => round.id === id)?.status === 'closed')) {
    return false;
  }
  // A historical/imported document may already contain a falsely closed round. Do not let that
  // lifecycle flag complete its phase while the round still has operational work underneath it.
  if (phase.roundIds.some((id) => roundCloseBlockers(state, id).length > 0)) return false;
  const format = state.formats.find((entry) => entry.id === phase.formatId);
  if (format?.kind === 'single-elimination') {
    return resolveDirectorBracket(state, format.id)?.complete === true;
  }
  if (format?.kind === 'round-robin' || format?.kind === 'double-round-robin') {
    return roundRobinFormatComplete(state, phase, format);
  }
  if (
    (format?.kind === 'pools' || format?.kind === 'playoff-pools' || format?.kind === 'swiss') &&
    format.roundsPerTeam !== null
  ) {
    return phase.roundIds.length >= format.roundsPerTeam;
  }
  return formatDistance(state, phase.id).exhausted;
}

/**
 * The canonical blockers for the authoritative tournament-complete transition. Keep operational
 * guards here alongside format-distance guards so callers cannot accidentally use a weaker scan.
 */
export function tournamentCompletionBlockers(state: DirectorState): string[] {
  const blockers: string[] = [];
  if (!state.tournament) return ['Create a tournament before completing it.'];
  if (state.rounds.length === 0)
    return ['Generate and resolve at least one round before completing the tournament.'];
  if (state.rounds.some((round) => round.status !== 'closed')) {
    blockers.push('Every generated round must be closed before completing the tournament.');
  }
  if (state.scheduledGames.some((game) => !game.bye && !['accepted', 'cancelled'].includes(game.status))) {
    blockers.push(
      'Every competitive game must have an accepted result or be cancelled before completing the tournament.',
    );
  }
  if (
    state.submissions.some((submission) => submission.status === 'received' || submission.status === 'review')
  ) {
    blockers.push('Resolve every received or under-review submission before completing the tournament.');
  }
  if (state.protests.some((protest) => protest.status === 'open')) {
    blockers.push('Resolve every open protest before completing the tournament.');
  }
  if (state.qbtcpHelpRequests.some((request) => request.status === 'open')) {
    blockers.push('Resolve every open room-help request before completing the tournament.');
  }
  if (state.qbtcpRosterAmendments.some((amendment) => amendment.status === 'pending')) {
    blockers.push('Resolve every pending roster amendment before completing the tournament.');
  }
  for (const phase of state.phases.filter((entry) => entry.archived !== true)) {
    if (!phaseCanComplete(state, phase.id)) blockers.push(phaseFormatCompletionBlocker(state, phase));
  }
  return blockers;
}

function roundRobinFormatComplete(state: DirectorState, phase: Phase, format: FormatDefinition): boolean {
  const teams = activeTournamentTeams(state);
  const phaseRoundCount = state.rounds.filter((round) => round.phaseId === phase.id).length;
  const cycleLength = roundRobinCycleLength(teams.length);
  if (format.kind === 'round-robin') {
    if (format.roundsPerTeam !== null) return phaseRoundCount >= format.roundsPerTeam;
    return roundRobinPairingsComplete(state, phase.id, teams, 1);
  }
  const naturalLimit = cycleLength * 2;
  if (phaseRoundCount >= Math.min(format.roundsPerTeam ?? naturalLimit, naturalLimit)) return true;
  return roundRobinPairingsComplete(state, phase.id, teams, 2);
}

export function currentFormat(state: DirectorState): FormatDefinition | null {
  const formatId = state.tournament?.formatId;
  return formatId ? (state.formats.find((format) => format.id === formatId) ?? null) : null;
}

export function currentPhase(state: DirectorState): Phase | null {
  const phaseId = state.tournament?.currentPhaseId;
  if (phaseId) return state.phases.find((phase) => phase.id === phaseId && phase.archived !== true) ?? null;
  const currentRoundId = state.tournament?.currentRoundId;
  if (!currentRoundId) return null;
  const round = state.rounds.find((candidate) => candidate.id === currentRoundId);
  return round
    ? (state.phases.find((phase) => phase.id === round.phaseId && phase.archived !== true) ?? null)
    : null;
}

export function currentPacket(state: DirectorState): DirectorState['packets'][number] | null {
  const packetId = state.tournament?.currentPacketId;
  return packetId
    ? (state.packets.find((packet) => packet.id === packetId && packet.retired !== true) ?? null)
    : null;
}

export function formatGenerationAvailability(state: DirectorState): FormatGenerationAvailability {
  const format = currentFormat(state);
  if (!format)
    return {
      supported: false,
      terminal: false,
      reason: 'missing-format',
      message: 'Choose a valid current format before generating.',
    };
  if (state.tournament?.status === 'complete' || state.tournament?.status === 'archived') {
    return {
      supported: false,
      terminal: true,
      reason: 'tournament-closed',
      message: `This tournament is ${state.tournament.status}; schedule generation is disabled.`,
    };
  }
  const phase = currentPhase(state);
  if (!phase || phase.formatId !== format.id) {
    return {
      supported: false,
      terminal: false,
      reason: 'missing-phase',
      message: 'Choose a valid current phase for this format before generating.',
    };
  }
  const phaseField = phaseCompetitiveField(state, phase.id);
  const hasLockedEliminationBracket = format.kind === 'single-elimination' && format.bracket !== undefined;
  if (!hasLockedEliminationBracket && phaseField.issues.length > 0) {
    return {
      supported: false,
      terminal: false,
      reason: 'invalid-state',
      message: phaseField.issues[0] ?? 'Set the phase competitive field before generating.',
    };
  }
  const fieldCount = hasLockedEliminationBracket ? (format.bracket?.teamCount ?? 0) : phaseField.teams.length;
  if (!hasLockedEliminationBracket && fieldCount < 2) {
    return {
      supported: false,
      terminal: false,
      reason: 'too-few-teams',
      message: 'Add at least two confirmed teams before generating a round.',
    };
  }
  if (phase.status === 'complete' && !canRecoverIncompleteEliminationPhase(state, phase, format)) {
    return {
      supported: false,
      terminal: true,
      reason: 'phase-complete',
      message: 'This phase is complete; select or add another phase for additional play.',
    };
  }
  if (format.kind === 'pools' || format.kind === 'playoff-pools') {
    const pools = state.pools.filter((pool) => phase.poolIds.includes(pool.id) && pool.archived !== true);
    if (pools.length === 0) {
      return {
        supported: false,
        terminal: false,
        reason: 'missing-pools',
        message: 'Configure at least one pool before generating this format.',
      };
    }
    const configurationProblem = poolConfigurationProblem(
      state,
      phase,
      pools,
      format.allowByes,
      format.kind !== 'playoff-pools',
    );
    if (configurationProblem)
      return { supported: false, terminal: false, reason: 'invalid-state', message: configurationProblem };
    const distance = formatDistance(state, phase.id);
    if (distance.exhausted) {
      return {
        supported: false,
        terminal: true,
        reason: format.roundsPerTeam === null ? 'format-complete' : 'configured-limit-reached',
        message:
          format.roundsPerTeam === null
            ? 'This pool round robin is complete; add a new phase for additional play.'
            : `This format has reached its configured limit of ${distance.requiredRounds} round${distance.requiredRounds === 1 ? '' : 's'} per team.`,
      };
    }
    return {
      supported: true,
      terminal: false,
      reason: 'available',
      message: 'Pool round-robin generation is available for this phase.',
    };
  }
  if (format.kind === 'round-robin' || format.kind === 'double-round-robin') {
    const phaseRoundCount = state.rounds.filter((round) => round.phaseId === phase.id).length;
    const cycleLength = roundRobinCycleLength(fieldCount);
    const naturalLimit = format.kind === 'double-round-robin' ? cycleLength * 2 : cycleLength;
    const maximumRoundCount =
      format.kind === 'round-robin'
        ? (format.roundsPerTeam ?? naturalLimit)
        : Math.min(format.roundsPerTeam ?? naturalLimit, naturalLimit);
    const pairingsComplete = roundRobinPairingsComplete(
      state,
      phase.id,
      phaseField.teams,
      format.kind === 'double-round-robin' ? 2 : 1,
    );
    const naturallyComplete =
      format.kind === 'round-robin' && format.roundsPerTeam === null
        ? pairingsComplete
        : format.kind === 'double-round-robin'
          ? pairingsComplete
          : false;
    if (naturallyComplete || phaseRoundCount >= maximumRoundCount) {
      const configuredLimit = format.kind === 'round-robin' && format.roundsPerTeam !== null;
      if (naturallyComplete && format.kind === 'round-robin') {
        return {
          supported: false,
          terminal: true,
          reason: 'format-complete',
          message: 'This single round robin is complete; every active team has played every other team once.',
        };
      }
      if (format.kind === 'double-round-robin' && phaseRoundCount >= naturalLimit) {
        return {
          supported: false,
          terminal: true,
          reason: 'format-complete',
          message: 'This double round robin is complete; add a new phase for additional play.',
        };
      }
      return {
        supported: false,
        terminal: true,
        reason: configuredLimit ? 'configured-limit-reached' : 'format-complete',
        message: `This format has reached its configured limit of ${maximumRoundCount} round${maximumRoundCount === 1 ? '' : 's'} per team.`,
      };
    }
    return {
      supported: true,
      terminal: false,
      reason: 'available',
      message: 'Round-robin generation is available for this format.',
    };
  }
  if (format.kind === 'single-elimination') {
    return {
      supported: true,
      terminal: false,
      reason: 'available',
      message: 'Seeded single-elimination generation is available.',
    };
  }
  if (format.kind === 'swiss') {
    const distance = formatDistance(state, phase.id);
    if (distance.exhausted) {
      return {
        supported: false,
        terminal: true,
        reason: 'configured-limit-reached',
        message: `This Swiss phase has reached its configured limit of ${distance.requiredRounds} rounds; add a new phase for additional play.`,
      };
    }
    return {
      supported: true,
      terminal: false,
      reason: 'available',
      message: 'Quizbowl Swiss pairing is available after the previous round is settled.',
    };
  }
  if (format.kind === 'custom') {
    const distance = formatDistance(state, phase.id);
    if (distance.exhausted) {
      return {
        supported: false,
        terminal: true,
        reason: 'configured-limit-reached',
        message: `This format has reached its configured limit of ${distance.requiredRounds} rounds per team.`,
      };
    }
    return {
      supported: true,
      terminal: false,
      reason: 'available',
      message: 'Create a manual round from the pairing builder below.',
    };
  }
  return {
    supported: false,
    terminal: false,
    reason: 'unsupported-format',
    message: `${format.name} is not implemented in Director yet; generation is disabled.`,
  };
}

function canRecoverIncompleteEliminationPhase(
  state: DirectorState,
  phase: Phase,
  format: FormatDefinition,
): boolean {
  return format.kind === 'single-elimination' && !phaseCanComplete(state, phase.id);
}

function poolConfigurationProblem(
  state: DirectorState,
  phase: Phase,
  pools: Pool[],
  allowByes: boolean,
  requireAllConfirmedTeams: boolean,
): string | null {
  const teamsById = new Map(state.teams.map((team) => [team.id, team]));
  const confirmedTeamIds = activeTournamentTeams(state).map((team) => team.id);
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
    const confirmed = pool.teamIds.filter((teamId) => confirmedTeamIds.includes(teamId));
    const invalid = pool.teamIds.filter((teamId) => {
      const team = teamsById.get(teamId);
      return !team || (team.status !== 'confirmed' && team.status !== 'dropped');
    });
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

function activeTeams(state: DirectorState, seed?: number, phaseId?: DirectorId): Team[] {
  const teams = phaseId === undefined ? activeTournamentTeams(state) : activePhaseTeams(state, phaseId);
  if (seed === undefined) return [...teams].sort((a, b) => (a.seed ?? 9999) - (b.seed ?? 9999));
  const random = seededRandom(seed);
  return [...teams]
    .map((team) => ({ team, sort: random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ team }) => team);
}

function hasPlayed(
  state: DirectorState,
  leftId: DirectorId,
  rightId: DirectorId,
  phaseId?: DirectorId,
): boolean {
  return state.scheduledGames.some(
    (game) =>
      game.status !== 'cancelled' &&
      (!phaseId || state.rounds.find((round) => round.id === game.roundId)?.phaseId === phaseId) &&
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
  const formatKind = options.formatKind ?? 'round-robin';
  const field = options.phaseId ? phaseCompetitiveField(state, options.phaseId) : null;
  if (field && field.issues.length > 0) {
    return failedGenerationResult(
      state,
      options,
      'invalid-generation',
      field.issues[0] ?? 'Set the phase competitive field before generating a round.',
    );
  }
  const teams = activeTeams(state, options.seed, options.phaseId);
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
  const naturalLimit = formatKind === 'double-round-robin' ? cycleLength * 2 : cycleLength;
  const maximumRoundCount =
    formatKind === 'round-robin'
      ? (options.roundsPerTeam ?? naturalLimit)
      : Math.min(options.roundsPerTeam ?? naturalLimit, naturalLimit);
  const repeatedRoundRobin =
    formatKind === 'double-round-robin' ||
    (formatKind === 'round-robin' &&
      options.roundsPerTeam !== null &&
      options.roundsPerTeam !== undefined &&
      options.roundsPerTeam > cycleLength);
  const naturallyComplete =
    formatKind === 'round-robin' && options.roundsPerTeam == null
      ? roundRobinPairingsComplete(state, options.phaseId, teams, 1)
      : formatKind === 'double-round-robin'
        ? roundRobinPairingsComplete(state, options.phaseId, teams, 2)
        : false;
  if (naturallyComplete || roundIndex >= maximumRoundCount) {
    if (formatKind === 'double-round-robin' && roundIndex >= cycleLength * 2) {
      conflicts.push({
        code: 'format-complete',
        severity: 'error',
        message: 'This double round robin already contains both complete rotations.',
      });
      return buildGenerationResult(roundId, roundNumber, options, [], conflicts);
    }
    conflicts.push({
      code: 'format-complete',
      severity: 'error',
      message:
        formatKind === 'round-robin' && options.roundsPerTeam == null
          ? 'This single round robin is complete; every active team has played every other team once.'
          : `This format has reached its configured limit of ${maximumRoundCount} round${maximumRoundCount === 1 ? '' : 's'} per team.`,
    });
    return buildGenerationResult(roundId, roundNumber, options, [], conflicts);
  }
  const intentionalRematch = repeatedRoundRobin && roundIndex >= cycleLength;
  const firstCycleOptions =
    repeatedRoundRobin && !intentionalRematch ? { ...options, avoidRematches: true } : options;
  const pairings = intentionalRematch
    ? (repeatRoundPairings(state, teams, phaseRounds[roundIndex - cycleLength]) ??
      pairRoundRobinTeams(state, teams, options, roundIndex))
    : pairRoundRobinTeams(state, teams, firstCycleOptions, roundIndex);
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
  roundIndex: number,
): Array<[Team | null, Team | null]> | null {
  if (
    options.formatKind === 'round-robin' &&
    options.poolId == null &&
    options.roundsPerTeam == null &&
    !options.avoidSameOrganization
  ) {
    const canonical = coreRoundPairings(teams, options.phaseId ?? 'director-phase', undefined, roundIndex);
    if (
      canonical &&
      canonical.every(
        ([left, right]) => !right || !hasPlayed(state, left?.id ?? '', right.id, options.phaseId),
      )
    ) {
      return canonical;
    }
  }
  const useConstraints = Boolean(options.avoidRematches || options.avoidSameOrganization);
  const constrained = useConstraints
    ? findCompleteMatching(teams, (left, right) => legalPair(state, left, right, options))
    : null;
  if (constrained) return constrained;

  // The tested tournament-core scheduler supplies the deterministic baseline when no complete
  // constraint solution exists. We still validate and adapt its output before it reaches Director.
  const corePairings = coreRoundPairings(teams, options.phaseId ?? 'director-phase', options.seed);
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
    if (
      options.avoidRematches &&
      hasPlayed(state, left.id, right.id, options.phaseId) &&
      !intentionalRematch
    ) {
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
        message: `${left.displayName} and ${right.displayName} share a school or club because no fully constrained pairing was available.`,
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
  if (options.avoidRematches && hasPlayed(state, left.id, right.id, options.phaseId)) return false;
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
  seed: number | undefined,
  roundIndex = 0,
): Array<[Team | null, Team | null]> | null {
  const byId = new Map(teams.map((team) => [team.id, team]));
  const teamOrder = new Map(teams.map((team, index) => [team.id, index]));
  const currentRoundId = `${phaseId}-canonical-round-${roundIndex + 1}`;
  const schedule = generateRoundRobinSchedule({
    phaseId,
    teams: teams.map(toCoreTeam),
    roomIds: [],
    rounds: Array.from({ length: roundIndex + 1 }, (_, index) => ({
      id: index === roundIndex ? currentRoundId : `${phaseId}-canonical-round-${index + 1}`,
      number: index + 1,
    })),
    roundCount: roundIndex + 1,
    seed: seed ?? phaseId,
    rematchPolicy: 'forbid',
  });
  const currentPairings = schedule.games
    .filter((game) => game.roundId === currentRoundId)
    .map((game: CoreScheduledGame): [Team | null, Team | null] => {
      if (game.kind === 'bye') return [byId.get(game.byeTeamId) ?? null, null];
      const left = byId.get(game.teamAId) ?? null;
      const right = byId.get(game.teamBId) ?? null;
      return (teamOrder.get(left?.id ?? '') ?? 0) <= (teamOrder.get(right?.id ?? '') ?? 0)
        ? [left, right]
        : [right, left];
    });
  return currentPairings.length > 0 ? currentPairings : null;
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
    dayOrder: options.dayOrder ?? null,
    scheduledStart: null,
    releasedAt: null,
    startedAt: null,
    closedAt: null,
    ...(options.deliveryMode ? { deliveryMode: options.deliveryMode } : {}),
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
  options: Pick<
    ScheduleOptions,
    | 'seed'
    | 'avoidRematches'
    | 'avoidSameOrganization'
    | 'roundName'
    | 'packetId'
    | 'manualPairings'
    | 'allowIncomplete'
    | 'dayOrder'
    | 'deliveryMode'
  > = {},
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
  if (phase.status === 'complete' && !canRecoverIncompleteEliminationPhase(state, phase, format)) {
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
    // Generated rounds append at the end of the tournament day; the director
    // reorders from Rounds afterwards. Explicit callers may override.
    dayOrder: options.dayOrder ?? nextDayOrder(state.rounds, state.timeline),
    phaseId: phase.id,
    packetId: options.packetId ?? packet?.id ?? null,
    formatKind: format.kind === 'double-round-robin' ? 'double-round-robin' : 'round-robin',
    roundsPerTeam: format.roundsPerTeam,
    avoidRematches: options.avoidRematches ?? format.avoidRematches,
    avoidSameOrganization: options.avoidSameOrganization ?? format.avoidSameOrganization,
    allowByes: format.allowByes,
    // A generated round is manual unless the operator explicitly selects a transport. A room
    // assignment remains a legacy signal for imported/older documents via effectiveRoundDeliveryMode.
    ...(options.deliveryMode ? { deliveryMode: options.deliveryMode } : {}),
  };

  if (format.kind === 'round-robin' || format.kind === 'double-round-robin') {
    return generateRoundRobinRound(state, scheduleOptions);
  }
  if (format.kind === 'pools' || format.kind === 'playoff-pools') {
    return generatePoolRound(state, phase, scheduleOptions);
  }
  if (format.kind === 'single-elimination') {
    return generateSingleEliminationRound(state, phase.id, format.id, scheduleOptions);
  }
  if (format.kind === 'swiss') {
    return generateSwissRound(state, phase.id, scheduleOptions);
  }
  if (format.kind === 'custom') {
    return generateManualRound(state, phase.id, scheduleOptions);
  }
  return failedGenerationResult(
    state,
    scheduleOptions,
    'unsupported-format',
    `${format.name} is not implemented in Director yet; generation is disabled.`,
  );
}

/**
 * Adapt the canonical Director document into quizbowl power matching. A dependent Swiss round is
 * blocked while its previous round is unresolved; a manual pairing list is the explicit director
 * decision that permits an exception and is retained in the generated round's audit details.
 */
function generateSwissRound(
  state: DirectorState,
  phaseId: DirectorId,
  options: ScheduleOptions,
): ScheduleGenerationResult {
  const phase = state.phases.find((entry) => entry.id === phaseId);
  const distance = formatDistance(state, phaseId);
  const phaseRounds = state.rounds
    .filter((round) => round.phaseId === phaseId)
    .sort((left, right) => left.number - right.number || left.id.localeCompare(right.id));
  if (distance.exhausted) {
    return failedGenerationResult(
      state,
      options,
      'format-complete',
      `This Swiss phase has reached its configured limit of ${distance.requiredRounds} rounds; add a new phase for additional play.`,
    );
  }
  const previousRound = phaseRounds.at(-1);
  if (previousRound && previousRound.status !== 'closed' && !options.manualPairings) {
    return failedGenerationResult(
      state,
      options,
      'invalid-generation',
      `Swiss generation is blocked until ${previousRound.name} is closed; resolve every result or choose a manual pairing override.`,
    );
  }
  if (!phase) {
    return failedGenerationResult(state, options, 'missing-phase', 'Choose a valid Swiss phase first.');
  }

  const field = phaseCompetitiveField(state, phaseId);
  if (field.issues.length > 0) {
    return failedGenerationResult(
      state,
      options,
      'invalid-generation',
      field.issues[0] ?? 'Set the phase competitive field before generating Swiss pairings.',
    );
  }
  const phaseTeams = field.teams;
  const phaseTeamIds = phaseTeams.map((team) => team.id);
  const standings = deriveTeamStandings(state, acceptedGameRecords(state, { phaseId }), {
    phaseId,
    teamIds: phaseTeamIds,
    includeDroppedTeams: true,
  });
  const standingById = new Map(standings.map((standing) => [standing.teamId, standing]));
  const previousOpponentIds = new Map<DirectorId, Set<DirectorId>>();
  for (const team of state.teams) previousOpponentIds.set(team.id, new Set());
  for (const game of state.scheduledGames) {
    const round = state.rounds.find((entry) => entry.id === game.roundId);
    if (!round || round.phaseId !== phaseId || game.status === 'cancelled' || game.bye || !game.rightTeamId) {
      continue;
    }
    previousOpponentIds.get(game.leftTeamId)?.add(game.rightTeamId);
    previousOpponentIds.get(game.rightTeamId)?.add(game.leftTeamId);
  }
  const swissTeams = phaseTeams.map((team) => {
    const standing = standingById.get(team.id) ?? emptyStanding(team.id);
    const byeCount = state.scheduledGames.filter((game) => {
      const round = state.rounds.find((entry) => entry.id === game.roundId);
      return round?.phaseId === phaseId && game.bye && game.leftTeamId === team.id;
    }).length;
    return {
      id: team.id,
      wins: standing.wins,
      losses: standing.losses,
      ties: standing.ties,
      pointsFor: standing.pointsFor,
      margin: standing.margin,
      seed: team.seed,
      organizationId: organizationId(state, team.id),
      previousOpponentIds: [...(previousOpponentIds.get(team.id) ?? [])],
      byeCount,
      dropped: team.status === 'dropped',
      incomplete: Boolean(previousRound && previousRound.status !== 'closed'),
    };
  });
  const pairing = pairQuizbowlSwiss(swissTeams, {
    avoidRematches: options.avoidRematches,
    avoidSameOrganization: options.avoidSameOrganization,
    allowByes: options.allowByes,
    manualPairings: options.manualPairings,
    allowIncomplete: Boolean(options.manualPairings || options.allowIncomplete),
  });
  const conflicts: ScheduleConflict[] = pairing.conflicts.map((conflict) => ({
    code: conflict.code as ScheduleConflict['code'],
    severity: conflict.severity,
    message: conflict.message,
    teamIds: conflict.teamIds ? [...conflict.teamIds] : undefined,
  }));
  if (pairing.hardFailure) {
    return buildGenerationResult(
      newDirectorId('round'),
      options.roundNumber ?? nextRoundNumber(state),
      { ...options, phaseId },
      [],
      conflicts,
    );
  }

  const roundNumber = options.roundNumber ?? nextRoundNumber(state);
  const roundId = newDirectorId('round');
  const games = pairing.pairings.map((entry) => {
    const game = buildGame(roundNumber, entry.leftTeamId, entry.rightTeamId, {
      ...options,
      phaseId,
      packetId: options.packetId ?? currentPacket(state)?.id ?? null,
    });
    if (entry.rightTeamId === null) game.status = 'accepted';
    return game;
  });
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
      message: `${roomIndex} Swiss games need rooms, but only ${roomIds.length} are available.`,
    });
  }
  return buildGenerationResult(
    roundId,
    roundNumber,
    { ...options, phaseId, roundName: options.roundName ?? `Swiss round ${phaseRounds.length + 1}` },
    games,
    conflicts,
    phaseTeams,
    phaseTeams.length % 2,
  );
}

function emptyStanding(teamId: DirectorId): TeamStanding {
  return {
    teamId,
    wins: 0,
    losses: 0,
    ties: 0,
    winPercentage: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    margin: 0,
    superpowers: 0,
    tossupsHeard: 0,
    tossupsHeardKnown: true,
    tossupsHeardRegulation: 0,
    tossupsHeardRegulationKnown: true,
    powers: 0,
    powersKnown: true,
    gets: 0,
    getsKnown: true,
    negs: 0,
    bonuses: 0,
    bonusPoints: 0,
    gamesPlayed: 0,
    headToHead: 0,
  };
}

/** Create a canonical manual round after validating the director's explicit pairings. */
function generateManualRound(
  state: DirectorState,
  phaseId: DirectorId,
  options: ScheduleOptions,
): ScheduleGenerationResult {
  if (!options.manualPairings || options.manualPairings.length === 0) {
    return failedGenerationResult(
      state,
      options,
      'invalid-generation',
      'Choose teams and pairings in the manual round builder before creating the round.',
    );
  }
  const field = phaseCompetitiveField(state, phaseId);
  if (field.issues.length > 0) {
    return failedGenerationResult(
      state,
      options,
      'invalid-generation',
      field.issues[0] ?? 'Set the phase competitive field before creating a manual round.',
    );
  }
  const confirmedById = new Map(field.teams.map((team) => [team.id, team]));
  const selectedIds = options.manualPairings.flatMap((pairing) =>
    pairing.rightTeamId === null ? [pairing.leftTeamId] : [pairing.leftTeamId, pairing.rightTeamId],
  );
  const selectedTeams = [...new Set(selectedIds)].map((teamId) => confirmedById.get(teamId));
  const conflicts: ScheduleConflict[] = [];
  if (selectedTeams.some((team): team is undefined => !team)) {
    conflicts.push({
      code: 'manual-override',
      severity: 'error',
      message: 'Manual pairings may contain only confirmed teams in the current phase.',
      teamIds: selectedIds.filter((teamId) => !confirmedById.has(teamId)),
    });
  }
  const expectedTeams = selectedTeams.filter((team): team is Team => Boolean(team));
  const games = options.manualPairings.map((pairing) =>
    buildGame(options.roundNumber ?? nextRoundNumber(state), pairing.leftTeamId, pairing.rightTeamId, {
      ...options,
      phaseId,
    }),
  );
  if (
    expectedTeams.length < 2 ||
    !scheduleIsValid(games, expectedTeams, {
      expectedByeCount: expectedTeams.length % 2,
      allowByes: options.allowByes,
    })
  ) {
    conflicts.push({
      code: 'invalid-generation',
      severity: 'error',
      message:
        'Manual pairings must place each selected team exactly once, with at most one bye for an odd field.',
      teamIds: selectedIds,
    });
  }
  if (conflicts.some((conflict) => conflict.severity === 'error')) {
    return buildGenerationResult(
      newDirectorId('round'),
      options.roundNumber ?? nextRoundNumber(state),
      { ...options, phaseId },
      [],
      conflicts,
    );
  }
  const roomIds = options.roomIds ?? assignableRoomIds(state);
  let roomIndex = 0;
  for (const game of games) {
    if (game.bye) {
      game.status = 'accepted';
      continue;
    }
    game.roomId = roomIds[roomIndex] ?? null;
    roomIndex += 1;
  }
  if (roomIndex > roomIds.length) {
    conflicts.push({
      code: 'not-enough-rooms',
      severity: 'warning',
      message: `${roomIndex} manual games need rooms, but only ${roomIds.length} are available.`,
    });
  }
  return buildGenerationResult(
    newDirectorId('round'),
    options.roundNumber ?? nextRoundNumber(state),
    { ...options, phaseId, roundName: options.roundName ?? `Manual round ${state.rounds.length + 1}` },
    games,
    conflicts,
    expectedTeams,
    expectedTeams.length % 2,
  );
}

/** Generate the next resolvable bracket slice from tournament-core's structural bracket. */
function generateSingleEliminationRound(
  state: DirectorState,
  phaseId: DirectorId,
  formatId: DirectorId,
  options: ScheduleOptions,
): ScheduleGenerationResult {
  const format = state.formats.find((entry) => entry.id === formatId);
  if (!format) {
    return failedGenerationResult(
      state,
      options,
      'invalid-generation',
      'A single-elimination bracket needs at least two confirmed teams.',
    );
  }
  // Never mutate the live React snapshot while deriving a preview. The controller commits this
  // structural state only together with the generated round.
  let bracket = format.bracket ? structuredClone(format.bracket) : undefined;
  if (bracket?.phaseId && bracket.phaseId !== phaseId) {
    return failedGenerationResult(
      state,
      options,
      'invalid-generation',
      'The persisted elimination bracket belongs to a different phase; create a new phase before generating.',
    );
  }
  if (!bracket) {
    const field = phaseCompetitiveField(state, phaseId);
    if (field.issues.length > 0) {
      return failedGenerationResult(
        state,
        options,
        'invalid-generation',
        field.issues[0] ?? 'Set the phase competitive field before drawing an elimination bracket.',
      );
    }
    const teams = [...field.teams].sort(
      (left, right) =>
        (left.seed ?? Number.MAX_SAFE_INTEGER) - (right.seed ?? Number.MAX_SAFE_INTEGER) ||
        left.displayName.localeCompare(right.displayName) ||
        left.id.localeCompare(right.id),
    );
    if (teams.length < 2) {
      return failedGenerationResult(
        state,
        options,
        'invalid-generation',
        'A single-elimination bracket needs at least two confirmed teams in this phase.',
      );
    }
    const seeding = assignBracketSeeds(teams);
    const plan = planSingleEliminationBracket(teams.length);
    const placement = placeBracketRounds(
      plan.roundCount,
      Array.from({ length: plan.roundCount }, (_, index) => nextRoundNumber(state) + index),
    );
    if (placement.issues.some((issue) => issue.severity === 'error')) {
      return failedGenerationResult(
        state,
        options,
        'invalid-generation',
        placement.issues.map((issue) => issue.message).join(' '),
      );
    }
    bracket = {
      phaseId,
      teamCount: plan.teamCount,
      bracketSize: plan.bracketSize,
      roundCount: plan.roundCount,
      seeding,
      nodes: plan.nodes.map((node) => ({
        key: node.key,
        roundIndex: node.roundIndex,
        sequence: node.sequence,
        label: node.label,
        kind: node.kind,
        slotA: { ...node.slotA },
        slotB: { ...node.slotB },
      })),
      byes: plan.byes.map((bye) => ({ ...bye })),
      roundNumbers: placement.placements.map((entry) => entry.roundNumber),
      roundIds: {},
    };
  }

  const resolved = resolveBracketState(state, bracket);
  const existingKeys = new Set(
    state.scheduledGames.flatMap((game) =>
      game.status !== 'cancelled' && game.bracketKey ? [game.bracketKey] : [],
    ),
  );
  const firstReadyRound = resolved.games
    .filter((game) => game.ready && !existingKeys.has(game.key))
    .sort((left, right) => left.roundIndex - right.roundIndex || left.sequence - right.sequence)
    .at(0)?.roundIndex;
  const byeRound =
    firstReadyRound ??
    resolved.byes.find((bye) => !existingKeys.has(bracketByeKey(bye.roundIndex, bye.seed)))?.roundIndex;
  const byeCandidates = resolved.byes.filter(
    (bye) => bye.roundIndex === byeRound && !existingKeys.has(bracketByeKey(bye.roundIndex, bye.seed)),
  );
  if (firstReadyRound === undefined && byeCandidates.length === 0) {
    const pending = resolved.games.some((game) => !game.ready && game.roundIndex < resolved.plan.roundCount);
    return failedGenerationResult(
      state,
      options,
      'format-complete',
      resolved.complete
        ? 'The single-elimination bracket is complete.'
        : pending
          ? 'The next bracket game is waiting for the preceding result.'
          : 'No new bracket game is available yet.',
    );
  }
  const roundIndex = firstReadyRound ?? byeCandidates[0]!.roundIndex;
  const roundNumber = bracket.roundNumbers[roundIndex] ?? nextRoundNumber(state);
  const configuredRoundId = bracket.roundIds[String(roundIndex)];
  const configuredRound = configuredRoundId
    ? state.rounds.find((round) => round.id === configuredRoundId)
    : undefined;
  const defaultRoundId = `bracket-round-${phaseId}-${roundIndex + 1}`;
  const roundId =
    configuredRound && configuredRound.status !== 'planned'
      ? newDirectorId('bracket-round')
      : (configuredRoundId ??
        (state.rounds.some((round) => round.id === defaultRoundId)
          ? newDirectorId('bracket-round')
          : defaultRoundId));
  bracket.roundIds[String(roundIndex)] = roundId;
  const availableRooms = assignableRoomIds(state);
  let roomIndex = 0;
  const games: ScheduledGame[] = [];
  for (const resolvedGame of resolved.games.filter(
    (game) => game.roundIndex === roundIndex && game.ready && !existingKeys.has(game.key),
  )) {
    const deterministicGameId = `bracket-game-${phaseId}-${resolvedGame.key}`;
    const hasPriorScheduledGame = state.scheduledGames.some(
      (candidate) =>
        candidate.id === deterministicGameId ||
        (candidate.bracketKey === resolvedGame.key && candidate.status === 'cancelled'),
    );
    const game: ScheduledGame = {
      id: hasPriorScheduledGame ? newDirectorId('bracket-game') : deterministicGameId,
      roundId,
      poolId: null,
      roomId: availableRooms[roomIndex++] ?? null,
      packetId: options.packetId ?? null,
      leftTeamId: resolvedGame.slotA.teamId!,
      rightTeamId: resolvedGame.slotB.teamId!,
      bye: false,
      status: 'scheduled',
      assignmentRevision: 1,
      bracketKey: resolvedGame.key,
      notes: `${resolvedGame.label} · bracket ${resolvedGame.key}`,
    };
    games.push(game);
  }
  for (const bye of byeCandidates) {
    games.push({
      id: `bracket-bye-${phaseId}-${bye.roundIndex + 1}-${bye.seed}`,
      roundId,
      poolId: null,
      roomId: null,
      packetId: null,
      leftTeamId: bye.teamId!,
      rightTeamId: null,
      bye: true,
      status: 'accepted',
      assignmentRevision: 1,
      bracketKey: bracketByeKey(bye.roundIndex, bye.seed),
      notes: `Bye for seed #${bye.seed}`,
    });
  }
  const conflicts: ScheduleConflict[] = [];
  if (roomIndex > availableRooms.length) {
    conflicts.push({
      code: 'not-enough-rooms',
      severity: 'warning',
      message: `${roomIndex} bracket games need rooms, but only ${availableRooms.length} are available.`,
    });
  }
  const round: Round = {
    id: roundId,
    phaseId,
    name:
      resolved.games.find((game) => game.roundIndex === roundIndex)?.label ??
      `Bracket round ${roundIndex + 1}`,
    number: roundNumber,
    revision: 1,
    status: 'planned',
    packetId: options.packetId ?? null,
    scheduledGameIds: games.map((game) => game.id),
    dayOrder: options.dayOrder ?? null,
    scheduledStart: null,
    releasedAt: null,
    startedAt: null,
    closedAt: null,
  };
  return { round, games, conflicts, hardFailure: false, bracket };
}

function resolveBracketState(state: DirectorState, bracket: BracketState): ResolvedBracket {
  const plan: BracketPlan = {
    teamCount: bracket.teamCount,
    bracketSize: bracket.bracketSize,
    roundCount: bracket.roundCount,
    nodes: bracket.nodes as BracketNode[],
    byes: bracket.byes,
    notes: [],
    issues: [],
  };
  const placements = bracket.roundNumbers.map((roundNumber, roundIndex) => ({ roundIndex, roundNumber }));
  const acceptedByKey = new Map<string, { scheduled: ScheduledGame; outcome: BracketGameOutcome }>();
  for (const scheduled of state.scheduledGames) {
    if (
      !scheduled.bracketKey ||
      scheduled.bye ||
      !scheduled.rightTeamId ||
      scheduled.status === 'cancelled'
    ) {
      continue;
    }
    const game = state.games
      .filter(
        (candidate) =>
          candidate.scheduledGameId === scheduled.id &&
          (candidate.status === 'accepted' || candidate.status === 'forfeit'),
      )
      .sort(
        (left, right) =>
          (left.acceptedAt ?? left.finishedAt ?? '').localeCompare(
            right.acceptedAt ?? right.finishedAt ?? '',
          ) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (!game) continue;
    const outcome = bracketOutcome(game, scheduled);
    if (!outcome) continue;
    acceptedByKey.set(scheduled.bracketKey, {
      scheduled,
      outcome,
    });
  }

  // Resolve in bracket order and accept an outcome only when its scheduled participants match the
  // currently resolved slots. A stale downstream result therefore cannot make the bracket appear
  // complete or make an invalid participant assignment look current.
  const outcomes: BracketGameOutcome[] = [];
  let resolved = resolveBracket({ plan, seeding: bracket.seeding, roundPlacements: placements });
  for (const node of [...plan.nodes].sort(
    (left, right) => left.roundIndex - right.roundIndex || left.sequence - right.sequence,
  )) {
    const candidate = acceptedByKey.get(node.key);
    const current = resolved.games.find((game) => game.key === node.key);
    if (
      !candidate ||
      !current?.ready ||
      candidate.scheduled.leftTeamId !== current.slotA.teamId ||
      candidate.scheduled.rightTeamId !== current.slotB.teamId
    ) {
      continue;
    }
    outcomes.push(candidate.outcome);
    resolved = resolveBracket({ plan, seeding: bracket.seeding, outcomes, roundPlacements: placements });
  }
  return resolved;
}

function bracketOutcome(
  game: DirectorState['games'][number],
  scheduled: ScheduledGame,
): BracketGameOutcome | null {
  if (!scheduled.bracketKey || !scheduled.rightTeamId) return null;
  if (game.status === 'forfeit' && game.forfeitedTeamId) {
    if (game.forfeitedTeamId === scheduled.leftTeamId) {
      return {
        gameKey: scheduled.bracketKey,
        winnerTeamId: scheduled.rightTeamId,
        loserTeamId: scheduled.leftTeamId,
      };
    }
    if (game.forfeitedTeamId === scheduled.rightTeamId) {
      return {
        gameKey: scheduled.bracketKey,
        winnerTeamId: scheduled.leftTeamId,
        loserTeamId: scheduled.rightTeamId,
      };
    }
    return null;
  }
  const left = game.scores.find((score) => score.teamId === scheduled.leftTeamId);
  const right = game.scores.find((score) => score.teamId === scheduled.rightTeamId);
  if (!left || !right || left.score === right.score) return null;
  return {
    gameKey: scheduled.bracketKey,
    winnerTeamId: left.score > right.score ? left.teamId : right.teamId,
    loserTeamId: left.score > right.score ? right.teamId : left.teamId,
  };
}

function assignBracketSeeds(teams: Team[]): Array<{ seed: number; teamId: DirectorId }> {
  const allSeedsUnique =
    teams.every((team) => Number.isInteger(team.seed) && (team.seed ?? 0) > 0) &&
    new Set(teams.map((team) => team.seed)).size === teams.length;
  const ordered = allSeedsUnique
    ? [...teams].sort((left, right) => (left.seed ?? 0) - (right.seed ?? 0))
    : [...teams].sort(
        (left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
      );
  return ordered.map((team, index) => ({ seed: allSeedsUnique ? team.seed! : index + 1, teamId: team.id }));
}

function bracketByeKey(roundIndex: number, seed: number): string {
  return `bye:${roundIndex}:${seed}`;
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
  const pools = state.pools
    .filter((pool) => phase.poolIds.includes(pool.id) && pool.archived !== true)
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
  const confirmedTeamIds = activeTournamentTeams(state).map((team) => team.id);
  const confirmedTeamIdSet = new Set(confirmedTeamIds);
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
      .filter((team): team is Team => team !== undefined && confirmedTeamIdSet.has(team.id)),
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
    const missing = pool.teamIds.filter(
      (teamId) => !confirmedTeamIdSet.has(teamId) && teamsById.get(teamId)?.status !== 'dropped',
    );
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
  const distance = formatDistance(state, phase.id);
  if (distance.exhausted) {
    return failedGenerationResult(
      state,
      options,
      'format-complete',
      `This format has reached its configured limit of ${distance.requiredRounds} round${distance.requiredRounds === 1 ? '' : 's'} per team.`,
    );
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

export type AssignmentEditTarget =
  | { kind: 'team'; id: DirectorId }
  | { kind: 'player'; id: DirectorId }
  | { kind: 'room'; id: DirectorId }
  | { kind: 'packet'; id: DirectorId }
  | { kind: 'organization'; id: DirectorId };

export interface AssignmentEditImpact {
  activeGameIds: DirectorId[];
  wouldReplaceAssignment: boolean;
}

/** Return the effective delivery intent without consulting historical QBTCP session state. */
export function effectiveRoundDeliveryMode(
  state: DirectorState,
  roundOrId: Round | DirectorId,
): RoundDeliveryMode {
  const round =
    typeof roundOrId === 'string' ? state.rounds.find((entry) => entry.id === roundOrId) : roundOrId;
  if (round?.deliveryMode) return round.deliveryMode;

  const roundGames = round ? state.scheduledGames.filter((game) => game.roundId === round.id) : [];
  const hasQbtcpActivity =
    state.qbtcpSessions.some(
      (session) =>
        session.state !== 'abandoned' &&
        roundGames.some((game) => game.id === session.matchId || game.roomId === session.roomId),
    ) ||
    state.qbtcpHelpRequests.some(
      (request) => request.status === 'open' && roundGames.some((game) => game.roomId === request.roomId),
    );
  if (hasQbtcpActivity) return 'qbtcp';
  if (state.transfers.locations.length > 0) return 'usb';
  if (roundGames.some((game) => game.roomId !== null)) return 'qbtcp';
  return 'manual';
}

/**
 * Assignment-visible edits are a lifecycle boundary. Keep this policy in the domain so forms and
 * whole-document/recovery callers cannot accidentally replace a live scorer assignment.
 */
export function assignmentEditImpact(
  state: DirectorState,
  target: AssignmentEditTarget,
): AssignmentEditImpact {
  const activeSessions = state.qbtcpSessions.filter(
    (session) => session.state !== 'abandoned' && qbtcpSessionHasUnresolvedWork(state, session),
  );
  const activeGameIds = new Set<DirectorId>();
  for (const session of activeSessions) {
    if (session.matchId) {
      activeGameIds.add(session.matchId);
      continue;
    }
    for (const game of state.scheduledGames) {
      if (!game.bye && game.roomId === session.roomId && !['accepted', 'cancelled'].includes(game.status)) {
        activeGameIds.add(game.id);
      }
    }
  }
  const games = state.scheduledGames.filter((game) => activeGameIds.has(game.id));
  const affected = games.filter((game) => {
    if (target.kind === 'room') return game.roomId === target.id;
    if (target.kind === 'packet')
      return (
        (game.packetId ?? state.rounds.find((round) => round.id === game.roundId)?.packetId) === target.id
      );
    if (target.kind === 'team') return game.leftTeamId === target.id || game.rightTeamId === target.id;
    if (target.kind === 'player') {
      const player = state.players.find((entry) => entry.id === target.id);
      return Boolean(player && (game.leftTeamId === player.teamId || game.rightTeamId === player.teamId));
    }
    const teamIds = state.teams.filter((team) => team.organizationId === target.id).map((team) => team.id);
    return teamIds.includes(game.leftTeamId) || teamIds.includes(game.rightTeamId ?? '');
  });
  return { activeGameIds: affected.map((game) => game.id), wouldReplaceAssignment: affected.length > 0 };
}

export function assignmentEditBlocker(state: DirectorState, target: AssignmentEditTarget): string | null {
  const impact = assignmentEditImpact(state, target);
  if (!impact.wouldReplaceAssignment) return null;
  const game = state.scheduledGames.find((entry) => entry.id === impact.activeGameIds[0]);
  const room = game?.roomId ? state.rooms.find((entry) => entry.id === game.roomId) : undefined;
  const roomLabel = room ? ` in ${room.name}` : '';
  return `This change affects a live QBTCP scorer assignment${roomLabel}. Finish the game or use an explicit assignment replacement before editing it.`;
}

/**
 * A scheduled game occupies a room until its operational work is explicitly resolved. Planned
 * work is intent for a future round; released/live/submitted work can still resume or produce a
 * result and therefore must keep the room reserved.
 */
export function scheduledGameHasUnresolvedWork(state: DirectorState, game: ScheduledGame): boolean {
  const gameIds = new Set(
    state.games.filter((record) => record.scheduledGameId === game.id).map((record) => record.id),
  );
  if (
    state.games.some(
      (record) =>
        record.scheduledGameId === game.id && (record.status === 'live' || record.status === 'submitted'),
    ) ||
    state.submissions.some(
      (submission) =>
        gameIds.has(submission.gameId) &&
        (submission.status === 'received' || submission.status === 'review'),
    )
  ) {
    return true;
  }
  if (game.bye || game.status === 'accepted' || game.status === 'cancelled') return false;
  if (game.status === 'released' || game.status === 'live' || game.status === 'submitted') return true;
  return state.qbtcpSessions.some(
    (session) => session.matchId === game.id && qbtcpSessionHasUnresolvedWork(state, session),
  );
}

/**
 * Return the authoritative operational blockers for closing a round.
 *
 * This deliberately examines more than the scheduled-game status. A result record or review
 * submission can remain active underneath a stale scheduled row, and a paired/live/resumable
 * scorer can still contradict a proposed closed state even after a result row was edited. Both
 * ordinary Finish and the advanced recovery Close action use this predicate through the
 * controller.
 */
export function roundCloseBlockers(state: DirectorState, roundId: DirectorId): string[] {
  const round = state.rounds.find((entry) => entry.id === roundId);
  if (!round) return ['That round is no longer in the tournament workspace.'];

  const games = state.scheduledGames.filter((game) => game.roundId === roundId);
  const nonByeGames = games.filter((game) => !game.bye);
  const blockers: string[] = [];
  const add = (message: string) => {
    if (!blockers.includes(message)) blockers.push(message);
  };

  const statusLabels: Record<Exclude<ScheduledGame['status'], 'accepted' | 'cancelled'>, string> = {
    scheduled: 'scheduled',
    released: 'released',
    live: 'live',
    submitted: 'submitted',
  };
  const unresolvedByStatus = new Map<string, number>();
  for (const game of nonByeGames) {
    if (game.status === 'accepted') {
      const canonical = state.games.some(
        (record) =>
          record.scheduledGameId === game.id && (record.status === 'accepted' || record.status === 'forfeit'),
      );
      if (!canonical) add(`${round.name} has a game marked accepted without a canonical result.`);
      continue;
    }
    if (game.status === 'cancelled') continue;
    const label = statusLabels[game.status];
    unresolvedByStatus.set(label, (unresolvedByStatus.get(label) ?? 0) + 1);
  }
  if (unresolvedByStatus.size > 0) {
    const summary = [...unresolvedByStatus.entries()]
      .map(([label, count]) => `${count} ${label} game${count === 1 ? '' : 's'}`)
      .join(' and ');
    add(`${round.name} still has ${summary}; resolve every competitive game before closing it.`);
  }

  const roundGameIds = new Set(nonByeGames.map((game) => game.id));
  const roundRecords = state.games.filter((record) => roundGameIds.has(record.scheduledGameId));
  const activeRecords = roundRecords.filter(
    (record) => record.status === 'live' || record.status === 'submitted',
  );
  if (activeRecords.length > 0) {
    add(
      `${round.name} still has ${activeRecords.length} active result record${activeRecords.length === 1 ? '' : 's'}; review or resolve it before closing the round.`,
    );
  }

  const roundRecordIds = new Set(roundRecords.map((record) => record.id));
  const pendingSubmissions = state.submissions.filter(
    (submission) =>
      roundRecordIds.has(submission.gameId) &&
      (submission.status === 'received' || submission.status === 'review'),
  );
  if (pendingSubmissions.length > 0) {
    add(
      `${round.name} still has ${pendingSubmissions.length} result${pendingSubmissions.length === 1 ? '' : 's'} awaiting review; resolve it before closing the round.`,
    );
  }

  const roundRoomIds = new Set(nonByeGames.map((game) => game.roomId).filter(Boolean));
  const unresolvedSessions = state.qbtcpSessions.filter((session) => {
    const matchedGame = session.matchId ? nonByeGames.find((game) => game.id === session.matchId) : undefined;
    const belongsToRound = Boolean(matchedGame) || (!session.matchId && roundRoomIds.has(session.roomId));
    if (!belongsToRound) return false;
    return (
      session.state === 'paired' ||
      session.state === 'assigned' ||
      session.state === 'live' ||
      (session.state === 'abandoned' && session.resumable === true)
    );
  });
  if (unresolvedSessions.length > 0) {
    add(
      `${round.name} still has ${unresolvedSessions.length} active or resumable QBTCP session${unresolvedSessions.length === 1 ? '' : 's'}; finish or resolve it before closing the round.`,
    );
  }

  const resolvedBracket = state.tournament?.formatId
    ? resolveDirectorBracket(state, state.tournament.formatId)
    : null;
  const cancelledBracketGame = games.find((game) => {
    if (!game.bracketKey || game.status !== 'cancelled') return false;
    // A legacy cancelled row may be followed by an explicit replacement. It is safe only after
    // the authoritative resolver has a decisive outcome for that bracket key.
    return !resolvedBracket?.games.some(
      (resolved) =>
        resolved.key === game.bracketKey && resolved.winnerTeamId !== null && resolved.loserTeamId !== null,
    );
  });
  if (cancelledBracketGame) {
    add(
      'This elimination round contains a cancelled game without a bracket outcome. Generate a replacement or record an explicit forfeit/administrative resolution before closing it.',
    );
  }

  return blockers;
}

export function qbtcpSessionHasUnresolvedWork(
  state: DirectorState,
  session: DirectorState['qbtcpSessions'][number],
): boolean {
  const scheduled = session.matchId
    ? state.scheduledGames.find((game) => game.id === session.matchId)
    : undefined;
  // A normal scorer result is terminal and no longer occupies the room. A live/paired session
  // on a game that Director has already settled is different: it is the unsafe legacy state that
  // administrative settlement must retire before the room can be reused.
  if (
    scheduled &&
    ['accepted', 'cancelled'].includes(scheduled.status) &&
    session.state === 'result-received'
  ) {
    return false;
  }
  return (
    session.state === 'paired' ||
    session.state === 'assigned' ||
    session.state === 'live' ||
    session.state === 'result-received' ||
    (session.state === 'abandoned' && session.resumable === true)
  );
}

export function roomHasUnresolvedWork(state: DirectorState, roomId: DirectorId): boolean {
  return (
    state.scheduledGames.some(
      (game) => game.roomId === roomId && scheduledGameHasUnresolvedWork(state, game),
    ) ||
    state.qbtcpSessions.some(
      (session) => session.roomId === roomId && qbtcpSessionHasUnresolvedWork(state, session),
    )
  );
}

/** @deprecated Use roomHasUnresolvedWork; retained for callers outside the Director package. */
export function roomHasUnresolvedLiveWork(state: DirectorState, roomId: DirectorId): boolean {
  return roomHasUnresolvedWork(state, roomId);
}

export function unresolvedScheduledGameForTeam(
  state: DirectorState,
  teamId: DirectorId,
): ScheduledGame | undefined {
  return state.scheduledGames.find(
    (game) =>
      (game.leftTeamId === teamId || game.rightTeamId === teamId) &&
      scheduledGameHasUnresolvedWork(state, game),
  );
}

/** A planned elimination slot has no result to resolve, so it is not room occupancy yet. It is
 * nevertheless unsafe to cancel through a structural team edit: doing so would strand the bracket
 * without an authoritative winner. */
export function plannedEliminationGameForTeam(
  state: DirectorState,
  teamId: DirectorId,
): ScheduledGame | undefined {
  return state.scheduledGames.find(
    (game) =>
      game.status === 'scheduled' &&
      Boolean(game.bracketKey) &&
      (game.leftTeamId === teamId || game.rightTeamId === teamId),
  );
}

export interface UnresolvedBracketDependency {
  formatId: DirectorId;
  phaseId?: DirectorId;
  bracketKey: string;
  reason: string;
}

/**
 * Find a team's dependency in the persisted bracket, including slots that have not been
 * materialized as ScheduledGames yet. This is intentionally based on resolved bracket structure,
 * not the mutable global roster or the current schedule slice.
 */
export function unresolvedBracketDependencyForTeam(
  state: DirectorState,
  teamId: DirectorId,
): UnresolvedBracketDependency | null {
  for (const format of state.formats) {
    if (format.kind !== 'single-elimination' || !format.bracket) continue;
    const resolved = resolveDirectorBracket(state, format.id);
    const dependency = resolved?.games.find(
      (game) => game.winnerTeamId === null && (game.slotA.teamId === teamId || game.slotB.teamId === teamId),
    );
    if (!dependency) continue;
    const teamName = state.teams.find((team) => team.id === teamId)?.displayName ?? teamId;
    return {
      formatId: format.id,
      phaseId: format.bracket.phaseId,
      bracketKey: dependency.key,
      reason: `${teamName} is still active in the persisted elimination bracket at ${dependency.label}.`,
    };
  }
  return null;
}

export function roomIsAssignable(state: DirectorState, roomId: DirectorId): boolean {
  const room = state.rooms.find((entry) => entry.id === roomId);
  return Boolean(
    room && room.available && room.status === 'available' && !roomHasUnresolvedWork(state, roomId),
  );
}

/**
 * Validate an assignment that already belongs to a scheduled game. The game's own paired/live
 * session is expected occupancy; only unrelated unresolved work makes the assignment conflicting.
 * New assignments must continue to use roomIsAssignable so they cannot claim an occupied room. A
 * recovery move may allow an unavailable source room because the move is precisely what removes
 * its assignment; unrelated occupancy is still checked in that mode.
 */
export function roomAssignmentIsValid(
  state: DirectorState,
  roomId: DirectorId,
  scheduledGameId: DirectorId,
  options: { allowUnavailableRoom?: boolean } = {},
): boolean {
  const room = state.rooms.find((entry) => entry.id === roomId);
  if (!room || (!options.allowUnavailableRoom && (!room.available || room.status !== 'available')))
    return false;
  return (
    !state.scheduledGames.some(
      (game) =>
        game.id !== scheduledGameId && game.roomId === roomId && scheduledGameHasUnresolvedWork(state, game),
    ) &&
    !state.qbtcpSessions.some(
      (session) =>
        session.roomId === roomId &&
        session.matchId !== scheduledGameId &&
        qbtcpSessionHasUnresolvedWork(state, session),
    )
  );
}

function assignableRoomIds(state: DirectorState): DirectorId[] {
  return state.rooms.filter((room) => roomIsAssignable(state, room.id)).map((room) => room.id);
}

function roundRobinCycleLength(teamCount: number): number {
  return teamCount % 2 === 0 ? Math.max(0, teamCount - 1) : teamCount;
}

function roundRobinPairingsComplete(
  state: DirectorState,
  phaseId: DirectorId | undefined,
  teams: readonly Team[],
  repetitions: number,
): boolean {
  if (!phaseId || teams.length < 2) return false;
  const activeTeamIds = new Set(teams.map((team) => team.id));
  const requiredPairs = new Set<string>();
  for (let leftIndex = 0; leftIndex < teams.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < teams.length; rightIndex += 1) {
      requiredPairs.add(roundRobinPairKey(teams[leftIndex]!.id, teams[rightIndex]!.id));
    }
  }
  const pairCounts = new Map<string, number>();
  for (const game of state.scheduledGames) {
    const round = state.rounds.find((candidate) => candidate.id === game.roundId);
    if (
      !round ||
      round.phaseId !== phaseId ||
      game.status === 'cancelled' ||
      game.bye ||
      !game.rightTeamId ||
      !activeTeamIds.has(game.leftTeamId) ||
      !activeTeamIds.has(game.rightTeamId) ||
      game.leftTeamId === game.rightTeamId
    )
      continue;
    const key = roundRobinPairKey(game.leftTeamId, game.rightTeamId);
    if (requiredPairs.has(key)) pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  return [...requiredPairs].every((key) => (pairCounts.get(key) ?? 0) >= repetitions);
}

function roundRobinPairKey(leftId: DirectorId, rightId: DirectorId): string {
  return leftId < rightId ? `${leftId}\u001f${rightId}` : `${rightId}\u001f${leftId}`;
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

/** Fill the ordinary round-robin plan with the canonical scheduler's complete rotation. */
export function generatePlannedRoundRobinGames(state: DirectorState): ScheduledGame[] {
  const format = currentFormat(state);
  const phase = currentPhase(state);
  if (!format || !phase || (format.kind !== 'round-robin' && format.kind !== 'double-round-robin')) return [];
  const field = phaseCompetitiveField(state, phase.id);
  if (field.issues.length > 0) throw new Error(field.issues[0]);
  const rounds = state.rounds
    .filter((round) => round.phaseId === phase.id)
    .sort((a, b) => a.number - b.number);
  const generated = generateRoundRobinSchedule({
    phaseId: phase.id,
    teams: field.teams.map(toCoreTeam),
    rounds: rounds.map((round) => ({ id: round.id, number: round.number })),
    roomIds: state.rooms.filter((room) => roomIsAssignable(state, room.id)).map((room) => room.id),
    repetitions: format.kind === 'double-round-robin' ? 2 : 1,
    rematchPolicy: format.kind === 'double-round-robin' ? 'allow' : 'forbid',
    requireRoomAssignments: false,
    idFactory: { game: () => newDirectorId('game') },
  });
  if (generated.issues.some((issue) => issue.severity === 'error'))
    throw new Error(generated.issues.map((issue) => issue.message).join(' '));
  return generated.games.map((game) => ({
    id: game.id,
    roundId: game.roundId,
    poolId: game.poolId,
    roomId: game.kind === 'bye' ? null : game.roomId,
    packetId: null,
    leftTeamId: game.kind === 'bye' ? game.byeTeamId : game.teamAId,
    rightTeamId: game.kind === 'bye' ? null : game.teamBId,
    bye: game.kind === 'bye',
    status: 'scheduled',
    assignmentRevision: 1,
  }));
}
