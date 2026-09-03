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
import { tournamentState } from '../../../tests/directorFixtures';
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
