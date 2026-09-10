import {
  formatDistance,
  latestAdvancementCommit,
  phaseCanComplete,
  phaseCompetitiveField,
  qbtcpSessionHasUnresolvedWork,
  type DirectorId,
  type DirectorState,
} from '../domain';

/**
 * Canonical result settlement belongs to a released round. Planning and preparation may create
 * scheduled games early, but those rows are not competitive history until the Director starts the
 * round. Keeping this check outside the UI gives every result-entry path the same lifecycle rule.
 */
export function releasedRoundResultBlocker(state: DirectorState, scheduledGameId: DirectorId): string | null {
  const scheduled = state.scheduledGames.find((game) => game.id === scheduledGameId);
  if (!scheduled) return null;
  const round = state.rounds.find((entry) => entry.id === scheduled.roundId);
  if (!round) return 'That scheduled game is not attached to a tournament round.';
  if (round.status === 'released') return null;
  if (round.status === 'closed') {
    return `${round.name} is already closed. Correct an existing canonical result instead of adding a new one.`;
  }
  return `${round.name} has not started yet. Results can only be accepted after the round is released.`;
}

/**
 * Normal tournament operation has one released round with unresolved play at a time. Checking
 * scheduled-game state instead of room occupancy also protects manual and roomless tournaments.
 */
export function unresolvedReleasedRoundBlocker(state: DirectorState, roundId: DirectorId): string | null {
  const blockingRound = state.rounds.find(
    (round) =>
      round.id !== roundId &&
      round.status === 'released' &&
      state.scheduledGames.some(
        (game) =>
          game.roundId === round.id && !game.bye && game.status !== 'accepted' && game.status !== 'cancelled',
      ),
  );
  return blockingRound
    ? `${blockingRound.name} still has unresolved play. Finish or repair it before starting another round.`
    : null;
}

/**
 * Advancement is a canonical phase transition, not a live standings preview. The source phase is
 * marked complete by the ordinary round-close path only after its competitive work is resolved.
 */
export function advancementCommitBlocker(state: DirectorState, sourcePhaseId: DirectorId): string | null {
  const source = state.phases.find((phase) => phase.id === sourcePhaseId);
  if (!source) return null;
  const unresolvedGames = state.scheduledGames.filter((game) => {
    const round = state.rounds.find((entry) => entry.id === game.roundId);
    return (
      round?.phaseId === sourcePhaseId &&
      !game.bye &&
      game.status !== 'accepted' &&
      game.status !== 'cancelled'
    );
  }).length;
  const field =
    Array.isArray(source.poolIds) && Array.isArray(source.roundIds)
      ? phaseCompetitiveField(state, sourcePhaseId)
      : { issues: ['The source phase has incomplete structure.'] };
  const structureValid = phaseStructureIsValid(state, sourcePhaseId);
  const placeholderRoundIds = new Set(
    (Array.isArray(source.roundIds) ? source.roundIds : [])
      .map((roundId) => state.rounds.find((round) => round.id === roundId))
      .filter((round): round is NonNullable<typeof round> =>
        Boolean(
          round &&
          round.status === 'planned' &&
          Array.isArray(round.scheduledGameIds) &&
          round.scheduledGameIds.length === 0,
        ),
      )
      .map((round) => round.id),
  );
  const completionState =
    placeholderRoundIds.size === 0
      ? state
      : {
          ...state,
          phases: state.phases.map((phase) =>
            phase.id === sourcePhaseId
              ? { ...phase, roundIds: phase.roundIds.filter((roundId) => !placeholderRoundIds.has(roundId)) }
              : phase,
          ),
          rounds: state.rounds.filter((round) => !placeholderRoundIds.has(round.id)),
        };
  const distance = formatDistance(completionState, sourcePhaseId);
  let phaseComplete = false;
  try {
    phaseComplete =
      structureValid && field.issues.length === 0 && phaseCanComplete(completionState, sourcePhaseId);
  } catch {
    // A malformed persisted bracket must fail closed rather than turn a safety check into a crash.
    phaseComplete = false;
  }
  if (unresolvedGames === 0 && phaseComplete) return null;
  const suffix =
    unresolvedGames > 0
      ? ` ${unresolvedGames} game${unresolvedGames === 1 ? '' : 's'} remain unresolved.`
      : '';
  const distanceSuffix =
    distance.requiredRounds !== null && !distance.exhausted
      ? ` ${source.name} requires ${distance.requiredRounds} rounds, but only ${distance.generatedRounds} have been generated.`
      : '';
  const structureSuffix =
    field.issues.length > 0
      ? ` ${field.issues[0]}`
      : structureValid
        ? ''
        : ' The source phase has incomplete structure.';
  return `Finish ${source.name} before committing advancement.${distanceSuffix}${structureSuffix}${suffix}`;
}

