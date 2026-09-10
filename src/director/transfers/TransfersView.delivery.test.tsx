/**
 * Delivery is the room-first work queue for #757.
 *
 * Results and transfer ingestion are intentionally absent from this surface:
 * Delivery owns current-round readiness, while Results owns returned files and
 * their decisions.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { DirectorState, IncomingArtifact } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { TransfersView } from './TransfersView';
import type { TransfersRuntime } from './useTransfers';
import { acceptedGame, scheduledGame, team, tournamentState } from '../../../tests/directorFixtures';

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
  return state;
}

function stateWithReviewResult(): DirectorState {
  const state = mixedState();
  state.games.push(acceptedGame('record-101', 'game-101', []));
  state.games[state.games.length - 1]!.status = 'submitted';
  state.games[state.games.length - 1]!.source = 'qbtcp';
  state.submissions.push({
    id: 'submission-101',
    gameId: 'record-101',
    receivedAt: AT,
    fingerprint: 'fingerprint-101',
    status: 'review',
    rawSubmission: {},
    sessionId: 'session-101',
  });
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

function renderPage(
  state: DirectorState,
  transfers: TransfersRuntime,
  controller: DirectorController,
  onNavigate: (section: string, target?: unknown) => void = vi.fn(),
) {
  render(
    <TransfersView
      transfers={transfers}
      state={state}
      controller={controller}
      onNavigate={onNavigate}
      onAnnounce={vi.fn()}
    />,
  );
}

function deliveryTable(): HTMLElement {
  return screen.getByRole('table', { name: 'Round 1 delivery by room' });
}

describe('Delivery page (#757)', () => {
  test('renders one stable room table with no returned-results queue or permanent checkboxes', () => {
    renderPage(mixedState(), stubRuntime(), stubController());

    expect(screen.getByRole('heading', { name: 'Delivery' })).toBeTruthy();
    expect(screen.queryByText('Delivery & Results')).toBeNull();
    expect(screen.queryByText('Returned results')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();

    const rows = within(deliveryTable()).getAllByRole('row');
    expect(rows.slice(1).map((row) => row.getAttribute('data-director-navigation-id'))).toEqual([
      'game-101',
      'game-102',
      'game-103',
      'game-104',
    ]);
    expect(screen.getByText('QBTCP connected')).toBeTruthy();
    expect(screen.getByText('File needed')).toBeTruthy();
    expect(screen.getByText('Manual delivery')).toBeTruthy();
  });

  test('attention is an explicit filter and preserves the same room order', () => {
    renderPage(mixedState(), stubRuntime(), stubController());

    fireEvent.click(screen.getByRole('button', { name: 'Needs attention (2)' }));
    const rows = within(deliveryTable()).getAllByRole('row');
    expect(rows.slice(1).map((row) => row.getAttribute('data-director-navigation-id'))).toEqual([
      'game-102',
      'game-103',
    ]);
  });

  test('the page primary opens bulk preparation; selection exists only in the dialog', () => {
    renderPage(mixedState(), stubRuntime(), stubController());

    fireEvent.click(screen.getByRole('button', { name: 'Prepare needed files (1)' }));

    expect(screen.getByRole('heading', { name: 'Prepare assignment files' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Room 103, Aiken vs Eastside' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Room 101, Aiken vs Dorman' })).toBeTruthy();
  });

  test('a row prepare action targets exactly that scheduled game', () => {
    const transfers = stubRuntime();
    renderPage(mixedState(), transfers, stubController());

    fireEvent.click(screen.getByRole('button', { name: 'Prepare file for Room 103, Aiken vs Eastside' }));
    expect(transfers.prepareTo).toHaveBeenCalledWith('loc-usb', {
      kind: 'games',
      scheduledGameIds: ['game-103'],
    });
  });

  test('routing uses the row overflow menu without changing the stable list order', () => {
    const controller = stubController();
    renderPage(mixedState(), stubRuntime(), controller);

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Room 101, Aiken vs Dorman' }));
    fireEvent.click(screen.getByRole('option', { name: 'Use file' }));
    expect(controller.setGameDeliveryIntent).toHaveBeenCalledWith('game-101', {
      primary: 'file',
      fallbacks: [],
    });
  });

  test('row details are available behind overflow', () => {
    renderPage(mixedState(), stubRuntime(), stubController());

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Room 101, Aiken vs Dorman' }));
    fireEvent.click(screen.getByRole('option', { name: 'View delivery details' }));
    expect(screen.getByText('Delivery details')).toBeTruthy();
    expect(screen.getByText('No assignment transfer recorded')).toBeTruthy();
  });

  test('review action navigates to the exact returned submission', () => {
    const onNavigate = vi.fn();
    renderPage(stateWithReviewResult(), stubRuntime(), stubController(), onNavigate);

    fireEvent.click(screen.getByRole('button', { name: 'Review result for Room 101, Aiken vs Dorman' }));
    expect(onNavigate).toHaveBeenCalledWith('results', {
      section: 'results',
      entityType: 'submission',
      entityId: 'submission-101',
    });
  });

  test('session recovery navigates to the exact affected room', () => {
    const state = mixedState();
    state.qbtcpHelpRequests.push({
      id: 'help-101',
      roomId: 'room-101',
      roomName: 'Room 101',
      category: 'connection',
      message: 'Scorer needs help',
      status: 'open',
      createdAt: AT,
      updatedAt: AT,
      deviceId: 'device-101',
    });
    const onNavigate = vi.fn();
    renderPage(state, stubRuntime(), stubController(), onNavigate);

    fireEvent.click(screen.getByRole('button', { name: 'Fix session for Room 101, Aiken vs Dorman' }));
    expect(onNavigate).toHaveBeenCalledWith('rooms', {
      section: 'rooms',
      entityType: 'room',
      entityId: 'room-101',
    });
  });

  test('invalid artifacts do not return to Delivery', () => {
    const state = mixedState();
    const artifact: IncomingArtifact = {
      id: 'artifact-invalid',
      sourceKind: 'drop',
      sourceLabel: 'Dropped files',
      fileName: 'broken.qbj',
      byteLength: 12,
      digest: 'digest-invalid',
      detectedAt: AT,
      classification: 'invalid',
      warnings: [],
      status: 'failed',
      detail: 'The file is not valid JSON.',
    };
    state.transfers.artifacts.push(artifact);

    renderPage(state, stubRuntime(), stubController());

    expect(screen.queryByText('broken.qbj')).toBeNull();
    expect(screen.queryByText('Import problems')).toBeNull();
  });
});
