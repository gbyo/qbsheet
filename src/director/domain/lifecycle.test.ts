import { describe, expect, test } from 'vitest';
import { defaultRules, emptyDirectorState, type DirectorState, type TournamentStatus } from './model';
import { applyTournamentStatusTransition, planTournamentStatusTransition } from './lifecycle';

function stateWithStatus(status: TournamentStatus): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-lifecycle',
    name: 'Lifecycle test',
    date: '2026-09-09',
    venue: 'Test hall',
    organizer: 'QBSheet',
    status,
    timeZone: 'UTC',
    rules: structuredClone(defaultRules),
    formatId: null,
    currentPhaseId: null,
    currentPacketId: null,
    currentRoundId: null,
    createdAt: '2026-09-09T10:00:00.000Z',
    updatedAt: '2026-09-09T10:00:00.000Z',
  };
  return state;
}

describe('tournament lifecycle parity', () => {
  test.each([
    ['complete', 'archived'],
    ['archived', 'draft'],
  ] as const)('plans %s -> %s identically for current and inactive documents', (from, to) => {
    const current = stateWithStatus(from);
    const inactive = structuredClone(current);
    const options =
      from === 'archived' ? { allowArchivedReopen: true, reason: 'explicit-reopen' as const } : {};
    const currentPlan = planTournamentStatusTransition(current, to, options);
    const inactivePlan = planTournamentStatusTransition(inactive, to, options);

    expect(inactivePlan).toEqual(currentPlan);
    expect(currentPlan.ok).toBe(true);
    if (currentPlan.ok && inactivePlan.ok) {
      applyTournamentStatusTransition(current, currentPlan, 'Operator');
      applyTournamentStatusTransition(inactive, inactivePlan, 'Operator');
    }
    expect(inactive.tournament?.status).toBe(current.tournament?.status);
    expect(inactive.audit.at(-1)).toMatchObject({
      actor: 'Operator',
      type: 'tournament-updated',
      summary: current.audit.at(-1)?.summary,
      details: current.audit.at(-1)?.details,
    });
  });

  test('rejects incomplete completion without mutation or audit', () => {
    const current = stateWithStatus('running');
    const inactive = structuredClone(current);
    const before = structuredClone(inactive);
    const currentPlan = planTournamentStatusTransition(current, 'complete');
    const inactivePlan = planTournamentStatusTransition(inactive, 'complete');

    expect(inactivePlan).toEqual(currentPlan);
    expect(currentPlan).toMatchObject({
      ok: false,
      message: expect.stringContaining('Generate and resolve'),
    });
    expect(inactive).toEqual(before);
    expect(inactive.audit).toHaveLength(0);
  });

  test.each([
    ['draft', 'archived'],
    ['running', 'archived'],
    ['complete', 'draft'],
    ['archived', 'running'],
  ] as const)('rejects invalid %s -> %s identically', (from, to) => {
    const currentPlan = planTournamentStatusTransition(stateWithStatus(from), to);
    const inactivePlan = planTournamentStatusTransition(stateWithStatus(from), to);
    expect(inactivePlan).toEqual(currentPlan);
    expect(currentPlan.ok).toBe(false);
  });
});
