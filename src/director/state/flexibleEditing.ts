import { qbtcpSessionHasUnresolvedWork, type DirectorId, type DirectorState } from '../domain';
import type { DirectorController } from './useDirectorController';
import { removeRoundFlexibly as removeRoundBase } from './flexibleEditingBase';

export * from './flexibleEditingBase';

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

/** Ordinary flexible removal is for unplayed planning structure, never canonical competitive history. */
export async function removeRoundFlexibly(
  controller: DirectorController,
  roundId: DirectorId,
): Promise<boolean> {
  const state = JSON.parse(controller.exportSnapshot()) as DirectorState;
  if (roundRemovalBlocker(state, roundId)) return false;
  return removeRoundBase(controller, roundId);
}
