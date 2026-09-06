import { useCallback } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { directorFixture } from '../transfers/testFixtures';
import { MemoryDirectorRepository } from '../persistence';
import { useDirectorController, type DirectorController } from '../state/useDirectorController';
import { RoundsView } from './RoundsView';

const onAnnounce = vi.fn();
const onNavigate = vi.fn();

function addRecoveryRoom(state: ReturnType<typeof directorFixture>) {
  if (state.rooms.some((room) => room.id === 'room-107')) return;
  state.rooms.push({
    id: 'room-107',
    name: 'Room 107',
    status: 'available',
    moderatorId: null,
    scorekeeperId: null,
    equipmentId: null,
    available: true,
  });
}

async function openRounds(state = directorFixture()) {
  addRecoveryRoom(state);
  const repository = new MemoryDirectorRepository();
  await repository.save(state);
  let controller!: DirectorController;
  function Harness() {
    controller = useDirectorController(repository);
    const announce = useCallback(onAnnounce, []);
    return controller.loading ? null : (
      <RoundsView
        state={controller.state}
        controller={controller}
        onAnnounce={announce}
        onNavigate={onNavigate}
      />
    );
  }
  render(<Harness />);
  await screen.findByText('Round 5');
  return { getController: () => controller, repository };
}

describe('released-game room recovery UI', () => {
  afterEach(() => {
    onAnnounce.mockClear();
    onNavigate.mockClear();
  });

  test('offers only valid destination rooms and reports a successful move', async () => {
    const { getController } = await openRounds(directorFixture({ games: 2 }));

    fireEvent.click(screen.getByRole('button', { name: 'Move game' }));
    expect(screen.getByLabelText('Destination room')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Room 102' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Room 107' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Destination room'), { target: { value: 'room-107' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change room' }));
    await waitFor(() =>
      expect(onAnnounce).toHaveBeenCalledWith(
        'Moved Round 5 · Ninety Six A vs Greenwood A from Room 101 to Room 107.',
      ),
    );
    await waitFor(() => {
      expect(getController().state.scheduledGames.find((game) => game.id === 'game-5-1')?.roomId).toBe(
        'room-107',
      );
      expect(getController().state.scheduledGames.find((game) => game.id === 'game-5-2')?.roomId).toBe(
        'room-102',
      );
    });
  });

  test('explains why a paired scorer cannot be moved', async () => {
    const state = directorFixture({ games: 1 });
    addRecoveryRoom(state);
    state.qbtcpSessions.push({
      roomId: 'room-101',
      sessionId: 'paired-session',
      matchId: 'game-5-1',
      deviceId: 'device-1',
      state: 'paired',
      resumable: false,
      resultReceived: false,
      lastSeenAt: new Date().toISOString(),
      progress: null,
      helpRequestId: null,
    });
    await openRounds(state);

    fireEvent.click(screen.getByRole('button', { name: 'Move game' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/scorer is already paired/i);
    expect(screen.getByRole('button', { name: 'Change room' })).toBeDisabled();
  });
});
