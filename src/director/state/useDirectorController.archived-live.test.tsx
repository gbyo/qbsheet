import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defaultRules, emptyDirectorState, type DirectorState } from '../domain';
import { newPublication } from '../live/LiveView';
import { MemoryDirectorRepository } from '../persistence';
import { useDirectorController } from './useDirectorController';

const localServerMocks = vi.hoisted(() => ({
  start: vi.fn(async () => ({})),
  stop: vi.fn(async () => undefined),
  clear: vi.fn(async () => undefined),
  publish: vi.fn(async () => ({ revision: 1, publicUrl: 'http://127.0.0.1:8790' })),
  origin: vi.fn(() => 'http://127.0.0.1:8790'),
}));

const credentialMocks = vi.hoisted(() => ({
  claim: vi.fn(async () => ({ origin: 'https://live.example.test', managementToken: 'token' })),
  ensure: vi.fn(async () => undefined),
  forget: vi.fn(async () => undefined),
  read: vi.fn(async () => null),
  store: vi.fn(async () => ({ keychainService: 'QBSheet', keychainAccount: 'test' })),
}));

vi.mock('../live/localServer', () => ({
  startLocalLiveServer: localServerMocks.start,
  stopLocalLiveServer: localServerMocks.stop,
  clearLocalLive: localServerMocks.clear,
  publishLocalLive: localServerMocks.publish,
  localLiveOrigin: localServerMocks.origin,
}));

vi.mock('../live/credentials', () => ({
  claimLiveBackend: credentialMocks.claim,
  ensureLiveCredentialStore: credentialMocks.ensure,
  forgetLiveCredential: credentialMocks.forget,
  readLiveCredential: credentialMocks.read,
  storeLiveCredential: credentialMocks.store,
}));

function stateWithStatus(status: 'complete' | 'archived'): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: `${status}-tournament`,
    name: `${status} invitational`,
    date: '2026-09-05',
    venue: 'Archive hall',
    organizer: 'QBSheet',
    status,
    timeZone: 'UTC',
    rules: structuredClone(defaultRules),
    formatId: null,
    currentPhaseId: null,
    currentPacketId: null,
    currentRoundId: null,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
  };
  return state;
}

function withLocalLive(state: DirectorState): DirectorState {
  const publication = newPublication('2026-09-05T10:00:00.000Z');
  publication.backend = { kind: 'local', origin: '' };
  publication.lifecycle = 'live';
  state.live = publication;
  return state;
}

function withPendingLocalLive(state: DirectorState): DirectorState {
  withLocalLive(state);
  const publication = state.live!;
  publication.outbox = [
    {
      id: 'pending-live-item',
      revision: 1,
      kind: 'snapshot',
      payload: {},
      state: 'pending',
      attempts: 0,
      createdAt: '2026-09-05T10:00:00.000Z',
      nextAttemptAt: '2026-09-05T10:00:00.000Z',
    },
  ];
  publication.sync.localRevision = 1;
  publication.sync.pendingItems = 1;
  return state;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('archived tournament Live side-effect guard', () => {
  test('does not restart a persisted local Live server when an archived tournament is opened', async () => {
    const repository = new MemoryDirectorRepository();
    await repository.save(withLocalLive(stateWithStatus('archived')));

    const hook = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await new Promise((resolve) => window.setTimeout(resolve, 25));

    expect(localServerMocks.start).not.toHaveBeenCalled();
    hook.unmount();
  });

  test('rejects local and remote Live setup before any external work starts', async () => {
    const repository = new MemoryDirectorRepository();
    await repository.save(stateWithStatus('archived'));
    const hook = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    await act(async () => {
      await expect(hook.result.current.live.enable({ kind: 'local', origin: '' }, null)).rejects.toThrow(
        /archived/i,
      );
      await expect(
        hook.result.current.live.enable(
          { kind: 'custom', origin: 'https://live.example.test' },
          'setup-token',
        ),
      ).rejects.toThrow(/archived/i);
    });

    expect(localServerMocks.start).not.toHaveBeenCalled();
    expect(credentialMocks.ensure).not.toHaveBeenCalled();
    expect(credentialMocks.claim).not.toHaveBeenCalled();
    expect(credentialMocks.store).not.toHaveBeenCalled();
    hook.unmount();
  });

  test('does not drain a persisted pending local Live item while archived', async () => {
    const repository = new MemoryDirectorRepository();
    await repository.save(withPendingLocalLive(stateWithStatus('archived')));
    const hook = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    await new Promise((resolve) => window.setTimeout(resolve, 1100));

    expect(localServerMocks.start).not.toHaveBeenCalled();
    expect(localServerMocks.publish).not.toHaveBeenCalled();
    expect(localServerMocks.clear).not.toHaveBeenCalled();
    expect(localServerMocks.stop).not.toHaveBeenCalled();
    expect(hook.result.current.state.live?.outbox).toMatchObject([
      { id: 'pending-live-item', state: 'pending' },
    ]);
    hook.unmount();
  });
});
