import { type DirectorId, type DirectorState, type ScheduledGame, type TeamGameScore } from './model.js';

export interface ResultDecisionIssue {
  code: 'winner-required-tie' | 'invalid-forfeit';
  message: string;
}

export interface ResultDecisionOptions {
  /** An administrative forfeit supplies the winner independently of the score line. */
  forfeitedTeamId?: DirectorId;
}

/**
 * Return the competitive result issue that must block canonical acceptance, if any.
 *
 * A tied score is a valid result in a tie-permitting format. It is not a completed result when
 * overtime is enabled, when the phase is explicitly a final, or when the scheduled game belongs
 * to a bracket. This rule is intentionally independent of transport so manual, imported, and
 * corrected results share one acceptance boundary.
 */
export function resultDecisionIssue(
  state: DirectorState,
  scheduled: ScheduledGame,
  scores: readonly TeamGameScore[],
  options: ResultDecisionOptions = {},
): ResultDecisionIssue | null {
  if (options.forfeitedTeamId !== undefined) {
    return [scheduled.leftTeamId, scheduled.rightTeamId].includes(options.forfeitedTeamId)
      ? null
      : {
          code: 'invalid-forfeit',
          message: 'An administrative forfeit must identify one of the teams in the scheduled game.',
        };
  }
  if (!scheduled.rightTeamId || scores.length !== 2) return null;
  const left = scores.find((score) => score.teamId === scheduled.leftTeamId);
  const right = scores.find((score) => score.teamId === scheduled.rightTeamId);
  if (!left || !right || left.score !== right.score) return null;

  const round = state.rounds.find((entry) => entry.id === scheduled.roundId);
  const phase = round ? state.phases.find((entry) => entry.id === round.phaseId) : undefined;
  const format = phase ? state.formats.find((entry) => entry.id === phase.formatId) : undefined;
  const winnerRequired =
    scheduled.bracketKey !== undefined ||
    format?.kind === 'single-elimination' ||
    phase?.kind === 'final' ||
    state.tournament?.rules.overtime === true;
  if (!winnerRequired) return null;

  return {
    code: 'winner-required-tie',
    message:
      'This result cannot be accepted because the format requires a winner and the final score is tied. Finish any required overtime and enter a decisive score, or record an explicit administrative forfeit.',
  };
}
