import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  defaultLivePublicationSettings,
  defaultRules,
  emptyDirectorState,
  type DirectorState,
} from '../domain';
import { MemoryDirectorRepository } from '../persistence';
import { useDirectorController } from './useDirectorController';

const credentialMocks = vi.hoisted(() => ({
  claim: vi.fn(async () => ({ origin: 'https://live.example.test', managementToken: 'token' })),
  ensure: vi.fn(async () => undefined),
  forget: vi.fn(async () => undefined),
  read: vi.fn(async (): Promise<string | null> => null),
  store: vi.fn(async () => ({ keychainService: 'QBSheet', keychainAccount: 'test' })),
}));

const localMocks = vi.hoisted(() => ({
  clear: vi.fn(async () => undefined),
  origin: vi.fn(() => 'http://127.0.0.1:8790'),
  start: vi.fn(async () => ({ running: true, address: '127.0.0.1', port: 8790 })),
  status: vi.fn(async () => ({ running: false, address: '127.0.0.1', port: 8790 })),
  stop: vi.fn(async () => undefined),
}));

const writerMocks = vi.hoisted(() => ({
  claim: vi.fn(),
  lost: null as AbortController | null,
}));

vi.mock('../live/credentials', () => ({
  claimLiveBackend: credentialMocks.claim,
  ensureLiveCredentialStore: credentialMocks.ensure,
  forgetLiveCredential: credentialMocks.forget,
  readLiveCredential: credentialMocks.read,
  storeLiveCredential: credentialMocks.store,
}));

vi.mock('../live/localServer', () => ({
  clearLocalLive: localMocks.clear,
  localLiveOrigin: localMocks.origin,
  publishLocalLive: vi.fn(async () => ({ revision: 1, publicUrl: 'http://127.0.0.1:8790' })),
  readLocalLiveServerStatus: localMocks.status,
  startLocalLiveServer: localMocks.start,
  stopLocalLiveServer: localMocks.stop,
}));

vi.mock('../persistence/DirectorWriterClaim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persistence/DirectorWriterClaim')>();
  return { ...actual, claimDirectorWriter: writerMocks.claim };
});

function tournamentState(id: string): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id,
    name: `Tournament ${id}`,
    date: '2026-09-09',
    venue: 'Test hall',
    organizer: 'QBSheet',
    status: 'running',
    timeZone: 'UTC',
    rules: structuredClone(defaultRules),
    formatId: null,
    currentPhaseId: 'phase-1',
    currentPacketId: null,
    currentRoundId: 'round-1',
    createdAt: '2026-09-09T10:00:00.000Z',
    updatedAt: '2026-09-09T10:00:00.000Z',
  };
  state.teams = [
    {
      id: 'team-left',
      organizationId: null,
      displayName: 'Left',
      teamLetter: 'A',
      seed: 1,
      status: 'confirmed',
      createdAt: state.tournament.createdAt,
      updatedAt: state.tournament.updatedAt,
    },
    {
      id: 'team-right',
      organizationId: null,
      displayName: 'Right',
      teamLetter: 'B',
      seed: 2,
      status: 'confirmed',
      createdAt: state.tournament.createdAt,
      updatedAt: state.tournament.updatedAt,
    },
  ];
  state.rooms = [
    {
      id: 'room-1',
      name: 'Room 1',
      status: 'live',
      moderatorId: null,
      scorekeeperId: null,
      equipmentId: null,
      available: true,
    },
  ];
  state.phases = [
    {
      id: 'phase-1',
      name: 'Preliminary',
      kind: 'preliminary',
      order: 1,
      formatId: 'format-1',
      poolIds: [],
      roundIds: ['round-1'],
      advancementRule: null,
      carryover: false,
      status: 'active',
    },
  ];
  state.rounds = [
    {
      id: 'round-1',
      phaseId: 'phase-1',
      name: 'Round 1',
      number: 1,
      revision: 1,
      status: 'released',
      packetId: null,
      scheduledGameIds: ['game-1'],
      scheduledStart: null,
      releasedAt: '2026-09-09T10:00:00.000Z',
      startedAt: '2026-09-09T10:01:00.000Z',
      closedAt: null,
    },
  ];
  state.scheduledGames = [
    {
      id: 'game-1',
      roundId: 'round-1',
      poolId: null,
      roomId: 'room-1',
      packetId: null,
      leftTeamId: 'team-left',
      rightTeamId: 'team-right',
      bye: false,
      status: 'live',
      assignmentRevision: 1,
    },
  ];
  state.qbtcpSessions = [
    {
      roomId: 'room-1',
      sessionId: 'session-1',
      matchId: 'game-1',
      deviceId: 'device-1',
      operatorName: 'Scorekeeper',
      state: 'paired',
      resumable: true,
      resultReceived: false,
      progressSequence: 0,
      lastSeenAt: '2026-09-09T10:00:00.000Z',
      progress: null,
      helpRequestId: null,
    },
  ];
  return state;
}

