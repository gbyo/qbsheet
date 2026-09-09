import { useEffect, useMemo, useState } from 'react';
import {
  useDirectorController as useBaseDirectorController,
  type DirectorController,
} from './useDirectorControllerBase';
import { releasedRoundResultBlocker, scheduledGameIdForSubmission } from './tournamentSafety';

export * from './useDirectorControllerBase';

/**
 * Tournament-day safety boundary around the base Director controller.
 *
 * Keep lifecycle invariants here when they must protect several mutation paths at once. The base
 * controller remains the implementation of the mutations; this layer only refuses transitions
 * that would create competitively impossible state.
 */
export function useDirectorController(
  repository?: Parameters<typeof useBaseDirectorController>[0],
): DirectorController {
  const base = useBaseDirectorController(repository);
  const [safetyError, setSafetyError] = useState<string | null>(null);

  // A later canonical mutation/error supersedes a locally raised safety message just as base
  // controller errors are cleared by successful commits.
  useEffect(() => {
    setSafetyError(null);
  }, [base.state, base.error]);

  return useMemo<DirectorController>(() => {
    const resultBlocker = (scheduledGameId: string): string | null =>
      releasedRoundResultBlocker(base.state, scheduledGameId);
    const reject = (message: string): false => {
      setSafetyError(message);
      return false;
    };
    const allow = () => setSafetyError(null);

    return {
      ...base,
      error: safetyError ?? base.error,
      addManualResult(input) {
        const blocker = resultBlocker(input.scheduledGameId);
        if (blocker) return reject(blocker);
        allow();
        return base.addManualResult(input);
      },
      recordForfeit(scheduledGameId, forfeitedTeamId, reason) {
        const blocker = resultBlocker(scheduledGameId);
        if (blocker) return reject(blocker);
        allow();
        return base.recordForfeit(scheduledGameId, forfeitedTeamId, reason);
      },
      associateSubmission(submissionId, scheduledGameId) {
        const blocker = resultBlocker(scheduledGameId);
        if (blocker) return reject(blocker);
        allow();
        return base.associateSubmission(submissionId, scheduledGameId);
      },
      acceptSubmission(submissionId, actor) {
        const scheduledGameId = scheduledGameIdForSubmission(base.state, submissionId);
        if (scheduledGameId) {
          const blocker = resultBlocker(scheduledGameId);
          if (blocker) return reject(blocker);
        }
        allow();
        return base.acceptSubmission(submissionId, actor);
      },
    };
  }, [base, safetyError]);
}
