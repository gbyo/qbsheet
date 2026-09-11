import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { BridgeState } from '../model/persistence';
import type { BridgeApi } from '../model/useBridge';
import ResultsView from './ResultsView';

function bridgeWhileBatchSaving(): BridgeApi {
  const state: BridgeState = {
    version: 2,
    relay: null,
    scorerReadiness: null,
    yftPath: null,
    tournamentName: null,
    rooms: [],
    selectedRoundId: null,
    roundPlans: [],
    pendingRoomRemovals: [],
    retiredRoomIds: [],
    resultFolder: '/tournaments/results',
    results: [{ resultId: 'result-1', qbj: {}, receivedAt: '2026-09-11T15:00:00Z' }],
  };
  return {
    state,
    tournament: null,
    loadWarnings: [],
    notice: null,
    dismissNotice: vi.fn(),
    relayReachable: null,
    scorerReadiness: null,
    busy: false,
    native: true,
    changingRelay: false,
    plannedTeamsFor: () => ({ leftTeamId: null, rightTeamId: null }),
    planStatus: () => 'no-game' as const,
    roundProgress: { roundId: null, assigned: 0 },
    phaseRoundProgress: [],
    warnings: [],
    savingResults: true,
    resultBusy: vi.fn(() => true),
    loadFile: vi.fn(async () => undefined),
    loadFileContents: vi.fn(),
    pendingFileSwitch: null,
    confirmFileSwitch: vi.fn(),
    cancelFileSwitch: vi.fn(),
    connectRelay: vi.fn(async () => false),
    relayCredentialSavePending: false,
    retryRelayCredentialSave: vi.fn(async () => false),
    persistenceSavePending: false,
    retryStatePersistence: vi.fn(() => true),
    checkScorerReadiness: vi.fn(async () => undefined),
    beginRelayChange: vi.fn(),
    cancelRelayChange: vi.fn(),
    forgetRelayCredential: vi.fn(),
    addRoom: vi.fn(),
    renameRoom: vi.fn(),
    removeRoom: vi.fn(),
    setRoomTeams: vi.fn(),
    regeneratePairingCode: vi.fn(),
    selectRound: vi.fn(),
    publish: vi.fn(async () => undefined),
    publishRoomSetup: vi.fn(async () => undefined),
    roomStatus: vi.fn(),
    chooseFolder: vi.fn(async () => undefined),
    saveNewResults: vi.fn(async () => undefined),
    saveResult: vi.fn(async () => undefined),
    pollResults: vi.fn(async () => undefined),
    unsavedResultWarning: null,
  };
}

describe('ResultsView save controls', () => {
  test('disables the batch and row saves while a batch is active', () => {
    render(<ResultsView bridge={bridgeWhileBatchSaving()} />);

    expect(screen.getByRole('button', { name: /Save New Results/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
