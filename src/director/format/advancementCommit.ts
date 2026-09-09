import { newDirectorId, previewAdvancement, type DirectorState } from '../domain';
import type {
  CommitAdvancementInput,
  CommitAdvancementResult,
  DirectorController,
} from '../state/useDirectorController';

type AdvancementCommitPlan =
  | { ok: true; next: DirectorState; assigned: number; overridden: string[]; message: string }
  | { ok: false; result: CommitAdvancementResult };

function failed(message: string, overridden: string[] = []): AdvancementCommitPlan {
  return { ok: false, result: { committed: false, message, assigned: 0, overridden } };
}

/** Every target pool gets an explicit final membership, including zero-team pools. */
export function completeTargetPoolMembership(
  targetPoolIds: readonly string[],
  assignments: readonly CommitAdvancementInput['assignments'][number][],
): Map<string, string[]> {
  const byPool = new Map(targetPoolIds.map((poolId) => [poolId, [] as string[]]));
  for (const assignment of assignments) {
    if (assignment.targetPoolId === undefined) continue;
    byPool.get(assignment.targetPoolId)?.push(assignment.teamId);
  }
  return byPool;
}

/**
 * Build the complete target-stage membership in memory before any state is changed.
 *
 * The old controller grouped only pools present in `input.assignments`; an omitted target pool was
 * therefore never written and retained membership from the previous advancement commit. This plan
 * starts every target pool at an explicit empty list and fills the complete desired state before a
 * single checkpoint-backed edit is applied.
 */
export function planAdvancementCommit(
  state: DirectorState,
  input: CommitAdvancementInput,
): AdvancementCommitPlan {
  const source = state.phases.find((phase) => phase.id === input.sourcePhaseId);
  const target = state.phases.find((phase) => phase.id === input.targetPhaseId);
  if (!state.tournament || !source || !target) return failed('Choose valid source and target stages.');
  if (source.id === target.id) return failed('Advancement must move teams to a different stage.');
  if (source.archived || target.archived) return failed('Archived stages cannot be used for advancement.');
  if (source.status !== 'complete') return failed(`Finish ${source.name} before committing advancement.`);
  if (input.assignments.length === 0)
    return failed('Assign at least one team before committing advancement.');

  const targetPoolIds = new Set(target.poolIds);
  if (targetPoolIds.size === 0) return failed(`${target.name} has no target pools.`);
  if (target.poolIds.some((poolId) => !state.pools.some((pool) => pool.id === poolId))) {
    return failed(`${target.name} contains a missing pool. Repair the stage before advancing teams.`);
  }
  // The target stage is pooled here, so an assignment without a pool cannot be placed.
  if (
    input.assignments.some(
      (assignment) => assignment.targetPoolId === undefined || !targetPoolIds.has(assignment.targetPoolId),
    )
  ) {
    return failed('Every advancement assignment must target a pool in the selected stage.');
  }

  const assignedTeamIds = input.assignments.map((assignment) => assignment.teamId);
  if (new Set(assignedTeamIds).size !== assignedTeamIds.length) {
    return failed('A team can only be assigned to one target pool.');
  }
  if (
    assignedTeamIds.some(
      (teamId) => !state.teams.some((team) => team.id === teamId && team.status === 'confirmed'),
    )
  ) {
    return failed('Only confirmed tournament teams can be advanced.');
  }

  const preview = previewAdvancement(state, source);
  const qualifierIds = new Set(preview.qualifiers.map((team) => team.id));
  const overridden = assignedTeamIds.filter((teamId) => !qualifierIds.has(teamId));
  const reason = input.reason?.trim() ?? '';
  if (overridden.length > 0 && !source.advancementRule?.manualOverrideAllowed) {
    return failed('This advancement rule does not allow manual qualifier overrides.', overridden);
  }
  if (overridden.length > 0 && reason === '') {
    return failed('Explain why the committed qualifiers differ from the standings preview.', overridden);
  }
  if (preview.unresolved.length > 0 && reason === '') {
    return failed('Resolve the tied advancement cutoff and record the Director decision.', overridden);
  }

  const targetRoundIds = new Set(target.roundIds);
  if (state.scheduledGames.some((game) => targetRoundIds.has(game.roundId))) {
    return failed('Remove target-stage pairings before recommitting advancement.', overridden);
  }

  const next = structuredClone(state);
  const byPool = completeTargetPoolMembership(target.poolIds, input.assignments);
  for (const poolId of target.poolIds) {
    const pool = next.pools.find((entry) => entry.id === poolId);
    if (pool) pool.teamIds = [...(byPool.get(poolId) ?? [])];
  }

  const now = new Date().toISOString();
  next.audit.push({
    id: newDirectorId('audit'),
    at: now,
    actor: 'Director',
    type: 'advancement-committed',
    summary: `Committed ${input.assignments.length} team${input.assignments.length === 1 ? '' : 's'} from ${source.name} to ${target.name}.`,
    entityId: target.id,
    details: {
      sourcePhaseId: source.id,
      assignments: structuredClone(input.assignments),
      overridden,
      reason: reason || undefined,
    },
  });
  return {
    ok: true,
    next,
    assigned: input.assignments.length,
    overridden,
    message: `Committed ${input.assignments.length} advancement placement${input.assignments.length === 1 ? '' : 's'} to ${target.name}.`,
  };
}

export async function commitAdvancementSafely(
  controller: DirectorController,
  state: DirectorState,
  input: CommitAdvancementInput,
): Promise<CommitAdvancementResult> {
  const plan = planAdvancementCommit(state, input);
  if (!plan.ok) return plan.result;
  const source = state.phases.find((phase) => phase.id === input.sourcePhaseId);
  const applied = await controller.editTournamentSnapshot(
    plan.next,
    `Before committing advancement${source ? ` from ${source.name}` : ''}`,
  );
  if (!applied) {
    return {
      committed: false,
      message: 'Advancement could not be saved. Review the Director warning and try again.',
      assigned: 0,
      overridden: plan.overridden,
    };
  }
  return {
    committed: true,
    message: plan.message,
    assigned: plan.assigned,
    overridden: plan.overridden,
  };
}
