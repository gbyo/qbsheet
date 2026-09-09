import { isoNow, newDirectorId, type DirectorId, type DirectorState, type TournamentStatus } from './model';
import { tournamentCompletionBlockers } from './scheduling';

export interface TournamentStatusTransitionOptions {
  /** Reopen is the only archived-document write exception. */
  allowArchivedReopen?: boolean;
  reason?: 'explicit-reopen';
}

export type TournamentStatusTransitionPlan =
  | { ok: true; from: TournamentStatus; to: TournamentStatus; reason?: 'explicit-reopen' }
  | { ok: false; message: string; blockers: string[] };

/**
 * The single authoritative lifecycle validator. It is deliberately independent of React and
 * persistence so the open-document and inactive-catalog paths cannot drift.
 */
export function planTournamentStatusTransition(
  state: DirectorState,
  status: TournamentStatus,
  options: TournamentStatusTransitionOptions = {},
): TournamentStatusTransitionPlan {
  const current = state.tournament;
  if (!current) {
    return {
      ok: false,
      blockers: [],
      message: 'Create a tournament before changing its lifecycle.',
    };
  }
  if (current.status === status) return { ok: true, from: current.status, to: status };
  if (current.status === 'archived' && status === 'draft' && !options.allowArchivedReopen) {
    return {
      ok: false,
      blockers: [],
      message: 'Use Reopen as draft to make an archived tournament editable.',
    };
  }
  if (options.reason === 'explicit-reopen' && (current.status !== 'archived' || status !== 'draft')) {
    return {
      ok: false,
      blockers: [],
      message: 'Only an archived tournament can be reopened as a draft.',
    };
  }
  const blockers =
    current.status === 'running' && status === 'complete' ? tournamentCompletionBlockers(state) : [];
  const valid =
    (current.status === 'draft' &&
      status === 'running' &&
      state.rounds.some((round) => round.status !== 'planned')) ||
    (current.status === 'running' && status === 'complete' && blockers.length === 0) ||
    (current.status === 'complete' && status === 'archived') ||
    (current.status === 'complete' && status === 'running') ||
    (current.status === 'archived' && status === 'draft' && options.allowArchivedReopen === true);
  if (valid) return { ok: true, from: current.status, to: status, reason: options.reason };
  return {
    ok: false,
    blockers,
    message:
      blockers.length > 0
        ? `Cannot complete the tournament: ${blockers.join(' ')}`
        : `Cannot change a ${current.status} tournament to ${status}.`,
  };
}

/** Apply a previously planned transition and append its canonical audit event. */
export function applyTournamentStatusTransition(
  state: DirectorState,
  plan: Extract<TournamentStatusTransitionPlan, { ok: true }>,
  actor: string,
): void {
  if (!state.tournament || plan.from === plan.to) return;
  const now = isoNow();
  state.tournament.status = plan.to;
  state.tournament.updatedAt = now;
  state.audit.push({
    id: newDirectorId('audit'),
    at: now,
    actor,
    type: 'tournament-updated',
    summary:
      plan.reason === 'explicit-reopen'
        ? 'Reopened tournament as a draft.'
        : `Tournament lifecycle changed from ${plan.from} to ${plan.to}.`,
    entityId: state.tournament.id as DirectorId,
    details: {
      from: plan.from,
      to: plan.to,
      ...(plan.reason ? { reason: plan.reason } : {}),
    },
  });
}
