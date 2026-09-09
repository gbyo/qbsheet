import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { MemoryDirectorRepository } from '../persistence';
import { directorFixture } from '../transfers/testFixtures';
import { useDirectorController, type DirectorController } from '../state/useDirectorController';
import { TeamsView } from './TeamsView';
import type { DirectorNavigationTarget } from '../app/navigationTarget';

test('a rejected bulk import does not announce success or close the paste dialog', () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const state = directorFixture();
  const announce = vi.fn();
  const addImportedTeams = vi.fn(() => ({ ok: false as const, inserted: 0 as const, skipped: 0 as const }));
  const controller = { addImportedTeams } as unknown as DirectorController;

  render(<TeamsView state={state} controller={controller} onAnnounce={announce} />);
  fireEvent.click(screen.getByRole('button', { name: 'Import' }));
  fireEvent.click(screen.getByRole('option', { name: 'Paste teams…' }));
  fireEvent.change(screen.getByLabelText('Team CSV'), {
    target: { value: 'team_name\nRejected team' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Import teams' }));

  expect(addImportedTeams).toHaveBeenCalledOnce();
  expect(announce).not.toHaveBeenCalledWith(expect.stringContaining('0 teams imported'));
  expect(screen.getByRole('dialog')).toBeTruthy();
});

test('team filtering matches unaccented team, organization, and player searches without changing display text', () => {
  const state = directorFixture({ games: 1 });
  const team = state.teams[0]!;
  team.displayName = 'Café A';
  team.organizationId = 'org-café';
  state.organizations = [{ id: 'org-café', name: 'Café University', shortName: '', notes: '' }];
  state.players[0]!.name = 'José García';

  render(<TeamsView state={state} controller={{} as DirectorController} onAnnounce={vi.fn()} />);

  const filter = screen.getByRole('searchbox', { name: 'Filter teams' });
  fireEvent.change(filter, { target: { value: 'Jose' } });
  expect(screen.getByRole('button', { name: 'Café A' })).toBeInTheDocument();
  expect(screen.getByText('1 of 2 teams')).toBeInTheDocument();

  fireEvent.change(filter, { target: { value: 'University' } });
  expect(screen.getByRole('button', { name: 'Café A' })).toBeInTheDocument();

  fireEvent.change(filter, { target: { value: 'unrelated' } });
  expect(screen.getByText('No teams match the current search.')).toBeInTheDocument();
  expect(team.displayName).toBe('Café A');
  expect(state.players[0]!.name).toBe('José García');
});

test('Schools & clubs exposes a real list and the current organization selection', () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const state = directorFixture();
  state.organizations = [
    { id: 'org-northview', name: 'Northview', shortName: '', notes: '' },
    { id: 'org-riverside', name: 'Riverside', shortName: '', notes: '', archived: true },
  ];
  const controller = {
    updateOrganization: vi.fn(() => true),
    setOrganizationArchived: vi.fn(() => true),
    addOrganization: vi.fn(() => true),
  } as unknown as DirectorController;

  render(<TeamsView state={state} controller={controller} onAnnounce={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Schools & clubs' }));

  const dialog = screen.getByRole('dialog');
  const list = within(dialog).getByRole('list', { name: 'Schools and clubs' });
  const items = within(list).getAllByRole('listitem');
  expect(items).toHaveLength(2);

  const northview = within(items[0]).getByRole('button', { name: 'Northview' });
  const riverside = within(items[1]).getByRole('button', { name: /Riverside/ });
  expect(northview).toHaveAttribute('aria-current', 'true');
  expect(riverside).not.toHaveAttribute('aria-current');

  fireEvent.click(riverside);
  expect(northview).not.toHaveAttribute('aria-current');
  expect(riverside).toHaveAttribute('aria-current', 'true');
});

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
