import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { DirectorState } from '../src/director/domain';
import { MemoryDirectorRepository } from '../src/director/persistence';
import { claimDirectorWriter } from '../src/director/persistence/DirectorWriterClaim';
import { useDirectorController } from '../src/director/state/useDirectorController';

class FailingMemoryRepository extends MemoryDirectorRepository {
  fail = false;

  override async save(state: Parameters<MemoryDirectorRepository['save']>[0]): Promise<void> {
    if (this.fail) throw new Error('disk full');
    await super.save(state);
  }
}

class OrderedMemoryRepository extends MemoryDirectorRepository {
  private blockNext = false;
  private startedResolve: (() => void) | null = null;
  private releaseResolve: (() => void) | null = null;
  failNext = false;

  blockNextSave(): { started: Promise<void>; release: () => void } {
    this.blockNext = true;
    const started = new Promise<void>((resolve) => {
      this.startedResolve = resolve;
    });
    return {
      started,
      release: () => this.releaseResolve?.(),
    };
  }

  override async save(state: Parameters<MemoryDirectorRepository['save']>[0]): Promise<void> {
    const wasBlocked = this.blockNext;
    if (wasBlocked) {
      this.blockNext = false;
      this.startedResolve?.();
      await new Promise<void>((resolve) => {
        this.releaseResolve = resolve;
      });
      this.startedResolve = null;
      this.releaseResolve = null;
    }
    // The test sets failNext while the first save is paused. Apply it to the following save,
    // which is the newer revision under test, rather than changing the paused call in flight.
    if (!wasBlocked && this.failNext) {
      this.failNext = false;
      throw new Error('newer save failed');
    }
    await super.save(state);
  }
}

async function createTournament(repository: MemoryDirectorRepository) {
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  act(() =>
    hook.result.current.createTournament({
      name: 'Durability test',
      date: '2026-09-04',
      venue: 'Test hall',
      organizer: 'QBSheet',
    }),
  );
  await waitFor(() => expect(hook.result.current.saving).toBe(false));
  return hook;
}

describe('Director persistence and browser writer reliability', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
  });

  test('keeps an in-memory mutation visibly unsaved until retry succeeds', async () => {
    const repository = new FailingMemoryRepository();
    const hook = await createTournament(repository);
    const durableBefore = await repository.load();
    repository.fail = true;

    act(() => expect(hook.result.current.updateTournament({ name: 'Unsaved tournament' })).toBe(true));
    await waitFor(() => expect(hook.result.current.persistence.status).toBe('failed'));
    expect(hook.result.current.state.tournament?.name).toBe('Unsaved tournament');
    expect((await repository.load()).tournament?.name).toBe(durableBefore.tournament?.name);
    expect(hook.result.current.error).toMatch(/disk full/i);
    expect(hook.result.current.persistence.durableRevision).toBeLessThan(
      hook.result.current.persistence.revision,
    );

    repository.fail = false;
    await act(async () => expect(await hook.result.current.retryPersistence()).toBe(true));
    await waitFor(() => expect(hook.result.current.persistence.status).toBe('saved'));
    expect((await repository.load()).tournament?.name).toBe('Unsaved tournament');
    hook.unmount();
  });

  test('a newer failed revision is not cleared by an older successful save', async () => {
    const repository = new OrderedMemoryRepository();
    const hook = await createTournament(repository);
    const deferred = repository.blockNextSave();

    act(() => expect(hook.result.current.updateTournament({ name: 'First revision' })).toBe(true));
    await deferred.started;
    repository.failNext = true;
    act(() => expect(hook.result.current.updateTournament({ name: 'Second revision' })).toBe(true));
    deferred.release();

    await waitFor(() => expect(hook.result.current.persistence.status).toBe('failed'));
    expect(hook.result.current.state.tournament?.name).toBe('Second revision');
    expect(hook.result.current.persistence.durableRevision).toBeLessThan(
      hook.result.current.persistence.revision,
    );
    hook.unmount();
  });

  test('two browser Director instances converge on one writer and block the other', async () => {
    const repository = new MemoryDirectorRepository();
    const first = await createTournament(repository);
    const second = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    await waitFor(() => {
      expect([first.result.current.writerStatus, second.result.current.writerStatus].sort()).toEqual([
        'blocked',
        'held',
      ]);
    });

    const blocked = first.result.current.writerStatus === 'blocked' ? first : second;
    const before = await repository.load();
    act(() => expect(blocked.result.current.updateTournament({ name: 'Blocked write' })).toBe(false));
    expect(blocked.result.current.error).toMatch(/another Director tab|read-only/i);
    expect(await repository.load()).toEqual(before);
    first.unmount();
    second.unmount();
  });

  test('a queued write cannot run after its Director writer claim is lost', async () => {
    const repository = new OrderedMemoryRepository();
    const first = await createTournament(repository);
    const gate = repository.blockNextSave();

    act(() => expect(first.result.current.updateTournament({ name: 'First revision' })).toBe(true));
    await gate.started;
    act(() => expect(first.result.current.updateTournament({ name: 'Stale second revision' })).toBe(true));

    first.unmount();
    const second = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    await waitFor(() => expect(second.result.current.writerStatus).toBe('held'));

    gate.release();
    await waitFor(async () => {
      expect((await repository.load()).tournament?.name).toBe('First revision');
    });
    expect((await repository.load()).tournament?.name).not.toBe('Stale second revision');
    second.unmount();
  });

  test('importing a document cannot write until its new document claim is held', async () => {
    const repository = new MemoryDirectorRepository();
    const hook = await createTournament(repository);
    const archive = JSON.parse(hook.result.current.exportSnapshot()) as DirectorState;
    archive.tournament!.id = 'import-target';
    const holder = await claimDirectorWriter({
      tournamentId: 'import-target',
      documentId: 'import-target',
      tabId: 'target-holder',
      locks: null,
      responseTimeoutMs: 15,
      heartbeatMs: 30,
    });
    try {
      act(() => expect(hook.result.current.importSnapshot(archive)).toBe(true));
      await waitFor(() => expect(hook.result.current.persistence.status).toBe('failed'));
      expect((await repository.load()).tournament?.id).not.toBe('import-target');
      expect(hook.result.current.writerStatus).toBe('blocked');
    } finally {
      holder.release();
      hook.unmount();
    }
  });
});
