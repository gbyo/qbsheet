import { isoNow, newDirectorId, type DirectorId, type DirectorState } from '../domain';
import type { DirectorController } from './useDirectorController';

/**
 * Apply Director edits that intentionally change already-planned tournament structure.
 *
 * These helpers use the controller's recovery-protected structural edit path so normalization,
 * persistence, publication, and recovery still run through the ordinary controller stack.
 */
export async function dropTeamFlexibly(
  controller: DirectorController,
  teamId: DirectorId,
  reason = 'Dropped by director',
): Promise<boolean> {
  const next = JSON.parse(controller.exportSnapshot()) as DirectorState;
  const current = next.teams.find((team) => team.id === teamId);
  if (!current) return controller.dropTeam(teamId, reason);
  if (current.status === 'dropped') return false;

  const team = next.teams.find((entry) => entry.id === teamId);
  if (!team) return false;

  const now = isoNow();
  const normalizedReason = reason.trim() || 'Dropped by director';
  const roundById = new Map(next.rounds.map((round) => [round.id, round]));
  const cancelledScheduledGameIds: DirectorId[] = [];

  team.status = 'dropped';
  team.updatedAt = now;
  // Notes are director-authored registration data. Status changes belong in the audit trail,
  // never appended to the notes field.

  for (const scheduled of next.scheduledGames) {
    const round = roundById.get(scheduled.roundId);
    if (
      !round ||
      round.status === 'closed' ||
      scheduled.bye ||
      scheduled.status === 'accepted' ||
      scheduled.status === 'cancelled' ||
      (scheduled.leftTeamId !== teamId && scheduled.rightTeamId !== teamId)
    ) {
      continue;
    }

    scheduled.status = 'cancelled';
    cancelledScheduledGameIds.push(scheduled.id);
    for (const game of next.games.filter((entry) => entry.scheduledGameId === scheduled.id)) {
      if (game.status === 'accepted' || game.status === 'forfeit') continue;
      game.status = 'cancelled';
      for (const submission of next.submissions.filter((entry) => entry.gameId === game.id)) {
        if (submission.status === 'received' || submission.status === 'review') {
          submission.status = 'rejected';
          submission.reason = `Team dropped: ${normalizedReason}`;
        }
      }
    }
  }

  next.audit.push({
    id: newDirectorId('audit'),
    at: now,
    actor: 'Director',
    type: 'tournament-updated',
    summary: `Dropped ${team.displayName}.`,
    entityId: team.id,
    details: { reason: normalizedReason, cancelledScheduledGameIds },
  });
  return controller.editTournamentSnapshot(next, `Before dropping ${current.displayName}`);
}

export async function removeRoundFlexibly(
  controller: DirectorController,
  roundId: DirectorId,
): Promise<boolean> {
  const next = JSON.parse(controller.exportSnapshot()) as DirectorState;
  const current = next.rounds.find((round) => round.id === roundId);
  if (!current) return false;

  const scheduledIds = new Set(
    next.scheduledGames.filter((game) => game.roundId === roundId).map((game) => game.id),
  );
  for (const id of current.scheduledGameIds) scheduledIds.add(id);

  const gameIds = new Set(
    next.games
      .filter((game) => game.roundId === roundId || scheduledIds.has(game.scheduledGameId))
      .map((game) => game.id),
  );
  const acceptedResultCount = next.games.filter(
    (game) => gameIds.has(game.id) && (game.status === 'accepted' || game.status === 'forfeit'),
  ).length;

  next.submissions = next.submissions.filter((submission) => !gameIds.has(submission.gameId));
  next.protests = next.protests.filter((protest) => !gameIds.has(protest.gameId));
  next.games = next.games.filter((game) => !gameIds.has(game.id));
  next.scheduledGames = next.scheduledGames.filter(
    (game) => game.roundId !== roundId && !scheduledIds.has(game.id),
  );
  next.rounds = next.rounds.filter((round) => round.id !== roundId);

  for (const phase of next.phases) phase.roundIds = phase.roundIds.filter((id) => id !== roundId);
  for (const packet of next.packets) {
    packet.assignedRoundIds = packet.assignedRoundIds.filter((id) => id !== roundId);
    packet.assignedGameIds = packet.assignedGameIds.filter((id) => !scheduledIds.has(id));
    packet.usedGameIds = packet.usedGameIds.filter((id) => !scheduledIds.has(id));
  }
  next.qbtcpSessions = next.qbtcpSessions.filter(
    (session) => !session.matchId || !scheduledIds.has(session.matchId),
  );

  if (next.tournament?.currentRoundId === roundId) {
    const replacement = [...next.rounds]
      .filter((round) => round.phaseId === current.phaseId)
      .sort((left, right) => left.number - right.number)
      .at(-1);
    next.tournament.currentRoundId = replacement?.id ?? null;
    next.tournament.updatedAt = isoNow();
  }

  next.audit.push({
    id: newDirectorId('audit'),
    at: isoNow(),
    actor: 'Director',
    type: 'tournament-updated',
    summary: `Removed ${current.name}.`,
    entityId: roundId,
    details: { removedScheduledGames: scheduledIds.size, removedResults: acceptedResultCount },
  });
  return controller.editTournamentSnapshot(next, `Before removing ${current.name}`);
}
