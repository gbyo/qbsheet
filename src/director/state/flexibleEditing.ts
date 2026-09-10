import {
  isoNow,
  newDirectorId,
  plannedEliminationGameForTeam,
  qbtcpSessionHasUnresolvedWork,
  unresolvedBracketDependencyForTeam,
  unresolvedScheduledGameForTeam,
  type DirectorId,
  type DirectorState,
} from '../domain';
import type { DirectorController } from './useDirectorController';

export interface RoundRemovalImpact {
  acceptedResults: number;
  activeResults: number;
  submissions: number;
  protests: number;
  prepared: boolean;
  writtenAssignments: number;
  assignmentArtifacts: number;
  activeQbtcpSessions: number;
  releasedOrClosed: boolean;
}

export function roundRemovalImpact(state: DirectorState, roundId: DirectorId): RoundRemovalImpact | null {
  const round = state.rounds.find((entry) => entry.id === roundId);
  if (!round) return null;
  const scheduledIds = new Set(
    state.scheduledGames.filter((game) => game.roundId === roundId).map((game) => game.id),
  );
  round.scheduledGameIds.forEach((gameId) => scheduledIds.add(gameId));
  const gameIds = new Set(
    state.games
      .filter((game) => game.roundId === roundId || scheduledIds.has(game.scheduledGameId))
      .map((game) => game.id),
  );
  const roundGames = state.scheduledGames.filter((game) => scheduledIds.has(game.id));
  const roundRoomIds = new Set(
    roundGames.map((game) => game.roomId).filter((roomId): roomId is DirectorId => roomId !== null),
  );
  return {
    acceptedResults: state.games.filter(
      (game) => gameIds.has(game.id) && (game.status === 'accepted' || game.status === 'forfeit'),
    ).length,
    activeResults: state.games.filter(
      (game) => gameIds.has(game.id) && (game.status === 'live' || game.status === 'submitted'),
    ).length,
    submissions: state.submissions.filter((submission) => gameIds.has(submission.gameId)).length,
    protests: state.protests.filter((protest) => gameIds.has(protest.gameId)).length,
    prepared: round.status === 'prepared',
    writtenAssignments: (state.transfers?.assignments ?? []).filter(
      (assignment) => assignment.status === 'written' && scheduledIds.has(assignment.scheduledGameId),
    ).length,
    assignmentArtifacts: (state.transfers?.artifacts ?? []).filter(
      (artifact) =>
        artifact.classification === 'assignment' &&
        artifact.scheduledGameId !== undefined &&
        scheduledIds.has(artifact.scheduledGameId),
    ).length,
    activeQbtcpSessions: state.qbtcpSessions.filter(
      (session) =>
        qbtcpSessionHasUnresolvedWork(state, session) &&
        ((session.matchId !== undefined && scheduledIds.has(session.matchId)) ||
          (session.matchId === undefined && roundRoomIds.has(session.roomId))),
    ).length,
    releasedOrClosed: round.status === 'released' || round.status === 'closed',
  };
}