function phaseStructureIsValid(state: DirectorState, phaseId: DirectorId): boolean {
  const phase = state.phases.find((entry) => entry.id === phaseId);
  if (!phase || !Array.isArray(phase.roundIds)) return false;
  const phaseRoundIds = new Set(phase.roundIds);
  if (phaseRoundIds.size !== phase.roundIds.length || phaseRoundIds.size === 0) return false;

  const phaseRounds = state.rounds.filter((round) => round.phaseId === phaseId);
  if (phaseRounds.some((round) => !phaseRoundIds.has(round.id))) return false;
  if (
    phase.roundIds.some((roundId) => {
      const round = state.rounds.find((entry) => entry.id === roundId);
      return !round || round.phaseId !== phaseId;
    })
  )
    return false;

  const scheduledById = new Map(state.scheduledGames.map((game) => [game.id, game]));
  for (const round of phaseRounds) {
    if (!Array.isArray(round.scheduledGameIds)) return false;
    for (const scheduledGameId of round.scheduledGameIds) {
      if (scheduledById.get(scheduledGameId)?.roundId !== round.id) return false;
    }
  }
  return state.scheduledGames.every((game) => {
    if (!phaseRoundIds.has(game.roundId)) return true;
    const round = state.rounds.find((entry) => entry.id === game.roundId);
    return Boolean(round?.scheduledGameIds.includes(game.id));
  });
}

/**
 * Which downstream lifecycle tier a historical result correction falls into (#673).
 *
 * - Tier 1: no committed advancement depends on the source phase. Apply normally.
 * - Tier 2: committed advancement exists but nothing downstream has been issued.
 *   The correction applies; the dependent basis reads stale and must be recommitted.
 * - Tier 3: downstream assignments were issued but no scorekeeper progress exists.
 *   The correction is refused until the operator revokes/reissues the exact games listed.
 * - Tier 4: downstream games are live, have progress, or already have results.
 *   Nothing downstream is rewritten automatically; an explicit recovery decision is required.
 */
export interface CorrectionDownstreamExposure {
  scheduledGameId: DirectorId;
  roundName: string;
  roomName: string | null;
  exposure: 'issued' | 'progress' | 'result';
}

export interface CorrectionTierClassification {
  tier: 1 | 2 | 3 | 4;
  sourcePhaseName: string | null;
  committedTargetName: string | null;
  /** Tier 3 drivers: issued downstream assignments with no scorekeeper progress. */
  issued: CorrectionDownstreamExposure[];
  /** Tier 4 drivers: downstream games with progress or results. */
  live: CorrectionDownstreamExposure[];
}

function downstreamExposure(
  state: DirectorState,
  scheduledId: DirectorId,
  exposure: CorrectionDownstreamExposure['exposure'],
): CorrectionDownstreamExposure {
  const scheduled = state.scheduledGames.find((game) => game.id === scheduledId);
  const round = scheduled ? state.rounds.find((entry) => entry.id === scheduled.roundId) : undefined;
  const room = scheduled?.roomId ? state.rooms.find((entry) => entry.id === scheduled.roomId) : undefined;
  return {
    scheduledGameId: scheduledId,
    roundName: round?.name ?? 'a downstream round',
    roomName: room?.name ?? null,
    exposure,
  };
}

/**
 * Classify a historical result correction into its downstream lifecycle tier (#673).
 *
 * Pure: callers apply Tier 1/2 corrections through the ordinary correction path
 * (which re-verifies brackets and records the invalidation) and refuse Tier 3/4
 * with the exact affected games from this classification.
 */
