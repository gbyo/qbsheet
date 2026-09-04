import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { MemoryDirectorRepository } from '../persistence';
import { directorFixture } from '../transfers/testFixtures';
import { useDirectorController, type DirectorController } from '../state/useDirectorController';
import { TeamsView } from './TeamsView';
import type { DirectorNavigationTarget } from '../app/navigationTarget';

test('navigation opens a team repeatedly and pasted names preserve pending removals and unsaved drafts', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const state = directorFixture();
  const teamId = state.teams[0].id;
  state.rounds = [];
  state.scheduledGames = [];
  state.players = [{ id: 'old-player', teamId, name: 'Remove Me', captain: false, active: true }];
  const repository = new MemoryDirectorRepository();
  await repository.save(state);
  let controller: DirectorController;
  function Harness() {
    controller = useDirectorController(repository);
    const [target, setTarget] = useState<DirectorNavigationTarget | null>(null);
    return (
      <>
        <button onClick={() => setTarget({ section: 'teams', entityType: 'team', entityId: teamId })}>
          Find team
        </button>
        {!controller.loading && (
          <TeamsView
            state={controller.state}
            controller={controller}
            search=""
            onAnnounce={vi.fn()}
            navigationTarget={target}
            onClearNavigationTarget={() => setTarget(null)}
          />
        )}
      </>
    );
  }
  render(<Harness />);
  await waitFor(() => expect(controller!.loading).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Find team' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getAllByRole('button', { name: 'Remove' })[0]);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add player' }));
  fireEvent.change(within(dialog).getByLabelText('Player 1 name'), { target: { value: 'Unsaved Player' } });
  fireEvent.change(within(dialog).getByLabelText(/Paste player names/), {
    target: { value: 'Pasted One\nPasted Two' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add pasted names' }));
  expect(within(dialog).getByDisplayValue('Unsaved Player')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(controller!.saving).toBe(false));
  expect(controller!.state.players.find((player) => player.id === 'old-player')?.active).toBe(false);
  expect(
    controller!.state.players
      .filter((player) => player.teamId === teamId && player.active)
      .map((player) => player.name),
  ).toEqual(['Unsaved Player', 'Pasted One', 'Pasted Two']);
  fireEvent.click(screen.getByRole('button', { name: 'Find team' }));
  expect(within(screen.getByRole('dialog')).getByDisplayValue('Unsaved Player')).toBeTruthy();
});
