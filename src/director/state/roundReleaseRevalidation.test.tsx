/**
 * Round-release revalidation across the native QBTCP preflight await (#785).
 *
 * `nativeQbtcpRoundBlocker(...)` awaits external process state: a real
 * interleaving point for concurrent Director mutations. These tests hold that
 * await open with deferred native responses, mutate the tournament, then
 * resolve the preflight and prove the release boundary re-proves every
 * invariant against the post-await state instead of authorizing a stale
 * snapshot.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DirectorState } from '../domain';
import { MemoryDirectorRepository } from '../persistence';
import { roundReleaseBlocker, useDirectorController } from './useDirectorController';
import { scheduledGame, team, tournamentState } from '../../../tests/directorFixtures';

const gates = vi.hoisted(() => ({
  status: null as Promise<unknown> | null,
  resolveStatus: null as ((value: unknown) => void) | null,
  snapshot: null as Promise<unknown> | null,
  resolveSnapshot: null as ((value: unknown) => void) | null,
  statusCalls: 0,
}));

vi.mock('../platform/native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/native')>();
  return {
    ...actual,
    isNativeDirector: () => true,
    readNativeServerStatus: () => {
      gates.statusCalls += 1;
      return gates.status ?? actual.readNativeServerStatus();
    },
    readNativeServerSnapshot: () => gates.snapshot ?? actual.readNativeServerSnapshot(),
  };
});

function armPreflight() {
  let resolveStatus!: (value: unknown) => void;
  let resolveSnapshot!: (value: unknown) => void;
  gates.status = new Promise<unknown>((resolve) => {
    resolveStatus = resolve;
  });
  gates.snapshot = new Promise<unknown>((resolve) => {
    resolveSnapshot = resolve;
  });
  gates.resolveStatus = resolveStatus;
  gates.resolveSnapshot = resolveSnapshot;
}

function resolvePreflightHealthy() {
  gates.resolveStatus!({ running: true });
  gates.resolveSnapshot!({
    status: 'ok',
    snapshot: { tournamentId: 'tournament-1', results: [], progress: [], presence: [] },
  });
}

afterEach(() => {
  gates.status = null;
  gates.resolveStatus = null;
  gates.snapshot = null;
  gates.resolveSnapshot = null;
  gates.statusCalls = 0;
  vi.clearAllMocks();
});

function room(id: string, name: string): DirectorState['rooms'][number] {
  return { id, name, available: true, status: 'available' } as DirectorState['rooms'][number];
}

/** A prepared QBTCP round with one valid room-assigned game. */
function qbtcpRoundState(): DirectorState {
  const state = tournamentState();
  state.teams.push(team('team-a', 'Aiken'), team('team-b', 'Dorman'));
  state.rooms.push(room('room-101', 'Room 101'));
  state.formats.push({
    id: 'format-1',
    name: 'Custom',
    kind: 'custom',
    phaseIds: ['phase-1'],
    roundsPerTeam: null,
  } as DirectorState['formats'][number]);
  state.phases.find((phase) => phase.id === 'phase-1')!.roundIds.push('round-2');
  state.rounds.push({
    id: 'round-2',
    phaseId: 'phase-1',
    name: 'Round 2',
    number: 2,
    revision: 1,
    status: 'prepared',
    packetId: null,
    deliveryMode: 'qbtcp',
    scheduledGameIds: ['game-201'],
    scheduledStart: null,
    releasedAt: null,
    startedAt: null,
    closedAt: null,
  });
  state.scheduledGames.push(
    scheduledGame('game-201', 'team-a', 'team-b', {
      roundId: 'round-2',
      roomId: 'room-101',
      status: 'scheduled',
    }),
  );
  return state;
}

async function renderWithState(state: DirectorState) {
  const repository = new MemoryDirectorRepository();
  await repository.save(state);
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return { hook, repository };
}

