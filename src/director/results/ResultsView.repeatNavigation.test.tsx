import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DirectorState } from '../domain';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import type { DirectorController } from '../state/useDirectorController';
import { playedTournament, scheduledGame } from '../../../tests/directorFixtures';
import { ResultsView } from './ResultsView';

afterEach(cleanup);

const settledTarget: DirectorNavigationTarget = {
  section: 'results',
  entityType: 'game',
  entityId: 'scheduled-1',
};

function stateWithSettledTarget(): DirectorState {
  const state = playedTournament();
  state.scheduledGames.push(scheduledGame('scheduled-live', 'team-a', 'team-b', { status: 'live' }));
  return state;
}

function scheduleRowIds(): string[] {
  const panel = screen.getByText('Scheduled games').closest('.director-panel') as HTMLElement;
  return within(panel)
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.getAttribute('data-director-navigation-id') ?? '');
}

async function settleNavigation(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

function Harness({ state }: { state: DirectorState }) {
  const [navigationTarget, setNavigationTarget] = useState<DirectorNavigationTarget | null>(null);
  return (
    <>
      <button type="button" onClick={() => setNavigationTarget(settledTarget)}>
        Navigate to settled game
      </button>
      <ResultsView
        state={state}
        controller={{} as DirectorController}
        onAnnounce={vi.fn()}
        navigationTarget={navigationTarget}
        onClearNavigationTarget={() => setNavigationTarget(null)}
      />
    </>
  );
}

test('the same settled game can be revealed again after returning to unresolved only', async () => {
  render(<Harness state={stateWithSettledTarget()} />);

  fireEvent.click(screen.getByRole('button', { name: 'Navigate to settled game' }));
  expect(scheduleRowIds()).toContain('scheduled-1');
  await settleNavigation();
  expect(scheduleRowIds()).toEqual(['scheduled-1', 'scheduled-live']);

  fireEvent.click(screen.getByRole('button', { name: 'Show only unresolved' }));
  expect(scheduleRowIds()).toEqual(['scheduled-live']);

  fireEvent.click(screen.getByRole('button', { name: 'Navigate to settled game' }));
  expect(scheduleRowIds()).toContain('scheduled-1');
  await settleNavigation();
  expect(scheduleRowIds()).toEqual(['scheduled-1', 'scheduled-live']);
});
