import { effectiveRoundDeliveryMode, type DirectorId, type DirectorState } from '../domain';

/**
 * USB delivery is ready only when every still-unresolved competitive game has a successfully written
 * assignment for the exact current round + assignment revision. A configured drive by itself is not
 * evidence that a scorekeeper file exists, and an older written file stops counting as soon as the
 * round or assignment revision changes.
 */
export function usbRoundDeliveryBlocker(state: DirectorState, roundId: DirectorId): string | null {
  const round = state.rounds.find((entry) => entry.id === roundId);
  if (!round) return 'That round is no longer in the tournament workspace.';
  if (effectiveRoundDeliveryMode(state, round) !== 'usb') return null;

  const games = state.scheduledGames.filter(
    (game) =>
      game.roundId === roundId &&
      !game.bye &&
      game.status !== 'cancelled' &&
      game.status !== 'accepted',
  );
  const missing = games.filter(
    (game) =>
      !state.transfers.assignments.some(
        (transfer) =>
          transfer.scheduledGameId === game.id &&
          transfer.roundRevision === round.revision &&
          transfer.assignmentRevision === game.assignmentRevision &&
          transfer.status === 'written',
      ),
  );
  if (missing.length === 0) return null;

  if (state.transfers.locations.length === 0) {
    return `${round.name} is configured for USB delivery, but ${missing.length} current assignment${missing.length === 1 ? '' : 's'} still need${missing.length === 1 ? 's' : ''} to be prepared and no transfer location is configured. Add a USB or folder in Transfers first.`;
  }

  const labels = missing.slice(0, 3).map((game) => {
    const left = state.teams.find((team) => team.id === game.leftTeamId)?.displayName ?? 'Unknown team';
    const right = game.rightTeamId
      ? (state.teams.find((team) => team.id === game.rightTeamId)?.displayName ?? 'Unknown team')
      : 'Bye';
    const room = game.roomId ? state.rooms.find((entry) => entry.id === game.roomId)?.name : undefined;
    return `${left} vs ${right}${room ? ` (${room})` : ''}`;
  });
  const remainder = missing.length - labels.length;
  const detail = `${labels.join(', ')}${remainder > 0 ? ` and ${remainder} more` : ''}`;
  return `${round.name} cannot start yet: ${missing.length} USB assignment${missing.length === 1 ? '' : 's'} ${missing.length === 1 ? 'has' : 'have'} not been prepared for the current round/assignment revision. Prepare ${detail} in Transfers first.`;
}

/**
 * Public structured mutation results must describe an observed canonical mutation, not only a
 * successful planning calculation. Generation can either add a new round or append games to an
 * already-materialized round, so observe both identities and round revisions.
 */
export function generatedRoundCommitObserved(before: DirectorState, after: DirectorState): boolean {
  const previousGames = new Set(before.scheduledGames.map((game) => game.id));
  if (after.scheduledGames.some((game) => !previousGames.has(game.id))) return true;

  const previousRounds = new Map(before.rounds.map((round) => [round.id, round.revision]));
  return after.rounds.some(
    (round) => !previousRounds.has(round.id) || previousRounds.get(round.id) !== round.revision,
  );
}
