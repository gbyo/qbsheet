import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadedFixture } from '../tests/fixture';
import { emptyState, type BridgeState } from '../model/persistence';
import { newRoom, type Room, type RoomStatus } from '../model/rooms';
import type { BridgeApi } from '../model/useBridge';
import RoomsView from './RoomsView';

const relay = {
  baseUrl: 'https://relay.example.workers.dev',
  tournamentId: 'bcdfghjkmnpqrstvwxyz2345',
  managementToken: 'management-secret',
  epoch: 1,
  revision: 1,
};

function testRoom(
  tournamentRoundId: string,
  id: string,
  name: string,
  code: string,
  published: boolean,
): Room {
  return {
    ...newRoom(id, name, code),
    relayPublished: published,
    publishedMatchId: published ? `match-${id}` : null,
    publishedRoundId: published ? tournamentRoundId : null,
  };
}

function testBridge(rooms: Room[], scorerReady = true): BridgeApi {
  const tournament = loadedFixture();
  const selectedRoundId = tournament.rounds[0]?.id ?? null;
  const state: BridgeState = {
    ...emptyState(),
    relay,
    rooms,
    selectedRoundId,
    roundPlans:
      selectedRoundId === null
        ? []
        : [
            {
              roundId: selectedRoundId,
              pairings: rooms.map((room) => ({
                roomId: room.id,
                leftTeamId: 'Team_Cony',
                rightTeamId: 'Team_Deering',
              })),
            },
          ],
  };
  const noop = vi.fn();
  return {
    state,
    tournament,
    loadWarnings: [],
    notice: null,
    dismissNotice: noop,
    relayReachable: true,
    scorerReadiness: scorerReady
      ? {
          status: 'ready',
          origin: 'https://qbsheet.com',
          message: 'https://qbsheet.com can pair and use this relay.',
        }
      : {
          status: 'blocked',
          origin: 'https://qbsheet.com',
          message: 'Add https://qbsheet.com to RELAY_ALLOWED_ORIGINS in the Cloudflare deployment.',
        },
    busy: false,
    native: true,
    loadFile: vi.fn(async () => undefined),
    loadFileContents: noop,
    pendingFileSwitch: null,
    confirmFileSwitch: noop,
    cancelFileSwitch: noop,
    connectRelay: vi.fn(async () => true),
    importRecoveryPackage: vi.fn(async () => false),
    createRecoveryPackage: vi.fn(async () => false),
    provisionBackup: vi.fn(async () => null),
    rotateBackup: vi.fn(async () => null),
    revokeBackup: vi.fn(async () => false),
    takeOverRelay: vi.fn(async () => false),
    transferRelayToPrimary: vi.fn(async () => false),
    relayCredentialSavePending: false,
    retryRelayCredentialSave: vi.fn(async () => false),
    persistenceSavePending: false,
    retryStatePersistence: vi.fn(() => true),
    checkScorerReadiness: vi.fn(async () => undefined),
    beginRelayChange: noop,
    cancelRelayChange: noop,
    changingRelay: false,
    forgetRelayCredential: noop,
    addRoom: noop,
    renameRoom: noop,
    removeRoom: noop,
    setRoomTeams: noop,
    regeneratePairingCode: noop,
    selectRound: noop,
    plannedTeamsFor: (roomId: string) => {
      const pairing = state.roundPlans[0]?.pairings.find((entry) => entry.roomId === roomId);
      return {
        leftTeamId: pairing?.leftTeamId ?? null,
        rightTeamId: pairing?.rightTeamId ?? null,
      };
    },
    planStatus: () => 'planned' as const,
    roundProgress: { roundId: selectedRoundId, assigned: rooms.length },
    phaseRoundProgress: [],
    publish: vi.fn(async () => undefined),
    pendingPublicationReview: null,
    confirmPublicationReview: vi.fn(async () => undefined),
    cancelPublicationReview: noop,
    assignmentFallback: null,
    exportAssignmentFallback: vi.fn(async () => false),
    publishRoomSetup: vi.fn(async () => undefined),
    roomStatus: vi.fn((room: Room): RoomStatus =>
      room.publishedMatchId ? 'waiting' : room.relayPublished ? 'ready-to-pair' : 'not-published',
    ),
    warnings: [],
    chooseFolder: vi.fn(async () => undefined),
    saveNewResults: vi.fn(async () => undefined),
    saveResult: vi.fn(async () => undefined),
    markResultImported: noop,
    unmarkResultImported: noop,
    needsImportCount: 0,
    resultBusy: vi.fn(() => false),
    savingResults: false,
    pollResults: vi.fn(async () => undefined),
    unsavedResultWarning: null,
    phase: 'setup' as const,
    auditLog: [],
    pendingLiveOverride: null,
    confirmLiveOverride: () => {},
    cancelLiveOverride: () => {},
    goLive: () => {},
    reopenTournament: () => {},
    reconciliation: null,
    reconciliationRunning: false,
    refreshReconciliation: async () => null,
    finishTournament: async () => {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('room pairing sheets', () => {
  test('does not offer a sheet before the room setup is published', () => {
    const tournament = loadedFixture();
    render(
      <RoomsView
        bridge={testBridge([testRoom(tournament.rounds[0].id, 'room-1', 'Room 1', '48213906', false)])}
      />,
    );

    expect(screen.getByRole('button', { name: 'Print sheet' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Print all room sheets' })).toBeDisabled();
    expect(
      screen.getByText(/Publish the room setup to the relay before printing pairing sheets/),
    ).toBeInTheDocument();
  });

  test('prints one published room with its canonical URL and no management credential', async () => {
    const user = userEvent.setup();
    const tournament = loadedFixture();
    const room = testRoom(tournament.rounds[0].id, 'room-204', 'Room 204', '48213906', true);
    const bridge = testBridge([room]);
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    render(<RoomsView bridge={bridge} />);

    await user.click(screen.getByRole('button', { name: 'Print sheet' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));

    const expectedUrl =
      'https://qbsheet.com/#qbtcp-pair?v=1&server=https%3A%2F%2Frelay.example.workers.dev%2Fqbtcp%2Fv1%2Ftournaments%2Fbcdfghjkmnpqrstvwxyz2345&code=48213906&room=room-204';
    const sheet = document.querySelector('.room-print-sheet');
    expect(sheet).toHaveAttribute('data-room-id', 'room-204');
    expect(sheet).toHaveTextContent(tournament.name);
    expect(sheet).toHaveTextContent('Room 204');
    expect(sheet).toHaveTextContent('48213906');
    expect(sheet).toHaveTextContent('Go to qbsheet.com.');
    expect(sheet).toHaveTextContent('Enter your name.');
    expect(sheet).toHaveTextContent('Tournament control address');
    expect(sheet).toHaveTextContent('Pairing code');
    expect(sheet).toHaveTextContent('Trouble connecting?');
    expect(screen.getByRole('link', { name: expectedUrl })).toHaveAttribute('href', expectedUrl);
    expect(sheet).not.toHaveTextContent('management-secret');
    expect(sheet).not.toHaveTextContent('setupToken');

    window.dispatchEvent(new Event('afterprint'));
    await waitFor(() => expect(document.querySelector('.room-print-sheet')).toBeNull());
  });

  test('prints a room after room-only setup publication', async () => {
    const user = userEvent.setup();
    const tournament = loadedFixture();
    const room = {
      ...testRoom(tournament.rounds[0].id, 'room-setup', 'Room Setup', '48213906', false),
      relayPublished: true,
    };
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    render(<RoomsView bridge={testBridge([room])} />);

    await user.click(screen.getByRole('button', { name: 'Print sheet' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(document.querySelector('.room-print-sheet')).toHaveAttribute('data-room-id', 'room-setup');
  });

  test('prints all published rooms as one sheet element per room', async () => {
    const user = userEvent.setup();
    const tournament = loadedFixture();
    const rooms = [
      testRoom(tournament.rounds[0].id, 'room-1', 'Room 1', '48213906', true),
      testRoom(tournament.rounds[0].id, 'room-2', 'Room 2', '91374620', true),
    ];
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    render(<RoomsView bridge={testBridge(rooms)} />);

    await user.click(screen.getByRole('button', { name: 'Print all room sheets' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));

    expect(
      [...document.querySelectorAll<HTMLElement>('.room-print-sheet')].map((sheet) => sheet.dataset.roomId),
    ).toEqual(['room-1', 'room-2']);
  });

  test('withholds a sheet while a replacement pairing code is pending', () => {
    const tournament = loadedFixture();
    const room = {
      ...testRoom(tournament.rounds[0].id, 'room-pending', 'Room Pending', '48213906', true),
      pendingPairingCode: '91374620',
    };
    render(<RoomsView bridge={testBridge([room])} />);

    expect(screen.getByRole('button', { name: 'Print sheet' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Print all room sheets' })).toBeDisabled();
  });
});

describe('batch printing the ready subset', () => {
  test('one unpublished room leaves the batch available for the ready rooms', async () => {
    const user = userEvent.setup();
    const tournament = loadedFixture();
    const rooms = [
      testRoom(tournament.rounds[0].id, 'room-1', 'Room 1', '48213906', true),
      testRoom(tournament.rounds[0].id, 'room-2', 'Room 2', '91374620', false),
    ];
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    render(<RoomsView bridge={testBridge(rooms)} />);

    // The batch names its scope instead of refusing everything...
    const batch = screen.getByRole('button', { name: 'Print 1 ready room sheet' });
    expect(batch).toBeEnabled();
    // ...and says what is left out and why, so a partial batch is never mistaken for setup done.
    expect(screen.getByTestId('print-hint')).toHaveTextContent(
      'Printing 1 of 2 room sheets. Not included: Room 2 (its room setup is not published yet).',
    );

    await user.click(batch);
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    // The print document holds only the ready room's sheet.
    expect(
      [...document.querySelectorAll<HTMLElement>('.room-print-sheet')].map((sheet) => sheet.dataset.roomId),
    ).toEqual(['room-1']);

    window.dispatchEvent(new Event('afterprint'));
    await waitFor(() => expect(document.querySelector('.room-print-sheet')).toBeNull());
  });

  test('a pending replacement code stays excluded while other rooms batch', async () => {
    const user = userEvent.setup();
    const tournament = loadedFixture();
    const rooms = [
      testRoom(tournament.rounds[0].id, 'room-1', 'Room 1', '48213906', true),
      {
        ...testRoom(tournament.rounds[0].id, 'room-pending', 'Room Pending', '91374620', true),
        pendingPairingCode: '00000000',
      },
    ];
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    render(<RoomsView bridge={testBridge(rooms)} />);

    // The stale code is not printable on its own...
    expect(screen.getByRole('button', { name: 'Print 1 ready room sheet' })).toBeEnabled();
    expect(screen.getByTestId('print-hint')).toHaveTextContent(
      'Printing 1 of 2 room sheets. Not included: Room Pending (a replacement code is waiting to be published).',
    );

    // ...and the batch carries only the ready room.
    await user.click(screen.getByRole('button', { name: 'Print 1 ready room sheet' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(
      [...document.querySelectorAll<HTMLElement>('.room-print-sheet')].map((sheet) => sheet.dataset.roomId),
    ).toEqual(['room-1']);

    window.dispatchEvent(new Event('afterprint'));
    await waitFor(() => expect(document.querySelector('.room-print-sheet')).toBeNull());
  });

  test('several ready rooms batch together and name every excluded room', async () => {
    const user = userEvent.setup();
    const tournament = loadedFixture();
    const rooms = [
      testRoom(tournament.rounds[0].id, 'room-1', 'Room 1', '48213906', true),
      testRoom(tournament.rounds[0].id, 'room-2', 'Room 2', '91374620', true),
      testRoom(tournament.rounds[0].id, 'room-3', 'Room 3', '75038112', false),
    ];
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    render(<RoomsView bridge={testBridge(rooms)} />);

    await user.click(screen.getByRole('button', { name: 'Print 2 ready room sheets' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(
      [...document.querySelectorAll<HTMLElement>('.room-print-sheet')].map((sheet) => sheet.dataset.roomId),
    ).toEqual(['room-1', 'room-2']);
    expect(screen.getByTestId('print-hint')).toHaveTextContent(
      'Printing 2 of 3 room sheets. Not included: Room 3 (its room setup is not published yet).',
    );

    window.dispatchEvent(new Event('afterprint'));
    await waitFor(() => expect(document.querySelector('.room-print-sheet')).toBeNull());
  });

  test('zero printable rooms keeps the batch disabled with guidance', () => {
    const tournament = loadedFixture();
    render(
      <RoomsView
        bridge={testBridge([testRoom(tournament.rounds[0].id, 'room-1', 'Room 1', '48213906', false)])}
      />,
    );

    expect(screen.getByRole('button', { name: 'Print all room sheets' })).toBeDisabled();
    expect(screen.getByTestId('print-hint')).toHaveTextContent(
      'Publish the room setup to the relay before printing pairing sheets.',
    );
  });

  test('without Scorer readiness nothing is printable', () => {
    const tournament = loadedFixture();
    const rooms = [
      testRoom(tournament.rounds[0].id, 'room-1', 'Room 1', '48213906', true),
      testRoom(tournament.rounds[0].id, 'room-2', 'Room 2', '91374620', true),
    ];
    render(<RoomsView bridge={testBridge(rooms, false)} />);

    expect(screen.getByRole('button', { name: 'Print all room sheets' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Print sheet' })).toHaveLength(2);
    for (const button of screen.getAllByRole('button', { name: 'Print sheet' })) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByTestId('print-hint')).toHaveTextContent(
      'Confirm Scorer origin readiness before printing pairing sheets.',
    );
  });
});