export function roundRemovalBlocker(state: DirectorState, roundId: DirectorId): string | null {
  const round = state.rounds.find((entry) => entry.id === roundId);
  const impact = roundRemovalImpact(state, roundId);
  if (!round || !impact) return null;
  if (
    !impact.releasedOrClosed &&
    impact.acceptedResults === 0 &&
    impact.activeResults === 0 &&
    impact.submissions === 0 &&
    impact.protests === 0 &&
    !impact.prepared &&
    impact.writtenAssignments === 0 &&
    impact.assignmentArtifacts === 0 &&
    impact.activeQbtcpSessions === 0
  ) {
    return null;
  }
  const details = [
    impact.acceptedResults > 0
      ? `${impact.acceptedResults} accepted/forfeit result${impact.acceptedResults === 1 ? '' : 's'}`
      : null,
    impact.activeResults > 0
      ? `${impact.activeResults} live/submitted result${impact.activeResults === 1 ? '' : 's'}`
      : null,
    impact.submissions > 0
      ? `${impact.submissions} result submission${impact.submissions === 1 ? '' : 's'}`
      : null,
    impact.protests > 0 ? `${impact.protests} protest${impact.protests === 1 ? '' : 's'}` : null,
    impact.prepared ? 'prepared scorer assignments may be in circulation' : null,
    impact.writtenAssignments > 0
      ? `${impact.writtenAssignments} written assignment${impact.writtenAssignments === 1 ? '' : 's'}`
      : null,
    impact.assignmentArtifacts > 0
      ? `${impact.assignmentArtifacts} assignment artifact${impact.assignmentArtifacts === 1 ? '' : 's'}`
      : null,
    impact.activeQbtcpSessions > 0
      ? `${impact.activeQbtcpSessions} active/resumable QBTCP session${impact.activeQbtcpSessions === 1 ? '' : 's'}`
      : null,
  ].filter((value): value is string => value !== null);
  const exposure = details.length > 0 ? ` It has ${details.join(', ')}.` : '';
  const assignmentExposure =
    impact.prepared ||
    impact.writtenAssignments > 0 ||
    impact.assignmentArtifacts > 0 ||
    impact.activeQbtcpSessions > 0;
  if (assignmentExposure) {
    return `${round.name} has exposed scorer work and cannot be removed as ordinary planning cleanup.${exposure} Retract or invalidate every distributed assignment first, then use Advanced recovery or restore a recovery point if you intentionally need to rewrite this round; keep any late or stale results in review.`;
  }
  return `${round.name} has competitive history and cannot be removed as ordinary planning cleanup.${exposure} Restore or edit from a recovery point if you intentionally need to rewrite played history.`;
}

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

  const operationalGame = unresolvedScheduledGameForTeam(next, teamId);
  if (operationalGame) {
    // Flexible editing may reconcile future schedule intent, but cannot bypass the lifecycle
    // guard used by the normal team-drop operation.
    controller.dropTeam(teamId, reason);
    return false;
  }
  const plannedElimination = plannedEliminationGameForTeam(next, teamId);
  if (plannedElimination) {
    // Route through the authoritative cancellation guard so the Director returns the same
    // replacement/forfeit guidance as an explicit cancellation, without mutating this snapshot.
    controller.cancelScheduledGame(
      plannedElimination.id,
      'A planned elimination game needs an explicit bracket resolution before a team can be dropped.',
    );
    return false;
  }
  const bracketDependency = unresolvedBracketDependencyForTeam(next, teamId);
  if (bracketDependency) {
    // Re-run through the controller guard so the operator receives the same explicit recovery
    // instruction as a direct drop attempt; no snapshot is mutated.
    controller.dropTeam(teamId, reason);
    return false;
  }

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
    const cancellationAuditId = newDirectorId('audit');
    scheduled.cancellation = {
      reasonKind: 'team-dropped',
      teamId,
      reason: normalizedReason,
      at: now,
      auditId: cancellationAuditId,
    };
    next.audit.push({
      id: cancellationAuditId,
      at: now,
      actor: 'Director',
      type: 'schedule-cancelled',
      summary: `Cancelled ${scheduled.id} because ${team.displayName} was dropped.`,
      entityId: scheduled.id,
      details: { reason: normalizedReason, reasonKind: 'team-dropped', teamId, roundId: scheduled.roundId },
    });
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
    type: 'team-dropped',
    summary: `Dropped ${team.displayName}.`,
    entityId: team.id,
    details: { reason: normalizedReason, cancelledScheduledGameIds },
  });
  return controller.editTournamentSnapshot(next, `Before dropping ${current.displayName}`);
}

/** Ordinary flexible removal is for unplayed planning structure, never canonical competitive history. */
export async function removeRoundFlexibly(
  controller: DirectorController,
  roundId: DirectorId,
): Promise<boolean> {
  const state = JSON.parse(controller.exportSnapshot()) as DirectorState;
  if (roundRemovalBlocker(state, roundId)) return false;
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