async function loadedController(repository: MemoryDirectorRepository) {
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

function okResponse(): Response {
  return {
    ok: true,
    headers: new Headers(),
    body: null,
    text: async () => JSON.stringify({ revision: 1 }),
  } as Response;
}

function nativeSnapshot(progress: Record<string, unknown>) {
  return {
    results: [],
    progress: [
      {
        sessionId: 'session-1',
        roomId: 'room-1',
        sequence: progress.sequence as number,
        matchState: progress.matchState,
        receivedAt: new Date().toISOString(),
      },
    ],
    presence: [],
    sessions: [],
    help: [],
    rosterAmendments: [],
  };
}

beforeEach(() => {
  writerMocks.claim.mockImplementation(async () => {
    const lost = new AbortController();
    writerMocks.lost = lost;
    return { held: true, lost: lost.signal, mode: 'broadcast-channel', release: vi.fn() };
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete window.__TAURI_INTERNALS__;
});

describe('Director Live publication boundary', () => {
  test('QBTCP progress uses the durable outbox and coalesces to the latest live score', async () => {
    const repository = new MemoryDirectorRepository();
    await repository.save(tournamentState('tournament-progress'));
    const hook = await loadedController(repository);

    await act(async () => {
      await hook.result.current.live.enable(
        { kind: 'custom', origin: 'https://live.example.test' },
        'setup-token',
      );
    });
    act(() => hook.result.current.live.updateSettings({ liveScores: true, liveProgress: true }));
    const fetch = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetch);
    const invoke = vi.fn(async (command: string) => {
      if (command !== 'director_server_snapshot') throw new Error(`unexpected command ${command}`);
      return nativeSnapshot({
        sequence: 1,
        matchState: {
          type: 'Match',
          tossups_read: 4,
          match_teams: [{ points: 20 }, { points: 10 }],
        },
      });
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });

    await act(async () => hook.result.current.syncQbtcp());
    expect(hook.result.current.state.qbtcpSessions[0]?.progress).toEqual({
      tossupsRead: 4,
      leftScore: 20,
      rightScore: 10,
    });
    const first = hook.result.current.state.live?.outbox.at(-1);
    expect(first?.kind).toBe('sections');
    expect((first?.payload as { sections: { liveGames: unknown[] } }).sections.liveGames).toEqual([
      expect.objectContaining({
        gameId: 'game-1',
        tossupsRead: 4,
        scores: [
          { teamId: 'team-left', score: 20 },
          { teamId: 'team-right', score: 10 },
        ],
      }),
    ]);

    invoke.mockImplementation(async () =>
      nativeSnapshot({
        sequence: 2,
        matchState: {
          type: 'Match',
          tossups_read: 5,
          match_teams: [{ points: 25 }, { points: 12 }],
        },
      }),
    );
    await act(async () => hook.result.current.syncQbtcp());
    const sections = hook.result.current.state.live?.outbox.filter((item) => item.kind === 'sections');
    expect(sections).toHaveLength(1);
    expect((sections?.[0]?.payload as { sections: { liveGames: unknown[] } }).sections.liveGames).toEqual([
      expect.objectContaining({ tossupsRead: 5, scores: expect.any(Array) }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('QBTCP progress respects Live visibility settings and does not enqueue hidden data', async () => {
    const repository = new MemoryDirectorRepository();
    await repository.save(tournamentState('tournament-privacy'));
    const hook = await loadedController(repository);
    await act(async () => {
      await hook.result.current.live.enable(
        { kind: 'custom', origin: 'https://live.example.test' },
        'setup-token',
      );
    });
    act(() => hook.result.current.live.updateSettings({ liveGameStatus: false }));
    const invoke = vi.fn(async () =>
      nativeSnapshot({
        sequence: 1,
        matchState: {
          type: 'Match',
          tossups_read: 7,
          match_teams: [{ points: 40 }, { points: 30 }],
        },
      }),
    );
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
    const before = hook.result.current.state.live?.outbox.length ?? 0;
    await act(async () => hook.result.current.syncQbtcp());
    expect(hook.result.current.state.qbtcpSessions[0]?.progress?.tossupsRead).toBe(7);
    expect(hook.result.current.state.live?.outbox.length).toBe(before);
    const latest = hook.result.current.state.live?.outbox.at(-1);
    const payload = latest?.payload as {
      snapshot?: { liveGames?: unknown[] };
      sections?: { liveGames?: unknown[] };
    };
    expect(payload.snapshot?.liveGames ?? payload.sections?.liveGames).toEqual([]);
  });

  test('remote setup crossing A to B rolls back the claim and never attaches to B', async () => {
    const repository = new MemoryDirectorRepository();
    await repository.save(tournamentState('tournament-a'));
    await repository.saveDocument!(tournamentState('tournament-b'), false);
    const hook = await loadedController(repository);
    let resolveClaim!: (value: { origin: string; managementToken: string }) => void;
    let resolveStore!: (value: { keychainService: string; keychainAccount: string }) => void;
    credentialMocks.claim.mockImplementationOnce(() => new Promise((resolve) => (resolveClaim = resolve)));
    credentialMocks.store.mockImplementationOnce(() => new Promise((resolve) => (resolveStore = resolve)));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse()),
    );

    const setup = hook.result.current.live.enable(
      { kind: 'custom', origin: 'https://live.example.test' },
      'setup-token',
    );
    await waitFor(() => expect(credentialMocks.claim).toHaveBeenCalled());
    resolveClaim({ origin: 'https://live.example.test', managementToken: 'token-a' });
    await waitFor(() => expect(credentialMocks.store).toHaveBeenCalled());
    await act(async () => expect(await hook.result.current.switchTournament('tournament-b')).toBe(true));
    resolveStore({ keychainService: 'QBSheet', keychainAccount: 'test-a' });
    await expect(setup).rejects.toThrow(/initiating tournament changed/i);
    expect(hook.result.current.state.tournament?.id).toBe('tournament-b');
    expect(hook.result.current.state.live).toBeNull();
    expect(credentialMocks.forget).toHaveBeenCalledWith(expect.any(String));
  });

  test('writer loss makes setup reject after remote claim and cleans up the uncommitted publication', async () => {
    const repository = new MemoryDirectorRepository();
    await repository.save(tournamentState('tournament-writer-loss'));
    const hook = await loadedController(repository);
    let resolveStore!: (value: { keychainService: string; keychainAccount: string }) => void;
    credentialMocks.store.mockImplementationOnce(() => new Promise((resolve) => (resolveStore = resolve)));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse()),
    );
    const setup = hook.result.current.live.enable(
      { kind: 'custom', origin: 'https://live.example.test' },
      'setup-token',
    );
    await waitFor(() => expect(credentialMocks.store).toHaveBeenCalled());
    writerMocks.lost?.abort();
    resolveStore({ keychainService: 'QBSheet', keychainAccount: 'writer-loss' });
    await expect(setup).rejects.toThrow(/could not be committed/i);
    expect(hook.result.current.state.live).toBeNull();
    expect(credentialMocks.forget).toHaveBeenCalledWith(expect.any(String));
  });

  test('failed remote cleanup is surfaced and retried before a second setup claim', async () => {
    const repository = new MemoryDirectorRepository();
    await repository.save(tournamentState('tournament-cleanup'));
    await repository.saveDocument!(tournamentState('tournament-target'), false);
    const hook = await loadedController(repository);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new Error('cleanup backend offline')).mockResolvedValue(okResponse()),
    );
    let resolveStore!: (value: { keychainService: string; keychainAccount: string }) => void;
    credentialMocks.store.mockImplementationOnce(() => new Promise((resolve) => (resolveStore = resolve)));
    const setup = hook.result.current.live.enable(
      { kind: 'custom', origin: 'https://live.example.test' },
      'setup-token',
    );
    await waitFor(() => expect(credentialMocks.store).toHaveBeenCalled());
    await act(async () => expect(await hook.result.current.switchTournament('tournament-target')).toBe(true));
    resolveStore({ keychainService: 'QBSheet', keychainAccount: 'orphan' });
    await expect(setup).rejects.toThrow(/cleanup failed/i);
    expect(credentialMocks.forget).not.toHaveBeenCalled();

    credentialMocks.read.mockResolvedValue('retained-token');
    await waitFor(() => expect(hook.result.current.writerStatus).toBe('held'));
    await act(async () => {
      await hook.result.current.live.enable(
        { kind: 'custom', origin: 'https://live.example.test' },
        'new-setup-token',
      );
    });
    expect(credentialMocks.claim).toHaveBeenCalledTimes(2);
    expect(credentialMocks.forget).toHaveBeenCalledWith(expect.any(String));
    expect(hook.result.current.state.live?.lifecycle).toBe('live');
  });

  test('local setup crossing a document transition stops and clears only its own runtime', async () => {
    const repository = new MemoryDirectorRepository();
    await repository.save(tournamentState('tournament-local-a'));
    await repository.saveDocument!(tournamentState('tournament-local-b'), false);
    const hook = await loadedController(repository);
    let resolveStart!: (value: { running: boolean; address: string; port: number }) => void;
    localMocks.start.mockImplementationOnce(() => new Promise((resolve) => (resolveStart = resolve)));
    localMocks.status.mockResolvedValueOnce({ running: false, address: '127.0.0.1', port: 8790 });
    const setup = hook.result.current.live.enable({ kind: 'local', origin: '' }, null);
    await waitFor(() => expect(localMocks.start).toHaveBeenCalled());
    await act(async () =>
      expect(await hook.result.current.switchTournament('tournament-local-b')).toBe(true),
    );
    resolveStart({ running: true, address: '127.0.0.1', port: 8790 });
    await expect(setup).rejects.toThrow(/initiating tournament changed/i);
    expect(localMocks.clear).toHaveBeenCalledWith(false);
    expect(localMocks.stop).toHaveBeenCalled();
    expect(hook.result.current.state.tournament?.id).toBe('tournament-local-b');
    expect(hook.result.current.state.live).toBeNull();
  });

  test('successful setup commits the publication before the caller can observe success', async () => {
    const repository = new MemoryDirectorRepository();
    await repository.save(tournamentState('tournament-success'));
    const hook = await loadedController(repository);
    await act(async () => {
      await hook.result.current.live.enable(
        { kind: 'custom', origin: 'https://live.example.test' },
        'setup-token',
      );
    });
    expect(hook.result.current.state.live).toMatchObject({
      lifecycle: 'live',
      settings: { ...defaultLivePublicationSettings(), enabled: true },
      credential: { keychainAccount: 'test' },
    });
    expect(hook.result.current.state.live?.outbox[0]?.kind).toBe('snapshot');
    await waitFor(() => expect(hook.result.current.canLeaveCurrentDocument().ok).toBe(true));
    expect((await repository.load()).live?.publicationId).toBe(hook.result.current.state.live?.publicationId);
  });
});
