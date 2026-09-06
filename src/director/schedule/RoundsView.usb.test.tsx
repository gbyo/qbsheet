import { useCallback, useLayoutEffect } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { directorFixture, scoreAssignment } from '../transfers/testFixtures';
import { MemoryTransferFileSystem } from '../transfers/ports';
import { createTransferPlatform } from '../platform/transfers';
import { MemoryDirectorRepository } from '../persistence';
import { useDirectorController, type DirectorController } from '../state/useDirectorController';
import { useTransfers, type TransfersRuntime } from '../transfers/useTransfers';
import { RoundsView } from './RoundsView';
import { defineGame, readQbjText, scoreableWithoutChoice } from '../../qbj/ParseQbjAssignment';

vi.mock('../platform/transfers', async (original) => ({
  ...(await original<typeof import('../platform/transfers')>()),
  createTransferPlatform: vi.fn(),
  authorizeTransferRoot: vi.fn(async () => ({ ok: true })),
}));
let fileSystem: MemoryTransferFileSystem;
let controller: DirectorController;
let runtime: TransfersRuntime;
const onAnnounce = vi.fn();
const onNavigate = vi.fn();

beforeEach(() => {
  fileSystem = new MemoryTransferFileSystem();
  vi.mocked(createTransferPlatform).mockReturnValue({ fileSystem, volumes: fileSystem, native: true });
  onAnnounce.mockClear();
  onNavigate.mockClear();
});
afterEach(() => vi.restoreAllMocks());

/**
 * Mount the Rounds page over a fixture whose current round is not the one the quick action offers.
 *
 * `onCommit` runs from a layout effect, which is to say from inside each commit and before React
 * flushes that commit's passive effects. A test that needs to know what a click arriving straight
 * after a render would see has to ask from there.
 */
async function open(onCommit?: () => void) {
  const state = directorFixture(); // Round 5 is current and highest; quick action requests Round 4.
  const fourth = {
    ...state.rounds[0],
    id: 'round-4',
    number: 4,
    name: 'Round 4',
    status: 'planned' as const,
    scheduledGameIds: [] as string[],
    dayOrder: 0,
  };
  const games = state.scheduledGames
    .filter((game) => game.roundId === state.rounds[0].id)
    .map((game) => ({
      ...game,
      id: `${game.id}-fourth`,
      roundId: fourth.id,
      status: 'scheduled' as const,
    }));
  fourth.scheduledGameIds = games.map((game) => game.id);
  state.rounds[0].dayOrder = 1;
  state.rounds.unshift(fourth);
  state.scheduledGames.push(...games);
  state.phases[0].roundIds.unshift(fourth.id);
  const repository = new MemoryDirectorRepository();
  await repository.save(state);
  function Harness() {
    controller = useDirectorController(repository);
    const announce = useCallback(onAnnounce, []);
    runtime = useTransfers(controller.state, controller, announce, !controller.loading);
    useLayoutEffect(() => onCommit?.());
    return controller.loading ? null : (
      <RoundsView
        state={controller.state}
        controller={controller}
        transfers={runtime}
        onAnnounce={announce}
        onNavigate={onNavigate}
      />
    );
  }
  render(<Harness />);
  await screen.findByText('Round 4');
  return { state, repository };
}

test('requested round writes through the real runtime even when another round is current, then returned files await review', async () => {
  fileSystem.addVolume('/usb', { name: 'KINGSTON' });
  const { repository } = await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Put Round 4 on USB' }));
  await waitFor(() =>
    expect(onAnnounce).toHaveBeenCalledWith('Round 4 copied to KINGSTON — eject normally.'),
  );
  const assignments = fileSystem.allPaths().filter((path) => path.endsWith('.qbj'));
  expect(assignments).toHaveLength(2);
  const documents = assignments.map((path) => JSON.parse(fileSystem.readSync(path)!));
  for (const document of documents) {
    expect(document.objects.find((entry: { type: string }) => entry.type === 'Round').id).toBe('round-4');
    const source = readQbjText(JSON.stringify(document));
    expect(source.ok).toBe(true);
    if (!source.ok) throw new Error('Assignment could not be read');
    const candidate = scoreableWithoutChoice(source.value);
    expect(candidate?.state).toBe('unplayed');
    expect(defineGame(source.value, candidate!.index).ok).toBe(true);
  }
  expect(
    controller.state.transfers.assignments.every(
      (entry) =>
        controller.state.scheduledGames.find((game) => game.id === entry.scheduledGameId)?.roundId ===
        'round-4',
    ),
  ).toBe(true);
  const result = scoreAssignment(documents[0]);
  fileSystem.putFile('/usb/QBSheet/Results/returned.qbj', JSON.stringify(result));
  // Return the drive while only Rounds is mounted; the shared runtime discovers it.
  act(() => controller.syncTransferVolumes([]));
  await act(async () => controller.syncTransferVolumes(await fileSystem.listVolumes()));
  await waitFor(() => expect(controller.state.submissions).toHaveLength(1));
  expect(controller.state.submissions[0].status).not.toBe('accepted');
  fireEvent.click(screen.getByRole('button', { name: '1 result returned · Review' }));
  expect(onNavigate).toHaveBeenCalledWith('results', {
    section: 'results',
    entityType: 'round',
    entityId: 'round-4',
  });
  await act(async () => {
    await runtime.scanLocation(controller.state.transfers.locations[0].id);
  });
  expect(controller.state.submissions).toHaveLength(1);
  await waitFor(() => expect(controller.saving).toBe(false));
  expect((await repository.load()).submissions).toHaveLength(1);
});

