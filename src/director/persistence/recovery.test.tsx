import { act, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  IndexedDbDirectorRepository,
  MemoryDirectorRepository,
  TauriDirectorRepository,
} from './DirectorRepository';
import { normalizeDirectorState } from './stateMigrations';
import { directorFixture } from '../transfers/testFixtures';
import { useDirectorController } from '../state/useDirectorController';
import { removeRoundFlexibly } from '../state/flexibleEditing';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

for (const backend of ['memory', 'indexeddb', 'localStorage'] as const) {
  describe(`${backend} recovery`, () => {
    test('snapshot, mutation, restore, undo-restore, and tournament isolation', async () => {
      vi.stubGlobal('indexedDB', backend === 'indexeddb' ? new IDBFactory() : undefined);
      const repository =
        backend === 'memory' ? new MemoryDirectorRepository() : new IndexedDbDirectorRepository();
      const before = normalizeDirectorState(directorFixture());
      await repository.checkpoint(before, 'Before the morning');
      const [point] = await repository.listCheckpoints(before.tournament!.id);
      expect(point).toMatchObject({
        reason: 'Before the morning',
        tournamentId: before.tournament!.id,
        schemaVersion: before.schemaVersion,
      });
      expect(await repository.readCheckpoint(before.tournament!.id, point.id)).toEqual(before);
      const changed = structuredClone(before);
      changed.teams[0].displayName = 'Destructive mistake';
      changed.rounds = [];
      await repository.save(changed);
      const other = structuredClone(before);
      other.tournament!.id = 'another-tournament';
      await repository.checkpoint(other, 'Other event');
      expect(await repository.listCheckpoints(other.tournament!.id)).toHaveLength(1);
      await expect(repository.restoreCheckpoint(other, point.id)).rejects.toThrow(/open tournament/);
      await repository.save(changed);
      expect(await repository.restoreCheckpoint(changed, point.id)).toEqual(before);
      expect(await repository.load()).toEqual(before);
      const points = await repository.listCheckpoints(before.tournament!.id);
      expect(points).toHaveLength(2);
      const undo = points.find((entry) => entry.id !== point.id)!;
      expect(undo.reason).toMatch(/Before restoring checkpoint from/);
      expect(await repository.readCheckpoint(before.tournament!.id, undo.id)).toEqual(changed);
      expect(await repository.restoreCheckpoint(before, undo.id)).toEqual(changed);
      if (backend !== 'memory') {
        const reopened = new IndexedDbDirectorRepository();
        expect(await reopened.listCheckpoints(before.tournament!.id)).toHaveLength(3);
        expect(await reopened.readCheckpoint(before.tournament!.id, point.id)).toEqual(before);
        expect((await reopened.load()).teams[0].displayName).toBe('Destructive mistake');
      }
    });
  });
}

test('IndexedDB v2 upgrades without changing existing tournament documents', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const before = normalizeDirectorState(directorFixture());
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('qbsheet-director', 2);
    open.onupgradeneeded = () => {
      open.result
        .createObjectStore('tournament-documents', { keyPath: 'id' })
        .put({ id: before.tournament!.id, state: before });
      open.result
        .createObjectStore('app-metadata', { keyPath: 'key' })
        .put({ key: 'current-tournament-id', value: before.tournament!.id });
    };
    open.onsuccess = () => {
      open.result.close();
      resolve();
    };
    open.onerror = () => reject(open.error);
  });
  const repository = new IndexedDbDirectorRepository();
  expect(await repository.load()).toEqual(before);
  expect(await repository.listCheckpoints(before.tournament!.id)).toEqual([]);
  await repository.checkpoint(before, 'After upgrade');
  expect(await repository.listCheckpoints(before.tournament!.id)).toHaveLength(1);
});

test('controller restores exact document and preserves the state before destructive round removal', async () => {
  const repository = new MemoryDirectorRepository();
  await repository.save(normalizeDirectorState(directorFixture()));
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  const before = structuredClone(hook.result.current.state);
  await act(async () => {
    expect(await removeRoundFlexibly(hook.result.current, before.rounds[0].id)).toBe(true);
  });
  expect(hook.result.current.state.rounds).toHaveLength(before.rounds.length - 1);
  expect(hook.result.current.state.tournament!.id).toBe(before.tournament!.id);
  const removed = structuredClone(hook.result.current.state);
  const point = hook.result.current.checkpoints[0];
  await act(async () => {
    expect(await hook.result.current.restoreCheckpoint(point.id)).toBe(true);
  });
  expect(hook.result.current.state).toEqual(before);
  expect(
    await repository.readCheckpoint(before.tournament!.id, hook.result.current.checkpoints[0].id),
  ).toEqual(removed);
  expect(hook.result.current.documentEpoch).toBe(2);
});

test('a failed safety checkpoint prevents a destructive edit', async () => {
  const repository = new MemoryDirectorRepository();
  await repository.save(directorFixture());
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  const before = structuredClone(hook.result.current.state);
  vi.spyOn(repository, 'checkpoint').mockRejectedValueOnce(new Error('Disk full'));
  await act(async () => {
    expect(await removeRoundFlexibly(hook.result.current, before.rounds[0].id)).toBe(false);
  });
  expect(hook.result.current.state).toEqual(before);
  expect(hook.result.current.error).toBe('Disk full');
});

test('native adapter refuses a future checkpoint before invoking restore', async () => {
  const before = directorFixture();
  const invoke = vi.fn(async (_command: string) => ({ ...before, schemaVersion: 999 }));
  const repository = new TauriDirectorRepository({ invoke });
  await expect(repository.restoreCheckpoint(before, 'future')).rejects.toThrow(/newest supported/);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0][0]).toBe('director_read_checkpoint');
});

test('restoring an enabled publication queues a full snapshot above the current revision', async () => {
  const { emptyLivePublication } = await import('../domain');
  const { derivePublication } = await import('../live/publication');
  const repository = new MemoryDirectorRepository();
  const before = normalizeDirectorState(directorFixture());
  before.live = emptyLivePublication('bcdfghjkmnpqrstvwxyz', '2026-09-05T12:00:00.000Z');
  before.live.lifecycle = 'live';
  before.live.settings.enabled = true;
  before.live.backend = { kind: 'cloudflare', origin: 'https://backend.example' };
  before.live = derivePublication(before, null).live;
  await repository.checkpoint(before, 'Before scoring');
  const [point] = await repository.listCheckpoints(before.tournament!.id);
  const changed = structuredClone(before);
  changed.teams[0].displayName = 'After scoring';
  changed.live!.sync.localRevision = 100;
  changed.live!.sync.acknowledgedRevision = 99;
  await repository.save(changed);
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    expect(await hook.result.current.restoreCheckpoint(point.id)).toBe(true);
  });
  expect(hook.result.current.state.teams).toEqual(before.teams);
  expect(hook.result.current.state.live!.sync.localRevision).toBe(101);
  expect(hook.result.current.state.live!.outbox).toHaveLength(1);
  expect(hook.result.current.state.live!.outbox[0]).toMatchObject({
    kind: 'snapshot',
    revision: 101,
    state: 'pending',
  });
  hook.unmount();
});
