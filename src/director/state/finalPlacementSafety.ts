import type { DirectorId, DirectorState } from '../domain';

/**
 * `setFinalPlacement` historically returned success independently of the shared commit boolean.
 * The commit boundary updates `stateRef` synchronously, so a caller can verify both the requested
 * canonical order and the new audit event before announcing success.
 */
export function canonicalFinalPlacementOrder(
  state: DirectorState,
  requestedOrder: readonly DirectorId[],
): DirectorId[] {
  // Mirrors the commit path: keep the first mention of each team the tournament actually knows.
  const knownTeams = new Set(state.teams.map((team) => team.id));
  const seen = new Set<DirectorId>();
  const order: DirectorId[] = [];
  for (const teamId of requestedOrder) {
    if (seen.has(teamId) || !knownTeams.has(teamId)) continue;
    seen.add(teamId);
    order.push(teamId);
  }
  return order;
}

export function finalPlacementCommitObserved(
  before: DirectorState,
  after: DirectorState,
  requestedOrder: readonly DirectorId[],
): boolean {
  // A request may legitimately name a team twice or name one the tournament does not have; the
  // commit stores the canonical order, so compare against that rather than the raw request.
  const expectedOrder = canonicalFinalPlacementOrder(before, requestedOrder);
  const savedOrder = after.tournament?.finalPlacement?.order;
  if (
    !savedOrder ||
    expectedOrder.length === 0 ||
    savedOrder.length !== expectedOrder.length ||
    savedOrder.some((teamId, index) => teamId !== expectedOrder[index])
  ) {
    return false;
  }
  const priorAuditIds = new Set(before.audit.map((entry) => entry.id));
  return after.audit.some((entry) => entry.type === 'final-placement-set' && !priorAuditIds.has(entry.id));
}
