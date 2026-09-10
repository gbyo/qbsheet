/**
 * Process-exit durability for #731.
 *
 * Proves `prepareForClose()` flushes the canonical persistence queue and
 * judges the *current* revision counters: a delayed healthy save becomes
 * safe, a failed save stays blocked after the queue settles, a mutation
 * that lands mid-flush is waited for too, and concurrent close requests
 * share one flush. The final test replays the production sequence —
 * mutate, close immediately, reopen from the same repository — and proves
 * the mutation survives.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { DirectorState } from '../domain';
import type { DirectorController } from './useDirectorController';
import { useDirectorController } from './useDirectorController';
import type { DirectorRepository } from '../persistence/DirectorRepository';
import { tournamentState } from '../../../tests/directorFixtures';

type Hook = ReturnType<typeof renderHook<DirectorController, unknown>>;

interface SaveGate {
  promise: Promise<void>;
  release: () => void;
}

/** Repository double with a controllable, countable `save`. */
class GatedRepository implements DirectorRepository {
  readonly kind = 'memory' as const;
  stored: DirectorState;
  saves = 0;
  failures = 0;
  private gates: SaveGate[] = [];

  constructor(initial: DirectorState) {
    this.stored = structuredClone(initial);
  }

  async load(): Promise<DirectorState> {
    return structuredClone(this.stored);
  }

  /** The next `save` waits until the returned release is called. */
  holdNextSave(): () => void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gates.push({ promise, release });
    return release;
  }

  failNextSave(count = 1): void {
    this.failures += count;
  }

  async save(state: DirectorState): Promise<void> {
    this.saves += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('simulated storage failure');
    }
    const gate = this.gates.shift();
    if (gate) await gate.promise;
    this.stored = structuredClone(state);
  }

  async checkpoint(): Promise<void> {}
}

async function openController(repository: GatedRepository): Promise<Hook> {
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

async function renameTournament(hook: Hook, name: string): Promise<void> {
  await act(async () => {
    expect(hook.result.current.updateTournament({ name })).toBe(true);
  });
}

describe('prepareForClose (#731)', () => {
  test('a clean document is safe to close immediately', async () => {
    const repository = new GatedRepository(tournamentState());
    const hook = await openController(repository);
    expect(hook.result.current.canLeaveCurrentDocument()).toEqual({ ok: true });
    let readiness;
    await act(async () => {
      readiness = await hook.result.current.prepareForClose();
    });
    expect(readiness).toEqual({ status: 'safe' });
    expect(repository.saves).toBe(0);
  });

  test('a mutation is unsafe until its delayed save lands, then safe', async () => {
    const repository = new GatedRepository(tournamentState());
    const hook = await openController(repository);
    const release = repository.holdNextSave();
    await renameTournament(hook, 'Delayed Save Open');

    expect(hook.result.current.canLeaveCurrentDocument().ok).toBe(false);
    expect(hook.result.current.persistence.status).toBe('saving');

    let readiness: unknown;
    await act(async () => {
      const pending = hook.result.current.prepareForClose();
      // Still in flight while the save is held: no premature safe verdict.
      await Promise.resolve();
      expect(hook.result.current.canLeaveCurrentDocument().ok).toBe(false);
      release();
      readiness = await pending;
    });
    expect(readiness).toEqual({ status: 'safe' });
    expect(hook.result.current.canLeaveCurrentDocument()).toEqual({ ok: true });
  });

  test('a failed save stays blocked after the queue settles', async () => {
    const repository = new GatedRepository(tournamentState());
    const hook = await openController(repository);
    repository.failNextSave();
    await renameTournament(hook, 'Lost Write');
    await waitFor(() => expect(hook.result.current.persistence.status).toBe('failed'));

    // The queue Promise is settled, but the revision is still memory-only.
    const unsafe = hook.result.current.canLeaveCurrentDocument();
    expect(unsafe.ok).toBe(false);

    let readiness: unknown;
    await act(async () => {
      readiness = await hook.result.current.prepareForClose();
    });
    expect(readiness).toMatchObject({ status: 'blocked' });
    expect(readiness).toEqual({
      status: 'blocked',
      revision: expect.any(Number),
      durableRevision: expect.any(Number),
      error: expect.any(String),
    });
    if (
      readiness &&
      typeof readiness === 'object' &&
      'revision' in readiness &&
      'durableRevision' in readiness &&
      typeof readiness.revision === 'number' &&
      typeof readiness.durableRevision === 'number'
    ) {
      expect(readiness.durableRevision).toBeLessThan(readiness.revision);
    } else {
      expect.unreachable('blocked readiness carries revision counters');
    }
  });

  test('a mutation that lands mid-flush is waited for too', async () => {
    const repository = new GatedRepository(tournamentState());
    const hook = await openController(repository);
    const releaseFirst = repository.holdNextSave();
    await renameTournament(hook, 'Revision N');

    let readiness: unknown;
    await act(async () => {
      const pending = hook.result.current.prepareForClose();
      // Revision N+1 arrives while N is still saving; its save is held too.
      const releaseSecond = repository.holdNextSave();
      await act(async () => {
        expect(hook.result.current.updateTournament({ name: 'Revision N+1' })).toBe(true);
      });
      releaseFirst();
      // N is durable now, but the close must not resolve while N+1 is held.
      await Promise.resolve();
      releaseSecond();
      readiness = await pending;
    });

    expect(readiness).toEqual({ status: 'safe' });
    expect(hook.result.current.state.tournament?.name).toBe('Revision N+1');
    expect(hook.result.current.canLeaveCurrentDocument()).toEqual({ ok: true });
  });

  test('concurrent close requests share one flush', async () => {
    const repository = new GatedRepository(tournamentState());
    const hook = await openController(repository);
    const release = repository.holdNextSave();
    await renameTournament(hook, 'Shared Flush');
    const savesBefore = repository.saves;

    await act(async () => {
      const first = hook.result.current.prepareForClose();
      const second = hook.result.current.prepareForClose();
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toEqual({ status: 'safe' });
      expect(b).toEqual({ status: 'safe' });
    });
    // One mutation, one save: the duplicate close forked no extra flush.
    expect(repository.saves).toBe(savesBefore);
  });

  test('immediate close after a mutation survives reopen from the repository', async () => {
    const repository = new GatedRepository(tournamentState());
    const hook = await openController(repository);
    const release = repository.holdNextSave();
    await renameTournament(hook, 'Survives Restart');

    // The production sequence: close immediately, guarded shutdown flushes.
    await act(async () => {
      const pending = hook.result.current.prepareForClose();
      release();
      await expect(pending).resolves.toEqual({ status: 'safe' });
    });
    hook.unmount();

    // Reopen from the same durable repository: the exact mutation is present.
    const reopened = await openController(repository);
    expect(reopened.result.current.state.tournament?.name).toBe('Survives Restart');
    expect(reopened.result.current.canLeaveCurrentDocument()).toEqual({ ok: true });
    reopened.unmount();
  });
});
