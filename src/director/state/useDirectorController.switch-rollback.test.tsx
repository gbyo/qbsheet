/**
 * Tournament-switch authority after a rejected native open (#786).
 *
 * When the target activates in native storage but its QBTCP restart fails,
 * the native command rolls back to the outgoing document and reports the
 * restore. React must then keep displaying the outgoing tournament: the
 * rejected switch returns false and both the controller state and the
 * durable repository document still name the outgoing tournament.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defaultRules, emptyDirectorState, type DirectorState } from '../domain';
import { MemoryDirectorRepository } from '../persistence';
import { useDirectorController } from './useDirectorController';

const localServerMocks = vi.hoisted(() => ({
  start: vi.fn(async () => ({ running: true, address: '127.0.0.1', port: 8790 })),
  stop: vi.fn(async () => undefined),
  clear: vi.fn(async () => undefined),
  publish: vi.fn(async () => ({ revision: 1, publicUrl: 'http://127.0.0.1:8790' })),
  status: vi.fn(async () => ({ running: false, address: '127.0.0.1', port: 8790 })),
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
  readLocalLiveServerStatus: localServerMocks.status,
  localLiveOrigin: localServerMocks.origin,
}));

vi.mock('../live/credentials', () => ({
  claimLiveBackend: credentialMocks.claim,
  ensureLiveCredentialStore: credentialMocks.ensure,
  forgetLiveCredential: credentialMocks.forget,
  readLiveCredential: credentialMocks.read,
  storeLiveCredential: credentialMocks.store,
}));

function tournamentState(id: string, name: string): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id,
    name,
    date: '2026-09-05',
    venue: 'Switch hall',
    organizer: 'QBSheet',
    status: 'running',
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

/**
 * Mirrors the fixed native command: the target activated in storage, its
 * QBTCP restart failed, and the command rolled the durable document back to
 * the outgoing tournament before rejecting.
 */
class PostOpenRollbackRepository extends MemoryDirectorRepository {
  override async openTournament(_id: string): Promise<DirectorState> {
    throw new Error(
      'Tournament tournament-b could not be opened operationally because QBTCP could not restart. Tournament tournament-a was restored.',
    );
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('rejected switch after native rollback (#786)', () => {
  test('React stays on the outgoing tournament and the durable document agrees', async () => {
    const repository = new PostOpenRollbackRepository();
    await repository.save(tournamentState('tournament-a', 'Tournament A'));
    await repository.saveDocument!(tournamentState('tournament-b', 'Tournament B'), false);

    const hook = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.state.tournament?.id).toBe('tournament-a');

    let switched = true;
    await act(async () => {
      switched = await hook.result.current.switchTournament('tournament-b');
    });

    expect(switched).toBe(false);
    expect(hook.result.current.state.tournament?.id).toBe('tournament-a');
    expect(hook.result.current.error).toMatch(/tournament-a was restored/i);
    // The durable side rolled back too: no React/storage identity split.
    expect((await repository.load()).tournament?.id).toBe('tournament-a');
    hook.unmount();
  });
});
