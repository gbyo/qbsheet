import { effectiveRoundDeliveryMode, type DirectorId, type DirectorState } from '../domain';

/**
 * USB delivery is ready only when every unresolved competitive game has a successfully written
 * assignment from the current round and assignment revisions. A configured destination alone is
 * not evidence that a scorekeeper has a usable file.
 */
export function usbRoundDeliveryBlocker(state: DirectorState, roundId: DirectorId): string | null {
  const round = state.rounds.find((entry) => entry.id === roundId);
  if (!round) return 'That round is no longer in the tournament workspace.';
  if (effectiveRoundDeliveryMode(state, round) !== 'usb') return null;

  const missing = state.scheduledGames.filter(
    (game) =>
      game.roundId === roundId &&
      !game.bye &&
      game.status !== 'cancelled' &&
      game.status !== 'accepted' &&
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
  return `${round.name} cannot start yet: ${missing.length} USB assignment${missing.length === 1 ? '' : 's'} ${missing.length === 1 ? 'has' : 'have'} not been prepared for the current round/assignment revision. Prepare the current assignments in Transfers first.`;
}
