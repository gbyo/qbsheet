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
    leftTeamId: 'Team_Cony',
    rightTeamId: 'Team_Deering',
    publishedMatchId: published ? `match-${id}` : null,
    publishedRoundId: published ? tournamentRoundId : null,
  };
}

function testBridge(rooms: Room[]): BridgeApi {
  const tournament = loadedFixture();
  const state: BridgeState = {
    ...emptyState(),
    relay,
    rooms,
    selectedRoundId: tournament.rounds[0]?.id ?? null,
  };
  const noop = vi.fn();
  return {
    state,
    tournament,
    loadWarnings: [],
    notice: null,
    dismissNotice: noop,
    relayReachable: true,
    scorerReadiness: {
      status: 'ready',
      origin: 'https://qbsheet.com',
      message: 'https://qbsheet.com can pair and use this relay.',
    },
    busy: false,
    native: true,
    loadFile: vi.fn(async () => undefined),
    loadFileContents: noop,
    connectRelay: vi.fn(async () => true),
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
    roundChangeDiscardsSelections: false,
    publish: vi.fn(async () => undefined),
    publishRoomSetup: vi.fn(async () => undefined),
    roomStatus: vi.fn((room: Room): RoomStatus => (room.publishedMatchId ? 'waiting' : 'ready')),
    warnings: [],
    chooseFolder: vi.fn(async () => undefined),
    saveNewResults: vi.fn(async () => undefined),
    saveResult: vi.fn(async () => undefined),
    resultBusy: vi.fn(() => false),
    savingResults: false,
    pollResults: vi.fn(async () => undefined),
    unsavedResultWarning: null,
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
      screen.getByText('Publish the room setup to the relay before printing pairing sheets.'),
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
    expect(screen.getByRole('link', { name: expectedUrl })).toHaveAttribute('href', expectedUrl);
    expect(sheet).not.toHaveTextContent('management-secret');
    expect(sheet).not.toHaveTextContent('setupToken');

    window.dispatchEvent(new Event('afterprint'));
    await waitFor(() => expect(document.querySelector('.room-print-sheet')).toBeNull());
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
});
