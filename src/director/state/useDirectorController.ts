import { useMemo, useState } from 'react';
import {
  canonicalAcceptedGame,
  useDirectorController as useBaseDirectorController,
  type DirectorController,
  type StartRoundResult,
} from './useDirectorControllerBase';
import { finalPlacementCommitObserved } from './finalPlacementSafety';
import {
  advancementCommitBlocker,
  advancementCorrectionBlocker,
  assignmentRuleChangeBlocker,
  releasedRoundResultBlocker,
  scheduledGameIdForSubmission,
  unresolvedReleasedRoundBlocker,
} from './tournamentSafety';

export * from './useDirectorControllerBase';

/** Tournament-day invariant boundary around the base Director controller. */
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
        const readinessBlocker = advancementCommitBlocker(base.state, input.sourcePhaseId);
        if (readinessBlocker) {
          raise(readinessBlocker);
          return { committed: false, message: readinessBlocker, assigned: 0, overridden: [] };
        }
        allow();
        return base.commitAdvancement(input);
      },
      editAcceptedResult(gameId, scores, note) {
        const blocker = advancementCorrectionBlocker(base.state, gameId);
        if (blocker) return reject(blocker);
        allow();
        return base.editAcceptedResult(gameId, scores, note);
      },
      correctForfeit(scheduledGameId, replacement, reason) {
        const current = canonicalAcceptedGame(base.state, scheduledGameId);
        const blocker = current ? advancementCorrectionBlocker(base.state, current.id) : null;
        if (blocker) return reject(blocker);
        allow();
        return base.correctForfeit(scheduledGameId, replacement, reason);
      },
      ruleProtest(protestId, ruling, scoreAdjustment) {
        if (scoreAdjustment) {
          const protest = base.state.protests.find((entry) => entry.id === protestId);
          const blocker = protest ? advancementCorrectionBlocker(base.state, protest.gameId) : null;
          if (blocker) return reject(blocker);
        }
        allow();
        return base.ruleProtest(protestId, ruling, scoreAdjustment);
      },
      updateRules(changes) {
        if (Object.keys(changes).length > 0) {
          const blocker = assignmentRuleChangeBlocker(base.state);
          if (blocker) return reject(blocker);
        }
        allow();
        return base.updateRules(changes);
      },
      setFinalPlacement(input) {
        const before = JSON.parse(base.exportSnapshot()) as typeof base.state;
        const result = base.setFinalPlacement(input);
        if (!result.applied) return result;
        const after = JSON.parse(base.exportSnapshot()) as typeof base.state;
        if (!finalPlacementCommitObserved(before, after, input.order)) {
          const message =
            'Final placement was not saved. This Director tab may not currently have write authority; review the warning above and try again.';
          raise(message);
          return { applied: false, message };
        }
        allow();
        return result;
      },
    };
  }, [base, safetyError]);
}