export function classifyResultCorrectionTier(
  state: DirectorState,
  gameId: DirectorId,
): CorrectionTierClassification {
  const empty: CorrectionTierClassification = {
    tier: 1,
    sourcePhaseName: null,
    committedTargetName: null,
    issued: [],
    live: [],
  };
  const game = state.games.find((entry) => entry.id === gameId);
  const scheduled = game
    ? state.scheduledGames.find((entry) => entry.id === game.scheduledGameId)
    : undefined;
  const round = scheduled ? state.rounds.find((entry) => entry.id === scheduled.roundId) : undefined;
  const source = round ? state.phases.find((entry) => entry.id === round.phaseId) : undefined;
  if (!game || !scheduled || !source) return empty;
  const advancement = latestAdvancementCommit(state, source.id);
  if (!advancement) return empty;
  const target = advancement.entityId
    ? state.phases.find((entry) => entry.id === advancement.entityId)
    : undefined;
  const classified: CorrectionTierClassification = {
    tier: 2,
    sourcePhaseName: source.name,
    committedTargetName: target?.name ?? null,
    issued: [],
    live: [],
  };
  const targetRoundIds = new Set(target && Array.isArray(target.roundIds) ? target.roundIds : []);
  const downstreamScheduled = state.scheduledGames.filter(
    (candidate) =>
      targetRoundIds.has(candidate.roundId) && !candidate.bye && candidate.status !== 'cancelled',
  );
  const downstreamIds = new Set(downstreamScheduled.map((candidate) => candidate.id));
  if (downstreamIds.size === 0) return classified;
  for (const candidate of downstreamScheduled) {
    const exposing =
      state.games.some(
        (record) =>
          record.scheduledGameId === candidate.id &&
          (record.status === 'live' || record.status === 'submitted' || record.status === 'accepted'),
      ) ||
      candidate.status === 'live' ||
      candidate.status === 'submitted' ||
      candidate.status === 'accepted';
    if (exposing) {
      const hasResult =
        candidate.status === 'accepted' ||
        state.games.some((record) => record.scheduledGameId === candidate.id && record.status === 'accepted');
      classified.live.push(downstreamExposure(state, candidate.id, hasResult ? 'result' : 'progress'));
      continue;
    }
    const issued =
      state.rounds.some(
        (entry) =>
          entry.id === candidate.roundId &&
          (entry.status === 'prepared' || entry.status === 'released') &&
          candidate.status !== 'accepted',
      ) ||
      state.qbtcpSessions.some(
        (session) => session.matchId === candidate.id && qbtcpSessionHasUnresolvedWork(state, session),
      ) ||
      (state.transfers?.assignments ?? []).some(
        (assignment) => assignment.status === 'written' && assignment.scheduledGameId === candidate.id,
      ) ||
      (state.transfers?.artifacts ?? []).some(
        (artifact) => artifact.classification === 'assignment' && artifact.scheduledGameId === candidate.id,
      );
    if (issued) classified.issued.push(downstreamExposure(state, candidate.id, 'issued'));
  }
  if (classified.live.length > 0) classified.tier = 4;
  else if (classified.issued.length > 0) classified.tier = 3;
  return classified;
}

function describeExposure(entries: CorrectionDownstreamExposure[]): string {
  return entries
    .map((entry) => {
      const room = entry.roomName ? ` in ${entry.roomName}` : '';
      return `${entry.roundName}${room} (${entry.scheduledGameId})`;
    })
    .join('; ');
}

/**
 * A result correction after advancement has been materialized changes the competitive basis under
 * downstream membership. Tier 1/2 corrections apply through the ordinary correction path, which
 * records the dependent basis as stale; Tier 3/4 corrections are refused with the exact affected
 * games so playoffs can never silently diverge from corrected standings.
 */
export function advancementCorrectionBlocker(state: DirectorState, gameId: DirectorId): string | null {
  const classification = classifyResultCorrectionTier(state, gameId);
  if (classification.tier <= 2) return null;
  const head = `${classification.sourcePhaseName ?? 'This stage'} already has committed advancement${
    classification.committedTargetName ? ` into ${classification.committedTargetName}` : ''
  }.`;
  if (classification.tier === 3) {
    return (
      `${head} These downstream assignments were already issued but have no scorekeeper progress yet: ` +
      `${describeExposure(classification.issued)}. ` +
      'Revoke and reissue those assignments through the game reissue workflow first, then correct this result and recommit advancement.'
    );
  }
  return (
    `${head} These downstream games already have progress or results: ` +
    `${describeExposure(classification.live)}. ` +
    'QBSheet will not rewrite them automatically. Choose a tournament recovery action first: keep the played games as an explicit director ruling, void and replay them, or restore a recovery point and roll the tournament back.'
  );
}

/**
 * Assignments serialize a rules snapshot. Once an unresolved round is prepared or released, a
 * tournament-wide rules edit would make Director disagree with files/devices that may already have
 * that assignment. Freeze the rules until that round is resolved; future rounds can then adopt the
 * new rules before they are prepared.
 */
export function assignmentRuleChangeBlocker(state: DirectorState): string | null {
  const blockingRound = state.rounds.find(
    (round) =>
      (round.status === 'prepared' || round.status === 'released') &&
      state.scheduledGames.some(
        (game) =>
          game.roundId === round.id && !game.bye && game.status !== 'accepted' && game.status !== 'cancelled',
      ),
  );
  return blockingRound
    ? `${blockingRound.name} already has scorer assignments in circulation. Finish or cancel its unresolved games before changing tournament rules.`
    : null;
}

export function scheduledGameIdForSubmission(
  state: DirectorState,
  submissionId: DirectorId,
): DirectorId | null {
  const submission = state.submissions.find((entry) => entry.id === submissionId);
  const game = submission ? state.games.find((entry) => entry.id === submission.gameId) : undefined;
  return game?.scheduledGameId ?? null;
}
