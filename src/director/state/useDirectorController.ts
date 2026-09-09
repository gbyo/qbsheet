import { useMemo, useState } from 'react';
import {
  useDirectorController as useBaseDirectorController,
  type DirectorController,
  type StartRoundResult,
} from './useDirectorControllerBase';
import {
  advancementCommitBlocker,
  releasedRoundResultBlocker,
  scheduledGameIdForSubmission,
  unresolvedReleasedRoundBlocker,
} from './tournamentSafety';

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
  const [safetyIssue, setSafetyIssue] = useState<{
    message: string;
    state: DirectorController['state'];
    baseError: string | null;
  } | null>(null);
  // A local blocker belongs to the snapshot that produced it. A later canonical mutation/error
  // therefore supersedes it without a state-setting effect or a transient extra render.
  const safetyError =
    safetyIssue?.state === base.state && safetyIssue.baseError === base.error ? safetyIssue.message : null;

  return useMemo<DirectorController>(() => {
    const resultBlocker = (scheduledGameId: string): string | null =>
      releasedRoundResultBlocker(base.state, scheduledGameId);
    const raise = (message: string) => setSafetyIssue({ message, state: base.state, baseError: base.error });
    const reject = (message: string): false => {
      raise(message);
      return false;
    };
    const allow = () => setSafetyIssue(null);

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
      releaseRound(roundId) {
        const blocker = unresolvedReleasedRoundBlocker(base.state, roundId);
        if (blocker) return reject(blocker);
        allow();
        return base.releaseRound(roundId);
      },
      async startRound(roundId): Promise<StartRoundResult> {
        const blocker = unresolvedReleasedRoundBlocker(base.state, roundId);
        if (blocker) {
          raise(blocker);
          const round = base.state.rounds.find((entry) => entry.id === roundId);
          return {
            ok: false,
            roundId,
            roundName: round?.name ?? 'Unknown round',
            deliveredGames: 0,
            pendingHandoffs: [],
            summary: blocker,
            reason: blocker,
          };
        }
        allow();
        return base.startRound(roundId);
      },
      commitAdvancement(input) {
        const blocker = advancementCommitBlocker(base.state, input.sourcePhaseId);
        if (blocker) {
          raise(blocker);
          return { committed: false, message: blocker, assigned: 0, overridden: [] };
        }
        allow();
        return base.commitAdvancement(input);
      },
    };
  }, [base, safetyError]);
}
