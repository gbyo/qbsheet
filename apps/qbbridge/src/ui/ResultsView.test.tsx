import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { BridgeState, StoredResult } from '../model/persistence';
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

function resultQbj(location: string, leftName: string, rightName: string): object {
  return {
    objects: [
      { type: 'Tournament', id: 'tournament', phases: [{ $ref: 'phase' }] },
      { type: 'Phase', id: 'phase', rounds: [{ $ref: 'round' }] },
      { type: 'Round', id: 'round', name: '4', matches: [{ $ref: 'match' }] },
      { type: 'Team', id: 'left', name: leftName },
      { type: 'Team', id: 'right', name: rightName },
      {
        type: 'Match',
        id: 'match',
        location,
        match_teams: [
          { team: { $ref: 'left' }, points: 300 },
          { team: { $ref: 'right' }, points: 200 },
        ],
      },
    ],
  };
}

function bridgeWithResults(results: StoredResult[], resultFolder: string | null = '/tournaments/results'): BridgeApi {
  const bridge = bridgeWhileBatchSaving();
  return {
    ...bridge,
    state: { ...bridge.state, resultFolder, results },
    savingResults: false,
    resultBusy: vi.fn(() => false),
    saveResult: vi.fn(async () => undefined),
  };
}

describe('ResultsView save controls', () => {
  test('disables the batch and row saves while a batch is active', () => {
    render(<ResultsView bridge={bridgeWhileBatchSaving()} />);

    expect(screen.getByRole('button', { name: /Save New Results/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Save result/ })).toBeDisabled();
  });

  test('gives each row save a contextual, unique accessible name without changing visible copy', () => {
    const bridge = bridgeWithResults([
      {
        resultId: 'result-a',
        qbj: resultQbj('Room 101', 'Aiken', 'Dorman'),
        receivedAt: '2026-09-11T15:00:00Z',
      },
      {
        resultId: 'result-b',
        qbj: resultQbj('Room 102', 'Southside', 'Wren A'),
        receivedAt: '2026-09-11T15:01:00Z',
      },
    ]);

    render(<ResultsView bridge={bridge} />);

    const aiken = screen.getByRole('button', {
      name: /Save result — Round 4, Room 101, Aiken vs Dorman, result [0-9a-f]{12}/,
    });
    const southside = screen.getByRole('button', {
      name: /Save result — Round 4, Room 102, Southside vs Wren A, result [0-9a-f]{12}/,
    });
    expect(aiken).toHaveTextContent('Save');
    expect(southside).toHaveTextContent('Save');

    fireEvent.click(aiken);
    expect(bridge.saveResult).toHaveBeenCalledWith('result-a');
  });

  test('saved and sparse rows remain uniquely named and preserve disabled state without a folder', () => {
    const bridge = bridgeWithResults(
      [
        {
          resultId: 'saved-a',
          qbj: resultQbj('Room 101', 'Aiken', 'Dorman'),
          receivedAt: '2026-09-11T15:00:00Z',
          savedPath: '/old/result-a.qbj',
        },
        {
          resultId: 'saved-b',
          qbj: {},
          receivedAt: '2026-09-11T15:01:00Z',
          savedPath: '/old/result-b.qbj',
        },
      ],
      null,
    );

    render(<ResultsView bridge={bridge} />);

    const contextual = screen.getByRole('button', {
      name: /Save result again — Round 4, Room 101, Aiken vs Dorman, result [0-9a-f]{12}/,
    });
    const sparse = screen.getByRole('button', { name: /Save result again — result [0-9a-f]{12}/ });
    expect(contextual).toHaveTextContent('Save again');
    expect(sparse).toHaveTextContent('Save again');
    expect(contextual).toBeDisabled();
    expect(sparse).toBeDisabled();
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
