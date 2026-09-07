import { useCallback } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { directorFixture } from '../transfers/testFixtures';
import { MemoryDirectorRepository } from '../persistence';
import { useDirectorController, type DirectorController } from '../state/useDirectorController';
import { readNativeLiveScorerRooms } from '../platform/native';
import { RoundsView } from './RoundsView';

vi.mock('../platform/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/native')>()),
  readNativeLiveScorerRooms: vi.fn(async () => []),
}));

const liveScorerRooms = vi.mocked(readNativeLiveScorerRooms);

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
    liveScorerRooms.mockReset();
    liveScorerRooms.mockResolvedValue([]);
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

  // The document only learns about pairings on the once-per-second QBTCP poll, so a scorer who
  // pairs between two polls leaves no trace in the state the blocker above reads. Saving the move
  // anyway reassigns both rooms and the native server clears their session tracking, disconnecting
  // that scorer with no warning. The server is asked directly for exactly this reason.
  test('refuses a move the document permits when the server still sees a scorer in the room', async () => {
    const { getController, repository } = await openRounds(directorFixture({ games: 2 }));
    liveScorerRooms.mockResolvedValue(['room-101']);

    fireEvent.click(screen.getByRole('button', { name: 'Move game' }));
    fireEvent.change(screen.getByLabelText('Destination room'), { target: { value: 'room-107' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change room' }));

    await waitFor(() =>
      expect(onAnnounce).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'A scorer is connected in Room 101; finish or resolve that session before changing rooms.',
        }),
      ),
    );
    expect(liveScorerRooms).toHaveBeenCalledWith(['room-101', 'room-107']);
    expect(getController().state.scheduledGames.find((game) => game.id === 'game-5-1')?.roomId).toBe(
      'room-101',
    );
    const persisted = await repository.load();
    expect(persisted.scheduledGames.find((game) => game.id === 'game-5-1')?.roomId).toBe('room-101');
  });

  test('refuses the move when the live scorer state cannot be read at all', async () => {
    const { getController } = await openRounds(directorFixture({ games: 2 }));
    liveScorerRooms.mockRejectedValue(new Error('the server is unreachable'));

    fireEvent.click(screen.getByRole('button', { name: 'Move game' }));
    fireEvent.change(screen.getByLabelText('Destination room'), { target: { value: 'room-107' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change room' }));

    await waitFor(() =>
      expect(onAnnounce).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('could not be read') }),
      ),
    );
    expect(getController().state.scheduledGames.find((game) => game.id === 'game-5-1')?.roomId).toBe(
      'room-101',
    );
  });
});
