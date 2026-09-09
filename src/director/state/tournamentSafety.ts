import type { DirectorId, DirectorState } from '../domain';

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
  if (source.status === 'complete') return null;
  const unresolvedGames = state.scheduledGames.filter((game) => {
    const round = state.rounds.find((entry) => entry.id === game.roundId);
    return (
      round?.phaseId === sourcePhaseId &&
      !game.bye &&
      game.status !== 'accepted' &&
      game.status !== 'cancelled'
    );
  }).length;
  // The basis is final once every round that actually carries play is closed and no competitive
  // game is outstanding. A later-phase plan may still hold empty placeholder rounds; those carry no
  // result and cannot change the standings, so they must not block a settled advancement.
  const playedRounds = state.rounds.filter(
    (round) =>
      round.phaseId === sourcePhaseId && state.scheduledGames.some((game) => game.roundId === round.id),
  );
  const openPlayedRounds = playedRounds.filter((round) => round.status !== 'closed');
  if (unresolvedGames === 0 && openPlayedRounds.length === 0 && playedRounds.length > 0) return null;
  const suffix =
    unresolvedGames > 0
      ? ` ${unresolvedGames} game${unresolvedGames === 1 ? '' : 's'} remain unresolved.`
      : '';
  return `Finish ${source.name} before committing advancement.${suffix}`;
}

/**
 * The synchronous legacy commit cannot represent an empty target pool. Refuse a call that would
 * omit an already-populated target pool; the advancement UI uses the checkpoint-backed complete
 * commit path that explicitly writes every target pool, including empty ones.
 */
export function partialAdvancementCommitBlocker(
  state: DirectorState,
  targetPhaseId: DirectorId,
  assignments: readonly { teamId: DirectorId; targetPoolId?: DirectorId }[],
): string | null {
  const target = state.phases.find((phase) => phase.id === targetPhaseId);
  if (!target) return null;
  const assignedPoolIds = new Set(
    assignments
      .map((assignment) => assignment.targetPoolId)
      .filter((poolId): poolId is DirectorId => poolId !== undefined),
  );
  const assignedTeamIds = new Set(assignments.map((assignment) => assignment.teamId));
  // This path rewrites only the pools named in the commit, so an omitted pool keeps its previous
  // membership. The corruption that makes dangerous is a team left in a second pool of the same
  // stage. An omitted pool that holds none of the teams being committed cannot duplicate anyone,
  // so an incremental override commit stays available.
  const stalePool = target.poolIds
    .map((poolId) => state.pools.find((pool) => pool.id === poolId))
    .find(
      (pool) =>
        pool && !assignedPoolIds.has(pool.id) && pool.teamIds.some((teamId) => assignedTeamIds.has(teamId)),
    );
  return stalePool
    ? `Recommitting advancement would leave teams in ${stalePool.name} as well. Use the complete advancement commit path so every target pool is replaced atomically.`
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
