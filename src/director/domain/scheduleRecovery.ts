import { roomAssignmentIsValid } from './scheduling';
import type { DirectorId, DirectorState, ScheduledGame } from './model';

export interface TeamRestoreReview {
  scheduledGameId: DirectorId;
  roundId: DirectorId;
  reason: string;
}

export interface TeamRestorePlan {
  teamId: DirectorId;
  dropCancelledGameIds: DirectorId[];
  safeGameIds: DirectorId[];
  review: TeamRestoreReview[];
}

/**
 * Work out which cancellations a team restore may safely reverse.
 *
 * This is intentionally a pure plan. The controller uses the same plan for its mutation and the
 * Teams UI uses it for an honest announcement, so a restore can never infer provenance differently
 * in two layers of the application.
 */
export function planTeamRestore(state: DirectorState, teamId: DirectorId): TeamRestorePlan {
  const dropCancelled = state.scheduledGames.filter(
    (game) =>
      game.status === 'cancelled' &&
      game.cancellation?.reasonKind === 'team-dropped' &&
      game.cancellation.teamId === teamId,
  );
  const safeGameIds: DirectorId[] = [];
  const review: TeamRestoreReview[] = [];
  for (const game of dropCancelled) {
    const round = state.rounds.find((entry) => entry.id === game.roundId);
    const reason = unsafeRestoreReason(state, game, round?.status);
    if (reason) {
      review.push({ scheduledGameId: game.id, roundId: game.roundId, reason });
    } else {
      safeGameIds.push(game.id);
    }
  }
  return { teamId, dropCancelledGameIds: dropCancelled.map((game) => game.id), safeGameIds, review };
}

function unsafeRestoreReason(
  state: DirectorState,
  game: ScheduledGame,
  roundStatus: DirectorState['rounds'][number]['status'] | undefined,
): string | null {
  if (!roundStatus) return 'The round no longer exists.';
  if (roundStatus === 'closed') return 'The round is already closed.';
  if (game.bye) return 'A bye is not a playable game.';
  if (game.bracketKey) return 'This elimination pairing needs explicit bracket review.';
  if (
    state.games.some(
      (record) => record.scheduledGameId === game.id && !['rejected', 'cancelled'].includes(record.status),
    )
  ) {
    return 'Result or scorer work exists for this game.';
  }
  const gameIds = new Set(
    state.games.filter((record) => record.scheduledGameId === game.id).map((record) => record.id),
  );
  if (
    state.submissions.some(
      (submission) =>
        gameIds.has(submission.gameId) &&
        (submission.status === 'received' || submission.status === 'review'),
    )
  ) {
    return 'A result submission still needs review.';
  }
  if (
    state.qbtcpSessions.some(
      (session) =>
        session.matchId === game.id &&
        (session.state === 'paired' ||
          session.state === 'assigned' ||
          session.state === 'live' ||
          session.state === 'result-received' ||
          (session.state === 'abandoned' && session.resumable === true)),
    )
  ) {
    return 'The scorer still has unresolved QBTCP work.';
  }
  if (roundStatus === 'released') {
    if (!game.roomId) return 'The released game has no room assignment.';
    if (!roomAssignmentIsValid(state, game.roomId, game.id)) {
      return 'The assigned room is occupied or no longer available.';
    }
  }
  return null;
}
