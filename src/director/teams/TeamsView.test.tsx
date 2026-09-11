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

test('team editor searches organizations, stores the selected id, and exposes explicit creation', () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const state = directorFixture({ games: 0 });
  state.teams = [];
  state.organizations = [
    { id: 'org-northview', name: 'Northview High School', shortName: 'NV', city: 'Rochester', notes: '' },
    { id: 'org-lakeside', name: 'Lakeside Academy', shortName: 'LA', city: 'Buffalo', notes: '' },
    { id: 'org-archived', name: 'Old School', shortName: 'OS', notes: '', archived: true },
  ];
  const addTeam = vi.fn(() => true);
  const controller = { addTeam } as unknown as DirectorController;

  render(<TeamsView state={state} controller={controller} onAnnounce={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add first team' }));
  const dialog = screen.getByRole('dialog');
  const organization = within(dialog).getByRole('combobox', { name: 'School / club' });
  fireEvent.focus(organization);
  expect(within(dialog).getByRole('option', { name: /Northview High School/ })).toBeInTheDocument();
  expect(within(dialog).getByRole('option', { name: /Lakeside Academy/ })).toBeInTheDocument();
  expect(within(dialog).queryByRole('option', { name: /Old School/ })).not.toBeInTheDocument();
  fireEvent.pointerDown(within(dialog).getByRole('option', { name: /Create a new school \/ club/ }));
  expect(screen.getByRole('dialog', { name: 'Schools & clubs' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));

  fireEvent.change(organization, { target: { value: 'rochester' } });
  expect(within(dialog).getByRole('option', { name: /Northview High School/ })).toBeInTheDocument();
  expect(within(dialog).queryByRole('option', { name: /Lakeside Academy/ })).not.toBeInTheDocument();
  fireEvent.change(organization, { target: { value: '' } });
  fireEvent.pointerDown(within(dialog).getByRole('option', { name: /Northview High School/ }));
  fireEvent.change(within(dialog).getByRole('textbox', { name: /Team letter/ }), { target: { value: 'A' } });
  expect(within(dialog).getByDisplayValue('NV A')).toBeInTheDocument();
  fireEvent.change(within(dialog).getByLabelText('Display name'), { target: { value: 'Custom A' } });
  fireEvent.change(within(dialog).getByRole('textbox', { name: /Team letter/ }), { target: { value: 'B' } });
  expect(within(dialog).getByDisplayValue('Custom A')).toBeInTheDocument();
  fireEvent.change(within(dialog).getByLabelText('Display name'), { target: { value: 'Team A' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add team' }));
  expect(addTeam).toHaveBeenCalledWith(
    expect.objectContaining({ organizationId: 'org-northview', teamLetter: 'B' }),
  );
  const submitted = (addTeam.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
  expect(submitted).not.toHaveProperty('organizationName');
});

test('editing a team keeps its archived organization visible as a marked association', () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const state = directorFixture();
  const team = state.teams[0]!;
  team.organizationId = 'org-archived';
  state.organizations = [
    { id: 'org-archived', name: 'Old School', shortName: 'OS', notes: '', archived: true },
  ];

  render(<TeamsView state={state} controller={{} as DirectorController} onAnnounce={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: team.displayName }));
  const dialog = screen.getByRole('dialog');
  const organization = within(dialog).getByRole('combobox', { name: 'School / club' });
  expect(organization).toHaveAttribute('placeholder', 'OS — Old School');
  fireEvent.focus(organization);
  expect(within(dialog).getByRole('option', { name: /Old School.*Archived association/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
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

test('roster year and tri-state UG/D2 persist and round-trip through the team editor (#755)', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const state = directorFixture();
  const teamId = state.teams[0].id;
  state.rounds = [];
  state.scheduledGames = [];
  state.players = [
    {
      id: 'veteran',
      teamId,
      name: 'Veteran',
      captain: false,
      active: true,
      schoolYear: 10,
      undergraduateEligible: true,
      divisionTwoEligible: false,
    },
  ];
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

  // Stored values round-trip into the controls: year present, UG Yes, D2 No.
  expect(within(dialog).getByDisplayValue('10')).toBeTruthy();
  const ug = within(dialog).getByRole('group', { name: 'Player 1 undergraduate eligibility' });
  expect(within(ug).getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'true');
  const d2 = within(dialog).getByRole('group', { name: 'Player 1 division two eligibility' });
  expect(within(d2).getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'true');

  // Edit the veteran and add a rookie with explicit metadata.
  fireEvent.change(within(dialog).getByLabelText('Player 1 school year'), { target: { value: '11' } });
  fireEvent.click(within(ug).getByRole('button', { name: 'No' }));
  fireEvent.click(within(d2).getByRole('button', { name: 'Unknown' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add player' }));
  fireEvent.change(within(dialog).getByLabelText('Player 2 name'), { target: { value: 'Rookie' } });
  fireEvent.change(within(dialog).getByLabelText('Player 2 school year'), { target: { value: '9' } });
  const rookieUg = within(dialog).getByRole('group', { name: 'Player 2 undergraduate eligibility' });
  fireEvent.click(within(rookieUg).getByRole('button', { name: 'Yes' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(controller!.saving).toBe(false));

  const veteran = controller!.state.players.find((player) => player.id === 'veteran');
  expect(veteran?.schoolYear).toBe(11);
  expect(veteran?.undergraduateEligible).toBe(false);
  expect(veteran?.divisionTwoEligible).toBeNull();
  const rookie = controller!.state.players.find((player) => player.name === 'Rookie');
  expect(rookie?.schoolYear).toBe(9);
  expect(rookie?.undergraduateEligible).toBe(true);
  expect(rookie?.divisionTwoEligible).toBeNull();

  // Reopening shows the persisted values, not defaults.
  fireEvent.click(screen.getByRole('button', { name: 'Find team' }));
  const reopened = screen.getByRole('dialog');
  expect(within(reopened).getByDisplayValue('11')).toBeTruthy();
  expect(within(reopened).getByDisplayValue('9')).toBeTruthy();
  const reopenedUg = within(reopened).getByRole('group', { name: 'Player 1 undergraduate eligibility' });
  expect(within(reopenedUg).getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'true');
});
