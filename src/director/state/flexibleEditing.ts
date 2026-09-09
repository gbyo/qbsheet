import type { DirectorId, DirectorState } from '../domain';
import type { DirectorController } from './useDirectorController';
import { removeRoundFlexibly as removeRoundBase } from './flexibleEditingBase';

export * from './flexibleEditingBase';

export interface RoundRemovalImpact {
  acceptedResults: number;
  activeResults: number;
  submissions: number;
  protests: number;
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
  return {
    acceptedResults: state.games.filter(
      (game) => gameIds.has(game.id) && (game.status === 'accepted' || game.status === 'forfeit'),
    ).length,
    activeResults: state.games.filter(
      (game) => gameIds.has(game.id) && (game.status === 'live' || game.status === 'submitted'),
    ).length,
    submissions: state.submissions.filter((submission) => gameIds.has(submission.gameId)).length,
    protests: state.protests.filter((protest) => gameIds.has(protest.gameId)).length,
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
    impact.protests === 0
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
    impact.protests > 0 ? `${impact.protests} protest${impact.protests === 1 ? '' : 's'}` : null,
  ].filter((value): value is string => value !== null);
  const history = details.length > 0 ? ` It contains ${details.join(', ')}.` : '';
  return `${round.name} has competitive history and cannot be removed as ordinary planning cleanup.${history} Restore or edit from a recovery point if you intentionally need to rewrite played history.`;
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
