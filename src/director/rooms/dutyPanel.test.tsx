import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { DirectorState } from '../domain';
import { tournamentState } from '../../../tests/directorFixtures';
import type { DirectorController } from '../state/useDirectorController';
import { DutyPanel, type OperationsContext } from './operations';

function dutyState(assignedRunnerIds: string[]): DirectorState {
  const state = tournamentState();
  state.staff.push(
    { id: 'alice', name: 'Alice', roles: ['runner'], available: false },
    { id: 'bob', name: 'Bob', roles: ['runner'], available: true },
  );
  if (assignedRunnerIds.length > 0) {
    state.operationalAssignments.push({
      id: 'duty-1',
      roundId: 'round-1',
      kind: 'runner',
      staffIds: assignedRunnerIds,
    } as DirectorState['operationalAssignments'][number]);
  }
  return state;
}

function renderDuties(state: DirectorState) {
  const controller = { setRoundDuty: vi.fn(() => true) } as unknown as DirectorController;
  const context = { roundId: 'round-1', roundName: 'Round 1' } as OperationsContext;
  render(<DutyPanel state={state} controller={controller} context={context} onAnnounce={() => undefined} />);
}

describe('Duties picker candidates (#714)', () => {
  test('an unavailable unassigned runner is not offered', async () => {
    renderDuties(dutyState([]));
    await userEvent.click(screen.getByRole('button', { name: /Runners for Round 1/ }));
    expect(screen.getByRole('checkbox', { name: /Bob/ })).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: /Alice/ })).toBeNull();
  });

  test('an unavailable assigned runner stays visible until unassigned', async () => {
    renderDuties(dutyState(['alice']));
    await userEvent.click(screen.getByRole('button', { name: /Runners for Round 1/ }));
    const alice = screen.getByRole('checkbox', { name: /Alice/ });
    expect(alice).toBeVisible();
    expect(alice).toBeChecked();
  });
});
