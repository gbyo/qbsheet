/**
 * What the logistics workspace has to get right.
 *
 * Rooms, staff, and equipment used to share one set of add-form fields, so
 * typing into one threw away what was in another; and staff could only be
 * created with a single "Primary role" even though the domain, and the edit
 * form two lines further down the same page, both take several.
 *
 * The redesign made each of the three its own view with its own dialog, which
 * removes the shared-state bug structurally. These tests hold that line: the
 * three forms are independent, staff keep multiple roles, and a room's future
 * assignability is not the same claim as what it is doing right now.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DirectorController } from '../state/useDirectorController';
import { scheduledGame, team, tournamentState } from '../../../tests/directorFixtures';
import { RoomsView } from './RoomsView';
import { ConfirmProvider } from '../components/Dialog';
import type { NativeServerState } from '../server/useNativeServerStatus';

afterEach(() => {
  cleanup();
  delete window.__TAURI_INTERNALS__;
});

function controllerWith(overrides: Partial<DirectorController> = {}): DirectorController {
  return {
    addRoom: vi.fn(() => true),
    addStaff: vi.fn(() => true),
    addEquipment: vi.fn(() => true),
    updateStaff: vi.fn(() => true),
    updateRoom: vi.fn(() => true),
    ...overrides,
  } as unknown as DirectorController;
}

function renderRooms(controller = controllerWith(), state = tournamentState()) {
  render(
    <ConfirmProvider>
      <RoomsView state={state} controller={controller} onAnnounce={vi.fn()} />
    </ConfirmProvider>,
  );
  return controller;
}

/** Rooms, staff, and equipment are peer views of the same workspace. */
function showView(name: RegExp): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

/** The open dialog, so a submit button is not confused with the page action that opened it. */
function currentDialog(): HTMLElement {
  return document.querySelector('dialog[open]') as HTMLElement;
}

/** Staff and equipment both label their name field "Name"; scope to the dialog. */
function staffNameField(): HTMLInputElement {
  return within(currentDialog()).getByLabelText('Name') as HTMLInputElement;
}

function queryStaffNameField(): HTMLElement | null {
  const dialog = document.querySelector('dialog[open]');
  return dialog ? within(dialog as HTMLElement).queryByLabelText('Name') : null;
}

const equipmentNameField = staffNameField;
const queryEquipmentNameField = queryStaffNameField;

function openAddStaff(): void {
  showView(/^Staff/);
  fireEvent.click(screen.getByRole('button', { name: 'Add staff' }));
}

