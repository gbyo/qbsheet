import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { emptyState } from '../model/persistence';
import type { BridgeApi } from '../model/useBridge';
import { loadedFixture } from '../tests/fixture';
import SetupView from './SetupView';

function bridgeForRecovery(createResult: boolean, importResult: boolean): BridgeApi {
  const tournament = loadedFixture();
  const noop = vi.fn();
  return {
    state: {
      ...emptyState(),
      relay: {
        baseUrl: 'https://relay.example',
        tournamentId: 'bcdfghjkmnpqrstvwxyz2345',
        managementToken: 'test-value',
        epoch: 1,
        revision: 0,
      },
      selectedRoundId: tournament.rounds[0]?.id ?? null,
    },
    tournament,
    loadWarnings: [],
    notice: null,
    dismissNotice: noop,
    relayReachable: true,
    scorerReadiness: {
      status: 'ready',
      origin: 'https://qbsheet.com',
      message: 'Scorer can use this relay.',
    },
    busy: false,
    native: true,
    loadFile: async () => {},
    loadFileContents: noop,
    pendingFileSwitch: null,
    confirmFileSwitch: noop,
    cancelFileSwitch: noop,
    connectRelay: async () => true,
    importRecoveryPackage: vi.fn(async () => importResult),
    createRecoveryPackage: vi.fn(async () => createResult),
    provisionBackup: async () => null,
    rotateBackup: async () => null,
    revokeBackup: async () => false,
    takeOverRelay: async () => false,
    transferRelayToPrimary: async () => false,
    relayCredentialSavePending: false,
    retryRelayCredentialSave: async () => false,
    persistenceSavePending: false,
    retryStatePersistence: () => true,
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
    plannedTeamsFor: () => ({ leftTeamId: null, rightTeamId: null }),
    planStatus: () => 'no-game',
    roundProgress: { roundId: null, assigned: 0 },
    phaseRoundProgress: [],
    publish: async () => {},
    pendingPublicationReview: null,
    confirmPublicationReview: async () => {},
    cancelPublicationReview: noop,
    assignmentFallback: null,
    exportAssignmentFallback: async () => false,
    publishRoomSetup: async () => {},
    roomStatus: () => 'ready-to-pair',
    warnings: [],
    chooseFolder: async () => {},
    saveNewResults: async () => {},
    saveResult: async () => {},
    markResultImported: noop,
    unmarkResultImported: noop,
    needsImportCount: 0,
    resultBusy: () => false,
    savingResults: false,
    pollResults: async () => {},
    unsavedResultWarning: null,
  };
}

describe('recovery package passphrases', () => {
  test('clears the creation passphrase after success', async () => {
    const user = userEvent.setup();
    const bridge = bridgeForRecovery(true, false);
    render(<SetupView bridge={bridge} />);
    const field = screen.getByLabelText('New recovery passphrase');
    await user.type(field, 'abcdefghijkl');
    await user.click(screen.getByRole('button', { name: 'Create encrypted backup package…' }));
    await waitFor(() => expect(field).toHaveValue(''));
    expect(bridge.createRecoveryPackage).toHaveBeenCalledWith(
      'abcdefghijkl',
      'Tournament backup controller',
    );
  });

  test('keeps the creation passphrase after failure or cancellation', async () => {
    const user = userEvent.setup();
    const bridge = bridgeForRecovery(false, false);
    render(<SetupView bridge={bridge} />);
    const field = screen.getByLabelText('New recovery passphrase');
    await user.type(field, 'abcdefghijkl');
    await user.click(screen.getByRole('button', { name: 'Create encrypted backup package…' }));
    await waitFor(() => expect(bridge.createRecoveryPackage).toHaveBeenCalled());
    expect(field).toHaveValue('abcdefghijkl');
  });

  test('clears the import passphrase after success', async () => {
    const user = userEvent.setup();
    const bridge = bridgeForRecovery(false, true);
    render(<SetupView bridge={bridge} />);
    const field = screen.getByLabelText('Recovery passphrase');
    await user.type(field, 'abcdefghijkl');
    await user.click(screen.getByRole('button', { name: 'Open encrypted recovery package…' }));
    await waitFor(() => expect(field).toHaveValue(''));
    expect(bridge.importRecoveryPackage).toHaveBeenCalledWith('abcdefghijkl');
  });

  test('keeps the import passphrase after failure or cancellation', async () => {
    const user = userEvent.setup();
    const bridge = bridgeForRecovery(false, false);
    render(<SetupView bridge={bridge} />);
    const field = screen.getByLabelText('Recovery passphrase');
    await user.type(field, 'abcdefghijkl');
    await user.click(screen.getByRole('button', { name: 'Open encrypted recovery package…' }));
    await waitFor(() => expect(bridge.importRecoveryPackage).toHaveBeenCalled());
    expect(field).toHaveValue('abcdefghijkl');
  });
});
