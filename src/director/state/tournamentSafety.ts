import type { DirectorId, DirectorState } from '../domain';

/**
 * Canonical result settlement belongs to a released round. Planning and preparation may create
 * scheduled games early, but those rows are not competitive history until the Director starts the
 * round. Keeping this check outside the UI gives every result-entry path the same lifecycle rule.
 */
export function releasedRoundResultBlocker(state: DirectorState, scheduledGameId: DirectorId): string | null {
  const scheduled = state.scheduledGames.find((game) => game.id === scheduledGameId);
  if (!scheduled) return null; // Preserve the base controller's more specific unknown-game error.
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
export function advancementCommitBlocker(
  state: DirectorState,
  sourcePhaseId: DirectorId,
): string | null {
  const source = state.phases.find((phase) => phase.id === sourcePhaseId);
  if (!source) return null; // Let the base controller report its source/target validation error.
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
  const suffix = unresolvedGames > 0
    ? ` ${unresolvedGames} game${unresolvedGames === 1 ? '' : 's'} remain unresolved.`
    : '';
  return `Finish ${source.name} before committing advancement.${suffix}`;
}

/** Resolve the scheduled target of a staged submission without changing any review state. */
export function scheduledGameIdForSubmission(
  state: DirectorState,
  submissionId: DirectorId,
): DirectorId | null {
  const submission = state.submissions.find((entry) => entry.id === submissionId);
  const game = submission ? state.games.find((entry) => entry.id === submission.gameId) : undefined;
  return game?.scheduledGameId ?? null;
}
