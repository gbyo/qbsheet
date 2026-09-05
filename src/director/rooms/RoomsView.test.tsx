/**
 * The three add-forms, and what they remember.
 *
 * Add room / Add staff / Add equipment shared one set of fields and cleared them on every open, so
 * checking something on one form threw away whatever was typed into another. And staff could only
 * be created with a single "Primary role" even though the domain, and the edit form two lines
 * further down the same page, both take several.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DirectorController } from '../state/useDirectorController';
import { scheduledGame, team, tournamentState } from '../../../tests/directorFixtures';
import { RoomsView } from './RoomsView';

afterEach(cleanup);

function controllerWith(overrides: Partial<DirectorController> = {}): DirectorController {
  return {
    addRoom: vi.fn(() => true),
    addStaff: vi.fn(() => true),
    addEquipment: vi.fn(() => true),
    updateStaff: vi.fn(() => true),
    ...overrides,
  } as unknown as DirectorController;
}

function renderRooms(controller = controllerWith()) {
  render(<RoomsView state={tournamentState()} controller={controller} onAnnounce={vi.fn()} />);
  return controller;
}

describe('drafts that survive switching forms', () => {
  test('a half-typed room is still there after a detour through Add staff', () => {
    renderRooms();

    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
    fireEvent.change(screen.getByPlaceholderText('Room 101'), { target: { value: 'Lecture Hall B' } });
    fireEvent.change(screen.getByPlaceholderText('Anything the director or runners should know'), {
      target: { value: 'Projector is broken' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add staff' }));
    expect(screen.queryByPlaceholderText('Room 101')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));

    expect((screen.getByPlaceholderText('Room 101') as HTMLInputElement).value).toBe('Lecture Hall B');
    expect(
      (screen.getByPlaceholderText('Anything the director or runners should know') as HTMLTextAreaElement)
        .value,
    ).toBe('Projector is broken');
  });

  test('each form keeps its own name field rather than sharing one', () => {
    renderRooms();

    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
    fireEvent.change(screen.getByPlaceholderText('Room 101'), { target: { value: 'Room 12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add staff' }));
    fireEvent.change(screen.getByPlaceholderText('Alex Morgan'), { target: { value: 'Alex Morgan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add equipment' }));

    expect((screen.getByPlaceholderText('Buzzer set 1') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Add staff' }));
    expect((screen.getByPlaceholderText('Alex Morgan') as HTMLInputElement).value).toBe('Alex Morgan');
    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
    expect((screen.getByPlaceholderText('Room 101') as HTMLInputElement).value).toBe('Room 12');
  });

  test('a closed form reopens with what was in it', () => {
    renderRooms();

    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
    fireEvent.change(screen.getByPlaceholderText('Room 101'), { target: { value: 'Room 12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));

    expect((screen.getByPlaceholderText('Room 101') as HTMLInputElement).value).toBe('Room 12');
  });

  test('a save empties that form and only that form', () => {
    renderRooms();

    fireEvent.click(screen.getByRole('button', { name: 'Add staff' }));
    fireEvent.change(screen.getByPlaceholderText('Alex Morgan'), { target: { value: 'Alex Morgan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
    fireEvent.change(screen.getByPlaceholderText('Room 101'), { target: { value: 'Room 12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save room' }));

    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
    expect((screen.getByPlaceholderText('Room 101') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Add staff' }));
    expect((screen.getByPlaceholderText('Alex Morgan') as HTMLInputElement).value).toBe('Alex Morgan');
  });
});

describe('creating a staff member', () => {
  test('somebody who moderates and keeps score can be entered as both at once', () => {
    const controller = renderRooms();

    fireEvent.click(screen.getByRole('button', { name: 'Add staff' }));
    fireEvent.change(screen.getByPlaceholderText('Alex Morgan'), { target: { value: 'Alex Morgan' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Scorekeeper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save staff member' }));

    expect(controller.addStaff).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Alex Morgan', roles: ['moderator', 'scorekeeper'] }),
    );
  });

  test('the single-choice Primary role select is gone', () => {
    renderRooms();

    fireEvent.click(screen.getByRole('button', { name: 'Add staff' }));

    expect(screen.queryByLabelText('Primary role')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Moderator' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'HQ staff' })).toBeTruthy();
  });

  test('an empty role set is refused rather than saved', () => {
    const controller = renderRooms();

    fireEvent.click(screen.getByRole('button', { name: 'Add staff' }));
    fireEvent.change(screen.getByPlaceholderText('Alex Morgan'), { target: { value: 'Alex Morgan' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Moderator' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save staff member' }));

    expect(controller.addStaff).not.toHaveBeenCalled();
    // And the typed name is still there to save once a role is chosen.
    expect((screen.getByPlaceholderText('Alex Morgan') as HTMLInputElement).value).toBe('Alex Morgan');
  });
});

describe('room operations visibility', () => {
  test('Available means ready for assignment, not merely marked available', () => {
    const state = tournamentState();
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
        status: 'live',
        moderatorId: null,
        scorekeeperId: null,
        equipmentId: null,
        available: true,
      },
    );

    render(<RoomsView state={state} controller={controllerWith()} onAnnounce={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Available 1' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Available 1' }));

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

    render(<RoomsView state={state} controller={controllerWith()} onAnnounce={vi.fn()} />);

    expect(screen.getByText('Live', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText(/Alpha vs Beta/, { selector: 'small' })).toBeInTheDocument();
    expect(screen.getAllByText(/Morgan/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Stale · Last seen/)).toBeInTheDocument();
    expect(screen.getByText(/Resumable/)).toBeInTheDocument();
    expect(screen.getByText(/Help open/)).toBeInTheDocument();
    expect(screen.getByText('Not assignable while current work resolves')).toBeInTheDocument();
  });
});
