/**
 * Delivery & Results page integration for #702.
 *
 * One mixed round renders as room-by-room operational state — never as
 * transport tabs or a round-wide mode. Per-room actions target exactly
 * their game, matched returns are titled by matchup rather than filename,
 * and the review pipeline still ends in Results.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { DirectorState, IncomingArtifact } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { TransfersView } from './TransfersView';
import type { TransfersRuntime } from './useTransfers';
import { scheduledGame, team, tournamentState } from '../../../tests/directorFixtures';

const AT = '2026-09-12T12:00:00.000Z';

function room(id: string, name: string): DirectorState['rooms'][number] {
  return { id, name, available: true, status: 'live' } as DirectorState['rooms'][number];
}

function mixedState(): DirectorState {
  const state = tournamentState();
  state.rounds[0]!.deliveryMode = 'qbtcp';
  state.teams.push(
    team('team-a', 'Aiken'),
    team('team-b', 'Dorman'),
    team('team-c', 'Eastside'),
    team('team-d', 'Mauldin'),
  );
  state.rooms.push(
    room('room-101', 'Room 101'),
    room('room-102', 'Room 102'),
    room('room-103', 'Room 103'),
    room('room-104', 'Room 104'),
  );
  state.scheduledGames.push(
    scheduledGame('game-101', 'team-a', 'team-b', {
      roundId: 'round-1',
      roomId: 'room-101',
      status: 'released',
    }),
    scheduledGame('game-102', 'team-c', 'team-d', {
      roundId: 'round-1',
      roomId: 'room-102',
      status: 'released',
    }),
    scheduledGame('game-103', 'team-a', 'team-c', {
      roundId: 'round-1',
      roomId: 'room-103',
      status: 'released',
      deliveryIntent: { primary: 'file', fallbacks: [] },
    }),
    scheduledGame('game-104', 'team-b', 'team-d', {
      roundId: 'round-1',
      roomId: 'room-104',
      status: 'released',
      deliveryIntent: { primary: 'manual', fallbacks: [] },
    }),
  );
  state.qbtcpSessions.push({
    roomId: 'room-101',
    sessionId: 'session-101',
    deviceId: 'device-101',
    state: 'live',
    lastSeenAt: AT,
    progress: null,
    helpRequestId: null,
  });
  state.transfers.locations.push({
    id: 'loc-usb',
    kind: 'removable-drive',
    label: 'SanDisk Ultra',
    path: '/mnt/usb',
    connected: true,
    readOnly: false,
    watching: false,
    initialized: true,
    addedAt: AT,
  });
  const artifact: IncomingArtifact = {
    id: 'artifact-1',
    sourceKind: 'qbtcp',
    sourceLabel: 'Room 102 (QBTCP)',
    fileName: 'result-abc123.qbj',
    byteLength: 1024,
    digest: 'digest-1',
    detectedAt: AT,
    classification: 'ready',
    warnings: [],
    status: 'staged',
    scheduledGameId: 'game-102',
  };
  state.transfers.artifacts.push(artifact);
  return state;
}

function stubRuntime(overrides: Partial<TransfersRuntime> = {}): TransfersRuntime {
  return {
    native: true,
    notice: null,
    dismissNotice: vi.fn(),
    busy: false,
    isOperationActive: () => false,
    status: '',
    addFolder: vi.fn(async () => undefined),
    removeLocation: vi.fn(),
    setWatching: vi.fn(),
    scanLocation: vi.fn(async () => null),
    prepareTo: vi.fn(async () => null),
    initializeLocation: vi.fn(async () => undefined),
    importFiles: vi.fn(async () => ({
      imported: 0,
      duplicates: 0,
      needsReview: 0,
      assignments: 0,
      invalid: 0,
      skipped: 0,
      classifications: [],
      messages: [],
    })),
    importDataTransfer: vi.fn(async () => null),
    downloadAssignments: vi.fn(() => 0),
    cloudAdviceFor: () => undefined,
    ...overrides,
  };
}

function stubController(overrides: Partial<DirectorController> = {}): DirectorController {
  return {
    dismissTransferArtifact: vi.fn(),
    setGameDeliveryIntent: vi.fn(() => true),
    ...overrides,
  } as unknown as DirectorController;
}

function renderPage(state: DirectorState, transfers: TransfersRuntime, controller: DirectorController) {
  const onNavigate = vi.fn();
  const onAnnounce = vi.fn();
  render(
    <TransfersView
      transfers={transfers}
      state={state}
      controller={controller}
      onNavigate={onNavigate}
      onAnnounce={onAnnounce}
    />,
  );
  return { onNavigate, onAnnounce };
}

describe('Delivery & Results page (#702)', () => {
  test('one mixed round renders per-room state, never transport tabs', () => {
    const transfers = stubRuntime();
    renderPage(mixedState(), transfers, stubController());

    expect(screen.getByText('Delivery & Results')).toBeTruthy();
    expect(screen.queryByText('Incoming')).toBeNull();
    expect(screen.queryByText('Outgoing')).toBeNull();
    expect(screen.getByText('Room 101 · Aiken vs Dorman')).toBeTruthy();
    expect(screen.getByText('Room 102 · Eastside vs Mauldin')).toBeTruthy();
    expect(screen.getByText('Room 103 · Aiken vs Eastside')).toBeTruthy();
    expect(screen.getByText('Room 104 · Dorman vs Mauldin')).toBeTruthy();
    expect(screen.getAllByText('QBTCP connected').length).toBeGreaterThan(0);
    expect(screen.getByText('File needed')).toBeTruthy();
    expect(screen.getByText('Manual delivery')).toBeTruthy();
  });

  test('a matched return is titled by matchup with transport as detail', () => {
    renderPage(mixedState(), stubRuntime(), stubController());

    const returns = screen.getByRole('list', { name: 'Returned results needing attention' });
    expect(within(returns).getByText(/Eastside vs Mauldin/)).toBeTruthy();
    // The QBJ filename survives only inside file details, never as the title.
    expect(screen.queryByRole('heading', { name: 'result-abc123.qbj' })).toBeNull();
    expect(within(returns).queryByText('result-abc123.qbj')).toBeNull();
    fireEvent.click(within(returns).getByRole('button', { name: 'File details' }));
    expect(within(returns).getByText('result-abc123.qbj')).toBeTruthy();
    expect(within(returns).getByText(/via QBTCP/)).toBeTruthy();
  });

  test('reviewing a return navigates to Results, never accepting here', () => {
    const onNavigate = renderPage(mixedState(), stubRuntime(), stubController()).onNavigate;
    fireEvent.click(screen.getByRole('button', { name: 'Review results' }));
    expect(onNavigate).toHaveBeenCalledWith('results');
  });

  test('preparing one room targets exactly that game', async () => {
    const transfers = stubRuntime();
    renderPage(mixedState(), transfers, stubController());

    fireEvent.click(screen.getByRole('button', { name: 'Prepare assignment' }));
    expect(transfers.prepareTo).toHaveBeenCalledTimes(1);
    expect(transfers.prepareTo).toHaveBeenCalledWith('loc-usb', {
      kind: 'games',
      scheduledGameIds: ['game-103'],
    });
  });

  test('the device card copies exactly the rooms needing files', async () => {
    const transfers = stubRuntime();
    renderPage(mixedState(), transfers, stubController());

    fireEvent.click(screen.getByRole('button', { name: 'Copy rooms needing files (1)' }));
    expect(transfers.prepareTo).toHaveBeenCalledTimes(1);
    expect(transfers.prepareTo).toHaveBeenCalledWith('loc-usb', {
      kind: 'needing-files',
      roundId: 'round-1',
    });
  });

  test('the device card checks for returned results through the same pipeline', () => {
    const transfers = stubRuntime();
    renderPage(mixedState(), transfers, stubController());

    fireEvent.click(screen.getByRole('button', { name: 'Check for returned results' }));
    expect(transfers.scanLocation).toHaveBeenCalledWith('loc-usb');
  });

  test('routing one room calls the per-game intent mutation', () => {
    const controller = stubController();
    renderPage(mixedState(), stubRuntime(), controller);

    const routes = screen.getAllByRole('button', { name: 'Route' });
    expect(routes.length).toBeGreaterThan(0);
    fireEvent.click(routes[0]!);
    fireEvent.click(screen.getByRole('option', { name: 'Deliver via file' }));
    // Gaps sort first, so the first row is the disconnected Room 102 game.
    expect(controller.setGameDeliveryIntent).toHaveBeenCalledWith('game-102', {
      primary: 'file',
      fallbacks: [],
    });
  });

  test('selecting rows scopes the copy-selected action', () => {
    const transfers = stubRuntime();
    const { container } = render(
      <TransfersView
        transfers={transfers}
        state={mixedState()}
        controller={stubController()}
        onNavigate={vi.fn()}
        onAnnounce={vi.fn()}
      />,
    );
    const checkbox = within(container as HTMLElement).getByRole('checkbox', {
      name: 'Select Room 101, Aiken vs Dorman for file preparation',
    });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Copy selected (1)' }));
    expect(transfers.prepareTo).toHaveBeenCalledWith('loc-usb', {
      kind: 'games',
      scheduledGameIds: ['game-101'],
    });
  });
});

describe('Delivery selection freshness (#756)', () => {
  function roundTwoState(): DirectorState {
    const state = mixedState();
    state.rounds.push({ ...state.rounds[0]!, id: 'round-2', name: 'Round 2', number: 2 });
    state.rooms.push(room('room-201', 'Room 201'));
    state.scheduledGames.push(
      scheduledGame('game-201', 'team-a', 'team-b', {
        roundId: 'round-2',
        roomId: 'room-201',
        status: 'released',
      }),
    );
    state.tournament!.currentRoundId = 'round-2';
    return state;
  }

  function renderMounted(state: DirectorState, transfers: TransfersRuntime) {
    const controller = stubController();
    const rendered = render(
      <TransfersView
        transfers={transfers}
        state={state}
        controller={controller}
        onNavigate={vi.fn()}
        onAnnounce={vi.fn()}
      />,
    );
    const remount = (next: DirectorState) => {
      rendered.rerender(
        <TransfersView
          transfers={transfers}
          state={next}
          controller={controller}
          onNavigate={vi.fn()}
          onAnnounce={vi.fn()}
        />,
      );
    };
    return { ...rendered, remount };
  }

  test('advancing the current round clears the stale selection', () => {
    const transfers = stubRuntime();
    const mounted = renderMounted(mixedState(), transfers);
    fireEvent.click(
      within(mounted.container as HTMLElement).getByRole('checkbox', {
        name: 'Select Room 101, Aiken vs Dorman for file preparation',
      }),
    );
    expect(screen.getByRole('button', { name: 'Copy selected (1)' })).toBeTruthy();

    mounted.remount(roundTwoState());

    // The Round 1 rows are gone and nothing may still claim their selection.
    expect(screen.queryByRole('button', { name: 'Copy selected (1)' })).toBeNull();
    const copySelected = screen.getByRole('button', { name: 'Copy selected' });
    expect((copySelected as HTMLButtonElement).disabled).toBe(true);
    expect(transfers.prepareTo).not.toHaveBeenCalled();
    expect(screen.getByText('Room 201 · Aiken vs Dorman')).toBeTruthy();
  });

  test('removing a selected game within the round excludes its stale ID', () => {
    const transfers = stubRuntime();
    const first = mixedState();
    const mounted = renderMounted(first, transfers);
    fireEvent.click(
      within(mounted.container as HTMLElement).getByRole('checkbox', {
        name: 'Select Room 101, Aiken vs Dorman for file preparation',
      }),
    );
    expect(screen.getByRole('button', { name: 'Copy selected (1)' })).toBeTruthy();

    const next = mixedState();
    next.scheduledGames = next.scheduledGames.filter((game) => game.id !== 'game-101');
    mounted.remount(next);

    expect(
      within(mounted.container as HTMLElement).queryByRole('checkbox', {
        name: 'Select Room 101, Aiken vs Dorman for file preparation',
      }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy selected (1)' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Copy selected' }) as HTMLButtonElement).disabled).toBe(true);
    expect(transfers.prepareTo).not.toHaveBeenCalled();
  });
});
