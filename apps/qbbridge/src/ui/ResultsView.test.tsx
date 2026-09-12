import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { BridgeState } from '../model/persistence';
import type { BridgeApi } from '../model/useBridge';
import { scoredResultDocument } from '../tests/scoredResult';
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
    pendingPublication: null,
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
    importRecoveryPackage: vi.fn(async () => false),
    createRecoveryPackage: vi.fn(async () => false),
    provisionBackup: vi.fn(async () => null),
    rotateBackup: vi.fn(async () => null),
    revokeBackup: vi.fn(async () => false),
    takeOverRelay: vi.fn(async () => false),
    transferRelayToPrimary: vi.fn(async () => false),
    reconcilePendingPublication: vi.fn(async () => 'none' as const),
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
    pendingPublicationReview: null,
    confirmPublicationReview: vi.fn(async () => undefined),
    cancelPublicationReview: vi.fn(),
    assignmentFallback: null,
    exportAssignmentFallback: vi.fn(async () => false),
    publishRoomSetup: vi.fn(async () => undefined),
    roomStatus: vi.fn(),
    chooseFolder: vi.fn(async () => undefined),
    saveNewResults: vi.fn(async () => undefined),
    saveResult: vi.fn(async () => undefined),
    markResultImported: vi.fn(),
    unmarkResultImported: vi.fn(),
    needsImportCount: 0,
    pollResults: vi.fn(async () => undefined),
    unsavedResultWarning: null,
  };
}

function bridgeForResults(results: BridgeState['results']): BridgeApi {
  const bridge = bridgeWhileBatchSaving();
  return {
    ...bridge,
    state: { ...bridge.state, results },
    savingResults: false,
    resultBusy: vi.fn(() => false),
  };
}

describe('ResultsView save controls', () => {
  test('disables the batch and row saves while a batch is active', () => {
    render(<ResultsView bridge={bridgeWhileBatchSaving()} />);

    expect(screen.getByRole('button', { name: /Save New Results/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Save result/ })).toBeDisabled();
  });

  test('gives every Save and Save again action a distinct result identity', async () => {
    const user = userEvent.setup();
    const first = scoredResultDocument().result;
    const second = JSON.parse(JSON.stringify(first)) as typeof first;
    const secondMatch = second.objects.find((entry) => entry.type === 'Match');
    if (!secondMatch) throw new Error('fixture has no match');
    secondMatch.location = 'Room 102';

    const bridge = bridgeForResults([
      { resultId: 'new-a', qbj: first, receivedAt: '2026-09-11T15:01:00Z' },
      { resultId: 'new-b', qbj: second, receivedAt: '2026-09-11T15:02:00Z' },
      { resultId: 'saved-a', qbj: first, receivedAt: '2026-09-11T15:03:00Z', savedPath: '/results/a.qbj' },
      { resultId: 'saved-b', qbj: second, receivedAt: '2026-09-11T15:04:00Z', savedPath: '/results/b.qbj' },
      { resultId: 'blank', qbj: {}, receivedAt: '2026-09-11T15:05:00Z' },
    ]);
    render(<ResultsView bridge={bridge} />);

    const saveButtons = screen.getAllByRole('button', { name: /^Save result/ });
    const saveAgainButtons = screen.getAllByRole('button', { name: /^Save again result/ });
    expect(new Set(saveButtons.map((button) => button.getAttribute('aria-label'))).size).toBe(3);
    expect(new Set(saveAgainButtons.map((button) => button.getAttribute('aria-label'))).size).toBe(2);
    expect(saveButtons.every((button) => button.textContent === 'Save')).toBe(true);
    expect(saveAgainButtons.every((button) => button.textContent === 'Save again')).toBe(true);
    expect(
      screen.getByRole('button', { name: /Save result — Round 4, Room 101, Cony vs Deering/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Save result — Round 4, Room 102, Cony vs Deering/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save result \(result blank\)/ })).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: /Save result — Round 4, Room 101, Cony vs Deering/ }),
    );
    expect(bridge.saveResult).toHaveBeenCalledWith('new-a');
  });

  test('shows the local import marker and lets the operator filter it', async () => {
    const user = userEvent.setup();
    const bridge = bridgeWhileBatchSaving();
    const { result } = scoredResultDocument();
    bridge.savingResults = false;
    bridge.resultBusy = vi.fn(() => false);
    bridge.needsImportCount = 1;
    bridge.state.results = [
      {
        resultId: 'saved-result',
        qbj: result,
        receivedAt: '2026-09-11T15:00:00Z',
        savedPath: '/results/saved.qbj',
        importStatus: 'needs-import',
      },
      {
        resultId: 'imported-result',
        qbj: result,
        receivedAt: '2026-09-11T14:00:00Z',
        savedPath: '/results/imported.qbj',
        importStatus: 'imported',
      },
    ];

    render(<ResultsView bridge={bridge} />);
    expect(screen.getAllByText('Needs import').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Marked imported').length).toBeGreaterThan(0);
    await user.selectOptions(screen.getByLabelText('Show'), 'needs-import');
    expect(screen.getByText('/results/saved.qbj')).toBeInTheDocument();
    expect(screen.queryByText('/results/imported.qbj')).not.toBeInTheDocument();
  });
});
