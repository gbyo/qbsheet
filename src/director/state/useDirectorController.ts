import { isoNow, newDirectorId, type DirectorId, type DirectorState } from '../domain';
import {
  useDirectorController as useBaseDirectorController,
  type DirectorController as BaseDirectorController,
} from './useDirectorController.base';

export * from './useDirectorController.base';

/**
 * Director mutations that intentionally favor operator intent over rigid lifecycle guards.
 *
 * The underlying controller already owns validation, normalization, persistence, publication,
 * and recovery. These operations build a complete next snapshot and hand it back through the
 * controller's supported import path, so they remain atomic without duplicating its save stack.
 */
export interface DirectorController extends BaseDirectorController {
  removeRound(roundId: DirectorId): boolean;
}

export function useDirectorController(
  ...args: Parameters<typeof useBaseDirectorController>
): DirectorController {
  const base = useBaseDirectorController(...args);

  const dropTeam = (teamId: DirectorId, reason = 'Dropped by director'): boolean => {
    const current = base.state.teams.find((team) => team.id === teamId);
    if (!current || current.status === 'dropped') return base.dropTeam(teamId, reason);

    const next = structuredClone(base.state) as DirectorState;
    const team = next.teams.find((entry) => entry.id === teamId);
    if (!team) return false;

    const now = isoNow();
    const normalizedReason = reason.trim() || 'Dropped by director';
    const roundById = new Map(next.rounds.map((round) => [round.id, round]));
    const cancelledScheduledGameIds: DirectorId[] = [];

    team.status = 'dropped';
    team.updatedAt = now;
    // Team notes are director-authored registration data. A status toggle must never append
    // machine-generated text such as “Dropped by director” to that field.

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
      details: {
        reason: normalizedReason,
        cancelledScheduledGameIds,
      },
    });

    return base.importSnapshot(next);
  };

  const removeRound = (roundId: DirectorId): boolean => {
    const current = base.state.rounds.find((round) => round.id === roundId);
    if (!current) return false;

    const next = structuredClone(base.state) as DirectorState;
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

    for (const phase of next.phases) {
      phase.roundIds = phase.roundIds.filter((id) => id !== roundId);
    }
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
      details: {
        removedScheduledGames: scheduledIds.size,
        removedResults: acceptedResultCount,
      },
    });

    return base.importSnapshot(next);
  };

  return {
    ...base,
    dropTeam,
    removeRound,
  };
}