describe('release revalidation across native preflight (#785)', () => {
  test('a clean QBTCP release still succeeds', async () => {
    armPreflight();
    const { hook } = await renderWithState(qbtcpRoundState());
    let released: boolean | undefined;
    await act(async () => {
      const pending = Promise.resolve(hook.result.current.releaseRound('round-2'));
      resolvePreflightHealthy();
      released = await pending;
    });
    expect(released).toBe(true);
    expect(hook.result.current.state.rounds.find((entry) => entry.id === 'round-2')?.status).toBe('released');
    hook.unmount();
  });

  test('a room made unavailable mid-preflight refuses the release', async () => {
    armPreflight();
    const { hook } = await renderWithState(qbtcpRoundState());
    let released: boolean | undefined;
    await act(async () => {
      const pending = Promise.resolve(hook.result.current.releaseRound('round-2'));
      await Promise.resolve();
      expect(hook.result.current.updateRoom('room-101', { available: false })).toBe(true);
      resolvePreflightHealthy();
      released = await pending;
    });
    expect(released).toBe(false);
    expect(hook.result.current.state.rounds.find((entry) => entry.id === 'round-2')?.status).toBe('prepared');
    expect(hook.result.current.state.scheduledGames.find((game) => game.id === 'game-201')?.status).toBe(
      'scheduled',
    );
    hook.unmount();
  });

  test('a retired packet mid-preflight refuses the release', async () => {
    armPreflight();
    const state = qbtcpRoundState();
    state.packets.push({
      id: 'packet-1',
      name: 'Packet 1',
      source: 'manual',
      tiebreaker: false,
      assignedRoundIds: [],
      assignedGameIds: [],
      usedGameIds: [],
      replacementForPacketId: null,
    });
    const { hook } = await renderWithState(state);
    await act(async () => {
      expect(await hook.result.current.setRoundPacket('round-2', 'packet-1')).toBe(true);
    });
    let released: boolean | undefined;
    await act(async () => {
      const pending = Promise.resolve(hook.result.current.releaseRound('round-2'));
      await Promise.resolve();
      expect(hook.result.current.setPacketRetired('packet-1', true)).toBe(true);
      resolvePreflightHealthy();
      released = await pending;
    });
    expect(released).toBe(false);
    expect(hook.result.current.state.rounds.find((entry) => entry.id === 'round-2')?.status).not.toBe(
      'released',
    );
    hook.unmount();
  });

  test('an unrelated metadata change does not block the release', async () => {
    armPreflight();
    const { hook } = await renderWithState(qbtcpRoundState());
    let released: boolean | undefined;
    await act(async () => {
      const pending = Promise.resolve(hook.result.current.releaseRound('round-2'));
      await Promise.resolve();
      expect(hook.result.current.addTeam({ displayName: 'Unrelated' })).toBe(true);
      resolvePreflightHealthy();
      released = await pending;
    });
    // Semantic revalidation, not a global lock: an unrelated addition is not
    // a reason to refuse an otherwise valid release.
    expect(released).toBe(true);
    hook.unmount();
  });

  test('startRound refuses when a room goes unavailable mid-preflight', async () => {
    armPreflight();
    const { hook } = await renderWithState(qbtcpRoundState());
    let result: Awaited<ReturnType<typeof hook.result.current.startRound>> | undefined;
    await act(async () => {
      const pending = hook.result.current.startRound('round-2');
      await Promise.resolve();
      expect(hook.result.current.updateRoom('room-101', { available: false })).toBe(true);
      resolvePreflightHealthy();
      result = await pending;
    });
    expect(result?.ok).toBe(false);
    expect(hook.result.current.state.rounds.find((entry) => entry.id === 'round-2')?.status).toBe('prepared');
    hook.unmount();
  });

  test('startRound refuses when a document transition starts mid-preflight', async () => {
    armPreflight();
    const { hook, repository } = await renderWithState(qbtcpRoundState());
    const outgoing = tournamentState();
    outgoing.tournament!.id = 'tournament-b';
    outgoing.tournament!.name = 'Tournament B';
    await repository.saveDocument!(outgoing, false);
    let result: Awaited<ReturnType<typeof hook.result.current.startRound>> | undefined;
    let switched: boolean | undefined;
    await act(async () => {
      const pending = hook.result.current.startRound('round-2');
      // Wait until the start parks inside the native preflight, then let the
      // checkpoint persistence settle so leaving the document is allowed and
      // the concurrent switch deterministically begins a transition.
      await waitFor(() => expect(gates.statusCalls).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const switching = hook.result.current.switchTournament('tournament-b');
      resolvePreflightHealthy();
      result = await pending;
      switched = await switching;
    });
    expect(switched).toBe(true);
    expect(result?.ok).toBe(false);
    expect(result?.reason).toMatch(/changed while QBTCP readiness was being checked/);
    hook.unmount();
  });
});

describe('roundReleaseBlocker branches (#785)', () => {
  test('a valid prepared round has no blocker', () => {
    expect(roundReleaseBlocker(qbtcpRoundState(), 'round-2')).toBeNull();
  });

  test('a missing round is reported', () => {
    // Matches releaseRound's long-standing wording for unknown rounds.
    expect(roundReleaseBlocker(qbtcpRoundState(), 'round-9')).toMatch(/Only a prepared round/);
  });

  test('a non-prepared round is reported, with a planned exception for startRound', () => {
    const state = qbtcpRoundState();
    state.rounds.find((entry) => entry.id === 'round-2')!.status = 'released';
    expect(roundReleaseBlocker(state, 'round-2')).toMatch(/Only a prepared round/);
    state.rounds.find((entry) => entry.id === 'round-2')!.status = 'planned';
    expect(roundReleaseBlocker(state, 'round-2', ['planned', 'prepared'])).toBeNull();
  });

  test('an unresolved earlier round blocks the release', () => {
    const state = qbtcpRoundState();
    state.scheduledGames.push(
      scheduledGame('game-101', 'team-a', 'team-b', {
        roundId: 'round-1',
        roomId: 'room-101',
        status: 'scheduled',
      }),
    );
    expect(roundReleaseBlocker(state, 'round-2')).toMatch(/Round 1 still has unresolved play/);
  });

  test('duplicate room use is reported', () => {
    const state = qbtcpRoundState();
    state.teams.push(team('team-c', 'Carson'), team('team-d', 'Dover'));
    state.scheduledGames.push(
      scheduledGame('game-202', 'team-c', 'team-d', {
        roundId: 'round-2',
        roomId: 'room-101',
        status: 'scheduled',
      }),
    );
    state.rounds.find((entry) => entry.id === 'round-2')!.scheduledGameIds.push('game-202');
    expect(roundReleaseBlocker(state, 'round-2')).toMatch(/hosts 2 games/);
  });

  test('a retired packet on a game is reported', () => {
    const state = qbtcpRoundState();
    state.packets.push({
      id: 'packet-1',
      name: 'Packet 1',
      source: 'manual',
      tiebreaker: false,
      assignedRoundIds: [],
      assignedGameIds: [],
      usedGameIds: [],
      replacementForPacketId: null,
      retired: true,
    });
    state.scheduledGames.find((game) => game.id === 'game-201')!.packetId = 'packet-1';
    expect(roundReleaseBlocker(state, 'round-2')).toMatch(/retired packet/);
  });
});
