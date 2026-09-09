import type { DirectorId, DirectorState } from './model';
import { currentPhase } from './scheduling';
import {
  runPreflight as runBasePreflight,
  type PreflightIssue,
  type QbtcpPreflightHealth,
} from './validationBase';

export * from './validationBase';

/**
 * A later-phase round may exist as plan structure before advancement supplies its field. That empty
 * round is deferred work, not a tournament-wide readiness failure. The current phase remains strict
 * and prepare/start still use the base round validator directly.
 */
export function deferredEmptyRoundIsExpected(state: DirectorState, roundId: DirectorId): boolean {
  const round = state.rounds.find((entry) => entry.id === roundId);
  if (!round || round.status !== 'planned') return false;
  if (state.scheduledGames.some((game) => game.roundId === roundId)) return false;
  const phase = state.phases.find((entry) => entry.id === round.phaseId);
  const current = currentPhase(state);
  if (!phase || !current || phase.id === current.id) return false;
  return phase.order > current.order;
}

export function runPreflight(
  state: DirectorState,
  nativeServerReady = false,
  nativeServerAvailable = true,
  qbtcpHealth?: QbtcpPreflightHealth,
): PreflightIssue[] {
  const deferredIssueIds = new Set(
    state.rounds
      .filter((round) => deferredEmptyRoundIsExpected(state, round.id))
      .map((round) => `round-invalid-${round.id}`),
  );
  return runBasePreflight(state, nativeServerReady, nativeServerAvailable, qbtcpHealth).filter(
    (issue) => !deferredIssueIds.has(issue.id),
  );
}
