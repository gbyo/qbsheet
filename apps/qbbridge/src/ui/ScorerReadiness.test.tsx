import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { emptyState } from '../model/persistence';
import type { BridgeApi, ScorerReadinessState } from '../model/useBridge';
import { newRoom } from '../model/rooms';
import { loadedFixture } from '../tests/fixture';
import RoomsView from './RoomsView';
import SetupView from './SetupView';

function bridgeFor(status: ScorerReadinessState['status']): BridgeApi {
  const tournament = loadedFixture();
  const room = { ...newRoom('room-1', 'Room 1', '48213906'), relayPublished: true };
  const state = {
    ...emptyState(),
    relay: {
      baseUrl: 'https://relay.example',
      tournamentId: 'bcdfghjkmnpqrstvwxyz2345',
      managementToken: 'management-secret',
      epoch: 1,
      revision: 0,
    },
    rooms: [room],
    selectedRoundId: tournament.rounds[0]?.id ?? null,
  };
  const readiness: ScorerReadinessState = {
    status,
    origin: 'https://qbsheet.com',
    message:
      status === 'blocked'
        ? 'Add https://qbsheet.com to RELAY_ALLOWED_ORIGINS in the Cloudflare deployment.'
        : status === 'ready'
          ? 'https://qbsheet.com can pair and use this relay.'
          : 'Checking whether https://qbsheet.com can pair with this relay.',
  };
  const noop = vi.fn();
  return {
    state,
    tournament,
    loadWarnings: [],
    notice: null,
    dismissNotice: noop,
    relayReachable: true,
    scorerReadiness: readiness,
    busy: false,
    native: true,
    loadFile: async () => {},
    loadFileContents: noop,
    connectRelay: async () => true,
    checkScorerReadiness: async () => {},
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
    publish: async () => {},
    publishRoomSetup: async () => {},
    roomStatus: () => 'ready',
    warnings: [],
    chooseFolder: async () => {},
    saveNewResults: async () => {},
    saveResult: async () => {},
    resultBusy: () => false,
    savingResults: false,
    pollResults: async () => {},
    unsavedResultWarning: null,
  };
}

describe('Scorer-origin readiness UX', () => {
  test('setup names the deployment fix when qbsheet.com is blocked', () => {
    render(<SetupView bridge={bridgeFor('blocked')} />);

    expect(screen.getByRole('heading', { name: 'Scorer cannot use this relay yet' })).toBeInTheDocument();
    expect(screen.getByText(/Add https:\/\/qbsheet\.com to RELAY_ALLOWED_ORIGINS/)).toBeInTheDocument();
    expect(screen.getByText(/QR codes stay hidden/)).toBeInTheDocument();
  });

  test('a blocked or unverified relay withholds the room QR', () => {
    render(<RoomsView bridge={bridgeFor('blocked')} />);

    expect(screen.queryByRole('img', { name: /Pairing QR code/ })).toBeNull();
    expect(screen.getByText(/QR withheld until Scorer readiness is confirmed/)).toBeInTheDocument();
  });

  test('a relay only shows the room QR after readiness passes', () => {
    render(<RoomsView bridge={bridgeFor('ready')} />);

    expect(screen.getByRole('img', { name: /Pairing QR code for Room 1/ })).toBeInTheDocument();
  });
});