describe('logistics view motion', () => {
  test('tracks forward and backward direction without changing pressed-button semantics', () => {
    renderRooms();
    expect(document.querySelector('.director-logistics-view')).not.toHaveAttribute('data-direction');

    showView(/^Equipment/);
    expect(document.querySelector('.director-logistics-view')).toHaveAttribute('data-direction', 'forward');
    expect(screen.getByRole('button', { name: /^Equipment/ })).toHaveAttribute('aria-pressed', 'true');

    showView(/^Staff/);
    expect(document.querySelector('.director-logistics-view')).toHaveAttribute('data-direction', 'backward');
    expect(screen.getByRole('button', { name: /^Staff/ })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the three add forms are independent', () => {
  test('each entity type has its own form with its own fields', () => {
    renderRooms();

    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Lecture Hall B' } });
    // Nothing from the room form can reach another entity's form, because each
    // is its own dialog over its own draft rather than one shared set of fields.
    expect(queryStaffNameField()).toBeNull();
    expect(queryEquipmentNameField()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    openAddStaff();
    expect(screen.queryByLabelText('Room name')).toBeNull();
    expect((staffNameField() as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    showView(/^Equipment/);
    fireEvent.click(screen.getByRole('button', { name: 'Add equipment' }));
    expect((equipmentNameField() as HTMLInputElement).value).toBe('');
  });

  test('Cancel discards the draft, as it does in every Director dialog', () => {
    renderRooms();

    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Room 12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));

    expect((screen.getByLabelText('Room name') as HTMLInputElement).value).toBe('');
  });

  test('a saved room reaches the controller and closes its form', () => {
    const controller = renderRooms();

    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Room 12' } });
    fireEvent.click(within(currentDialog()).getByRole('button', { name: 'Add room' }));

    expect(controller.addRoom).toHaveBeenCalledWith(expect.objectContaining({ name: 'Room 12' }));
    expect(screen.queryByLabelText('Room name')).toBeNull();
  });
});

describe('creating a staff member', () => {
  test('somebody who moderates and keeps score can be entered as both at once', () => {
    const controller = renderRooms();

    openAddStaff();
    fireEvent.change(staffNameField(), { target: { value: 'Alex Morgan' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Scorekeeper' }));
    fireEvent.click(within(currentDialog()).getByRole('button', { name: 'Add staff member' }));

    expect(controller.addStaff).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Alex Morgan', roles: ['moderator', 'scorekeeper'] }),
    );
  });

  test('the single-choice Primary role select is gone', () => {
    renderRooms();

    openAddStaff();

    expect(screen.queryByLabelText('Primary role')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Moderator' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'HQ staff' })).toBeTruthy();
  });

  test('an empty role set is refused rather than saved', () => {
    const controller = renderRooms();

    openAddStaff();
    fireEvent.change(staffNameField(), { target: { value: 'Alex Morgan' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Moderator' }));
    fireEvent.click(within(currentDialog()).getByRole('button', { name: 'Add staff member' }));

    expect(controller.addStaff).not.toHaveBeenCalled();
    // And the typed name is still there to save once a role is chosen.
    expect((staffNameField() as HTMLInputElement).value).toBe('Alex Morgan');
  });
});

describe('room operations visibility', () => {
  test('Available means ready for assignment, not merely marked available', () => {
    const state = tournamentState();
    state.teams.push(team('team-a', 'Alpha'), team('team-b', 'Beta'));
    state.rooms.push(
      {
        id: 'room-ready',
        name: 'Ready room',
        status: 'available',
        moderatorId: null,
        scorekeeperId: null,
        equipmentId: null,
        available: true,
      },
      {
        id: 'room-live',
        name: 'Live room',
        // The persisted status deliberately disagrees with reality here. Occupancy is derived
        // from the game and the scorer session, so a stale `status` cannot make a free room look
        // busy, and the actual live game below is what makes this room unassignable.
        status: 'available',
        moderatorId: null,
        scorekeeperId: null,
        equipmentId: null,
        available: true,
      },
    );
    state.scheduledGames.push(
      scheduledGame('game-live', 'team-a', 'team-b', { roomId: 'room-live', status: 'live' }),
    );

    renderRooms(controllerWith(), state);

    // "Assignable" says what the filter actually selects. A room marked
    // available but still running a game is not assignable for the next round,
    // which is the distinction the old "Available" label blurred.
    expect(screen.getByRole('button', { name: 'Assignable 1' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Assignable 1' }));

    expect(screen.getByText('Ready room')).toBeInTheDocument();
    expect(screen.queryByText('Live room')).toBeNull();
  });

  test('shows assignment and concise QBTCP state for the room', () => {
    const state = tournamentState();
    state.teams.push(team('team-a', 'Alpha'), team('team-b', 'Beta'));
    state.rooms.push({
      id: 'room-1',
      name: 'Room 1',
      status: 'available',
      moderatorId: null,
      scorekeeperId: null,
      equipmentId: null,
      available: true,
    });
    state.scheduledGames.push(
      scheduledGame('game-1', 'team-a', 'team-b', { roomId: 'room-1', status: 'released' }),
    );
    state.qbtcpSessions.push({
      roomId: 'room-1',
      sessionId: 'session-1',
      matchId: 'game-1',
      deviceId: 'device-1',
      operatorName: 'Morgan',
      state: 'live',
      resumable: true,
      resultReceived: false,
      lastSeenAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
      progress: null,
      helpRequestId: 'help-1',
    });
    state.qbtcpHelpRequests.push({
      id: 'help-1',
      roomId: 'room-1',
      roomName: 'Room 1',
      category: 'connection',
      message: 'Need help',
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deviceId: 'device-1',
      operatorName: 'Morgan',
    });

    renderRooms(controllerWith(), state);

    // What a director scanning the list needs: the room, what it is doing now,
    // whether it can take the next round, and that it has asked for help.
    expect(screen.getByText(/Alpha vs Beta/)).toBeInTheDocument();
    // Readiness is derived, and an open help request outranks everything else the room is doing.
    expect(screen.getByText('Needs help')).toBeInTheDocument();
    expect(screen.getByText(/Morgan · Connected/)).toBeInTheDocument();

    // The connection telemetry is still there, one disclosure away, rather than
    // permanently occupying the row.
    expect(screen.queryByText(/Last seen/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Room details & QBTCP/ }));
    expect(screen.getByText(/Last seen/)).toBeInTheDocument();
    expect(screen.getByText(/Resumable/)).toBeInTheDocument();
    expect(screen.getAllByText(/Morgan/).length).toBeGreaterThan(0);
  });
});

describe('QBTCP credential control', () => {
  test('requires explicit confirmation before resetting every pairing', async () => {
    const invoke = vi.fn(async (command: string) => {
      expect(command).toBe('director_reset_qbtcp_credentials');
      return {
        running: true,
        message: 'QBTCP pairings were reset.',
        pairingInvitations: [],
      };
    });
    window.__TAURI_INTERNALS__ = { invoke };
    const apply = vi.fn();
    const server = {
      status: { running: true, address: '192.168.1.10', port: 8787, pairingInvitations: [] },
      loading: false,
      refresh: vi.fn(),
      toggle: vi.fn(),
      addInvitation: vi.fn(),
      setAdvertisedAddress: vi.fn(),
      apply,
    } as unknown as NativeServerState;

    render(
      <ConfirmProvider>
        <RoomsView
          state={tournamentState()}
          controller={controllerWith()}
          onAnnounce={vi.fn()}
          server={server}
        />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset all pairings' }));
    expect(invoke).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/Every paired scorer and open session/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset all pairings' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ running: true }));
  });
});
