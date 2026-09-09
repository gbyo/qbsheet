import { effectiveRoundDeliveryMode, type DirectorId, type DirectorState } from '../domain';

export function usbRoundDeliveryBlocker(state: DirectorState, roundId: DirectorId): string | null {
  const round = state.rounds.find((entry) => entry.id === roundId);
  if (!round) return 'That round is no longer in the tournament workspace.';
  if (effectiveRoundDeliveryMode(state, round) !== 'usb') return null;
  if (state.transfers.locations.length === 0) {
    return `${round.name} is configured for USB delivery, but no transfer location is configured. Add a USB or folder before starting.`;
  }

  const games = state.scheduledGames.filter(
    (game) => game.roundId === roundId && !game.bye && game.status !== 'cancelled',
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

export function generatedRoundCommitObserved(before: DirectorState, after: DirectorState): boolean {
  const previousRoundIds = new Set(before.rounds.map((round) => round.id));
  return after.rounds.some((round) => !previousRoundIds.has(round.id));
}
