import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DirectorState } from '../domain';
import type { DirectorRepository } from '../persistence';
import { useDirectorController } from '../state/useDirectorController';
import { assignmentFor, directorFixture, scoreAssignment } from '../transfers/testFixtures';
import type { NativeRoomPairingInvitation } from '../platform/native';
import type { RelayConfig } from './relayConfig';
import { buildDirectorRelayMirror, runRelaySyncCycle } from './relayRuntime';
import type { RelaySyncResult } from './relaySync';

const relayTournamentId = 'bcdfghjkmnpqrstvwxyz1234';
const config: RelayConfig = {
  enabled: true,
  baseUrl: 'https://relay.example',
  tournamentId: relayTournamentId,
  directorTournamentId: 'tournament-fixture',
  keychainAccount: relayTournamentId,
  customDomain: true,
  claimedAt: '2026-09-10T12:00:00Z',
  lastContactAt: '2026-09-10T12:00:00Z',
};

function invitations(count: number): NativeRoomPairingInvitation[] {
  return Array.from({ length: count }, (_, index) => ({
    roomId: `room-${101 + index}`,
    roomName: `Room ${101 + index}`,
    pairingCode: `1000000${index}`,
    pairingUrl: `http://192.168.1.20:3000/#room-${101 + index}`,
    issuedAt: '2026-09-10T12:00:00Z',
    expiresAt: '2026-09-10T13:00:00Z',
    expiresInSeconds: 3600,
  }));
}

function relayResult(state: DirectorState, index: number): RelaySyncResult {
  const gameId = `game-5-${index + 1}`;
  return {
    resultId: `relay-result-${index + 1}`,
    sessionId: `relay-session-${index + 1}`,
    roomId: `room-${101 + index}`,
    matchId: gameId,
    fingerprint: `fingerprint-${index + 1}`,
    retryKey: `retry-${index + 1}`,
    qbj: scoreAssignment(assignmentFor(state, gameId).document),
    receivedAt: '2026-09-10T12:30:00Z',
  };
}

describe('Director relay runtime (#852)', () => {
  it('builds six current assignments with hashed pairing codes and no plaintext codes', async () => {
    const state = directorFixture({ games: 6 });
    const built = await buildDirectorRelayMirror(
      state,
      invitations(6),
      2,
      Date.parse('2026-09-10T12:05:00Z'),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const rooms = built.document.rooms as Array<Record<string, unknown>>;
    expect(rooms).toHaveLength(6);
    expect(rooms.map((room) => room.match_id)).toEqual(
      Array.from({ length: 6 }, (_, index) => `game-5-${index + 1}`),
    );
    expect(rooms.every((room) => /^[0-9a-f]{64}$/.test(String(room.pairing_code_hash)))).toBe(true);
    const serialized = JSON.stringify(built.document);
    for (const invitation of invitations(6)) expect(serialized).not.toContain(invitation.pairingCode);
  });

  it('keeps the remaining room assignments mirrorable after one game is accepted', async () => {
    const state = directorFixture({ games: 6 });
    state.scheduledGames.find((game) => game.id === 'game-5-1')!.status = 'accepted';
    const built = await buildDirectorRelayMirror(state, invitations(6), 3);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const rooms = built.document.rooms as Array<Record<string, unknown>>;
    expect(rooms.find((room) => room.room_id === 'room-101')).not.toHaveProperty('assignment_qbj');
    expect(rooms.filter((room) => room.assignment_qbj)).toHaveLength(5);
  });

  it('drains six near-simultaneous finals and acknowledges only the durably reported ids', async () => {
    const state = directorFixture({ games: 6 });
    const results = Array.from({ length: 6 }, (_, index) => relayResult(state, index));
    const acknowledged: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health'))
        return Response.json({ protocolVersion: 1, relayRevision: 20, mirror: { revision: 1 } });
      if (url.endsWith('/mirror') && init?.method === 'PUT') return Response.json({ relay_revision: 21 });
      if (url.includes('/results'))
        return Response.json({ revision: 21, results: results.map(toWireResult) });
      if (url.includes('/help')) return Response.json({ revision: 21, help: [] });
      if (url.endsWith('/sessions')) return Response.json({ revision: 21, sessions: [] });
      if (url.endsWith('/acks')) {
        acknowledged.push(JSON.parse(String(init?.body)));
        return Response.json({ acked_results: 6, acked_help: 0 });
      }
      throw new Error(`Unexpected relay request: ${url}`);
    }) as unknown as typeof fetch;
    const ingestRelayItems = vi.fn(async () => ({
      durable: true,
      resultIds: results.map((result) => result.resultId),
      helpIds: [],
      resultsAdded: 6,
      helpAdded: 0,
    }));

    const cycle = await runRelaySyncCycle({
      config,
      managementToken: 'management-token',
      state,
      invitations: invitations(6),
      ingestor: { ingestRelayItems },
      previousMirrorDigest: null,
      fetchImpl,
    });
    expect(cycle.ingest.resultsAdded).toBe(6);
    expect(acknowledged).toEqual([{ results: results.map((result) => result.resultId), help: [] }]);
  });

  it('does not acknowledge a final when Director persistence fails', async () => {
    const state = directorFixture({ games: 1 });
    const repository = new MemoryRepository(state);
    const hook = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    repository.failNext = true;
    let summary;
    await act(async () => {
      summary = await hook.result.current.ingestRelayItems({
        tournamentId: state.tournament!.id,
        results: [relayResult(state, 0)],
        help: [],
        sessions: [],
      });
    });
    expect(summary).toMatchObject({ durable: false, resultIds: [] });
    expect(repository.stored.submissions).toHaveLength(0);
  });

  it('persists six finals canonically before making them acknowledgeable and deduplicates a replay', async () => {
    const state = directorFixture({ games: 6 });
    const repository = new MemoryRepository(state);
    const hook = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    const results = Array.from({ length: 6 }, (_, index) => relayResult(state, index));
    let first;
    await act(async () => {
      first = await hook.result.current.ingestRelayItems({
        tournamentId: state.tournament!.id,
        results,
        help: [],
        sessions: [],
      });
    });
    expect(first).toMatchObject({
      durable: true,
      resultIds: results.map((result) => result.resultId),
      resultsAdded: 6,
    });
    expect(repository.stored.submissions).toHaveLength(6);

    let replay;
    await act(async () => {
      replay = await hook.result.current.ingestRelayItems({
        tournamentId: state.tournament!.id,
        results,
        help: [],
        sessions: [],
      });
    });
    expect(replay).toMatchObject({ durable: true, resultsAdded: 0 });
    expect(repository.stored.submissions).toHaveLength(6);
  });
});

function toWireResult(result: RelaySyncResult): Record<string, unknown> {
  return {
    result_id: result.resultId,
    session_id: result.sessionId,
    room_id: result.roomId,
    match_id: result.matchId,
    fingerprint: result.fingerprint,
    retry_key: result.retryKey,
    qbj: result.qbj,
    received_at: result.receivedAt,
  };
}

class MemoryRepository implements DirectorRepository {
  readonly kind = 'memory' as const;
  stored: DirectorState;
  failNext = false;

  constructor(state: DirectorState) {
    this.stored = structuredClone(state);
  }

  async load(): Promise<DirectorState> {
    return structuredClone(this.stored);
  }

  async save(state: DirectorState): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated persistence failure');
    }
    this.stored = structuredClone(state);
  }

  async checkpoint(): Promise<void> {}
}