test('a drive can be written from the commit that puts its button on screen', async () => {
  // What broke in CI, and what a director would have hit eventually.
  //
  // The runtime keeps a mirror of the tournament for its timers and callbacks to read. That mirror
  // used to be written by a passive effect, which React flushes in a scheduler task *after* the
  // commit that painted the DOM — and it yields between the two whenever the commit runs past its
  // frame budget, which is exactly what a machine under load does. In that gap the drive's button
  // is on screen and clickable while the runtime still cannot see the drive, so `prepareTo` finds
  // no such location and returns having written nothing, said nothing and logged nothing.
  //
  // `onCommit` below is a layout effect, so it runs inside the commit itself: the earliest instant
  // anything can reach the DOM that commit produced, and therefore earlier than any click on the
  // button it just added. Asking the runtime to write the drive from there states the requirement
  // without depending on how loaded the machine is — the scheduler timing that decides whether a
  // real click lands in the gap never enters into it.
  let requested = false;
  await open(() => {
    const location = controller.state.transfers.locations[0];
    if (!location || requested) return;
    requested = true;
    void runtime.prepareTo(location.id, { kind: 'round', roundId: 'round-4' });
  });
  fileSystem.addVolume('/usb', { name: 'KINGSTON' });
  await act(async () => controller.syncTransferVolumes(await fileSystem.listVolumes()));
  expect(requested).toBe(true);
  await waitFor(() =>
    expect(onAnnounce).toHaveBeenCalledWith('Round 4 copied to KINGSTON — eject normally.'),
  );
  expect(fileSystem.allPaths().filter((path) => path.endsWith('.qbj'))).toHaveLength(2);
});

test('no USB gives no disabled controls; multiple writable drives use a contextual chooser', async () => {
  await open();
  expect(screen.queryByRole('button', { name: /Put Round .* on USB/ })).toBeNull();
  fileSystem.addVolume('/one', { name: 'KINGSTON' });
  fileSystem.addVolume('/two', { name: 'SANDISK' });
  fileSystem.addVolume('/locked', { name: 'READ ONLY', readOnly: true });
  await act(async () => {
    controller.syncTransferVolumes(await fileSystem.listVolumes());
  });
  fireEvent.click(screen.getByRole('button', { name: 'Put Round 4 on USB' }));
  const menu = screen.getByRole('menu', { name: 'USB for Round 4' });
  expect(within(menu).queryByRole('menuitem', { name: 'READ ONLY' })).toBeNull();
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'SANDISK' }));
  await waitFor(() => expect(onAnnounce).toHaveBeenCalledWith('Round 4 copied to SANDISK — eject normally.'));
  expect(
    fileSystem
      .allPaths()
      .filter((path) => path.endsWith('.qbj'))
      .every((path) => path.startsWith('/two/')),
  ).toBe(true);
});

test('a disconnected or read-only drive cannot be prepared through the shared operation', async () => {
  fileSystem.addVolume('/usb', { name: 'LOCKED', readOnly: true });
  await open();
  await waitFor(() => expect(controller.state.transfers.locations).toHaveLength(1));
  expect(screen.queryByRole('button', { name: /Put Round .* on USB/ })).toBeNull();
  await act(async () => {
    expect(
      await runtime.prepareTo(controller.state.transfers.locations[0].id, {
        kind: 'round',
        roundId: 'round-4',
      }),
    ).toBeNull();
  });
  expect(fileSystem.allPaths()).toEqual([]);
  await act(async () => {
    controller.syncTransferVolumes([]);
  });
  await act(async () => {
    expect(
      await runtime.prepareTo(controller.state.transfers.locations[0].id, {
        kind: 'round',
        roundId: 'round-4',
      }),
    ).toBeNull();
  });
  expect(onAnnounce).toHaveBeenLastCalledWith(
    expect.objectContaining({ message: expect.stringContaining('no longer connected') }),
  );
});
