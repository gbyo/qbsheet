/**
 * Native close-guard integration for #731, against a testable close-request
 * abstraction (no Tauri event loop needed).
 *
 * Each case drives `useCloseGuard` with a stub controller and proves the
 * shell contract: durable closes proceed immediately, delayed healthy saves
 * hold the close then proceed, failures keep the app open with recovery
 * state, retries re-run the close, mid-flush mutations are waited for, and
 * duplicate close clicks never fork duplicate flushes.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  registerCloseGuardRequest,
  registerClosePerformer,
  getCloseGuardRequest,
} from '../platform/closeGuard';
import { useCloseGuard, type CloseGuardController } from './useCloseGuard';

function stubController(overrides: Partial<CloseGuardController> = {}): CloseGuardController {
  return {
    canLeaveCurrentDocument: () => ({ ok: true }),
    prepareForClose: async () => ({ status: 'safe' }),
    retryPersistence: async () => true,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  registerCloseGuardRequest(null);
  registerClosePerformer(null);
});

describe('useCloseGuard (#731)', () => {
  test('a durable document closes immediately with no prompt state', async () => {
    const prepareForClose = vi.fn(async () => ({ status: 'safe' as const }));
    const hook = renderHook(() => useCloseGuard(stubController({ prepareForClose })));

    let result: unknown;
    await act(async () => {
      result = await hook.result.current.requestClose();
    });

    expect(result).toBe(true);
    expect(prepareForClose).toHaveBeenCalledTimes(1);
    expect(hook.result.current.phase).toBe('idle');
    expect(hook.result.current.blockedCheck).toBeNull();
  });

  test('a delayed healthy save holds the close, then proceeds', async () => {
    const flush = deferred<{ status: 'safe' }>();
    const controller = stubController({ prepareForClose: () => flush.promise });
    const hook = renderHook(() => useCloseGuard(controller));

    let result: unknown;
    act(() => {
      void hook.result.current.requestClose().then((value) => {
        result = value;
      });
    });
    expect(hook.result.current.phase).toBe('flushing');

    await act(async () => {
      flush.resolve({ status: 'safe' });
      await flush.promise;
    });
    expect(result).toBe(true);
    expect(hook.result.current.phase).toBe('idle');
  });

  test('a failed save keeps the app open with recovery state', async () => {
    const blocked = {
      status: 'blocked' as const,
      revision: 4,
      durableRevision: 2,
      error: 'simulated storage failure',
    };
    const hook = renderHook(() => useCloseGuard(stubController({ prepareForClose: async () => blocked })));

    let result: unknown;
    await act(async () => {
      result = await hook.result.current.requestClose();
    });

    expect(result).toBe(false);
    expect(hook.result.current.phase).toBe('blocked');
    expect(hook.result.current.blockedCheck).toEqual(blocked);
  });

  test('retry after failure can proceed once the save succeeds', async () => {
    let attempt = 0;
    const controller = stubController({
      prepareForClose: async () => {
        attempt += 1;
        return attempt === 1
          ? { status: 'blocked' as const, revision: 3, durableRevision: 2, error: 'disk gone' }
          : { status: 'safe' as const };
      },
    });
    const hook = renderHook(() => useCloseGuard(controller));

    await act(async () => {
      await expect(hook.result.current.requestClose()).resolves.toBe(false);
    });
    expect(hook.result.current.phase).toBe('blocked');

    await act(async () => {
      await expect(hook.result.current.retryClose()).resolves.toBe(true);
    });
    expect(hook.result.current.phase).toBe('idle');
    expect(hook.result.current.blockedCheck).toBeNull();
  });

  test('a mutation landing in the exit gap loops back into the flush', async () => {
    const prepareForClose = vi.fn(async () => ({ status: 'safe' as const }));
    let leaveCalls = 0;
    const controller = stubController({
      prepareForClose,
      canLeaveCurrentDocument: () => {
        leaveCalls += 1;
        // First exit-gap check sees a brand-new memory-only revision.
        return leaveCalls === 1
          ? { ok: false, reason: 'unsaved' as const, revision: 6, durableRevision: 5, error: null }
          : { ok: true };
      },
    });
    const hook = renderHook(() => useCloseGuard(controller));

    let result: unknown;
    await act(async () => {
      result = await hook.result.current.requestClose();
    });

    expect(result).toBe(true);
    expect(prepareForClose).toHaveBeenCalledTimes(2);
    expect(hook.result.current.phase).toBe('idle');
  });

  test('repeated close clicks share one attempt, not duplicate flushes', async () => {
    const flush = deferred<{ status: 'safe' }>();
    const prepareForClose = vi.fn(() => flush.promise);
    const hook = renderHook(() => useCloseGuard(stubController({ prepareForClose })));

    let first: unknown;
    let second: unknown;
    act(() => {
      void hook.result.current.requestClose().then((value) => {
        first = value;
      });
      void hook.result.current.requestClose().then((value) => {
        second = value;
      });
    });
    expect(prepareForClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      flush.resolve({ status: 'safe' });
      await flush.promise;
    });
    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  test('cancelling a pending close keeps the app open', async () => {
    const flush = deferred<{ status: 'safe' }>();
    const hook = renderHook(() => useCloseGuard(stubController({ prepareForClose: () => flush.promise })));

    let result: unknown = 'pending';
    act(() => {
      void hook.result.current.requestClose().then((value) => {
        result = value;
      });
    });
    act(() => {
      hook.result.current.cancelClose();
    });
    expect(hook.result.current.phase).toBe('idle');

    await act(async () => {
      flush.resolve({ status: 'safe' });
      await flush.promise;
    });
    expect(result).toBe(false);
  });

  test('a guard error fails closed, never reporting safe', async () => {
    const hook = renderHook(() =>
      useCloseGuard(
        stubController({
          prepareForClose: () => Promise.reject(new Error('flush exploded')),
        }),
      ),
    );

    let result: unknown;
    await act(async () => {
      result = await hook.result.current.requestClose();
    });
    expect(result).toBe(false);
    expect(hook.result.current.phase).toBe('idle');
  });

  test('the shell reaches the guard through the registry, then it unregisters', () => {
    const hook = renderHook(() => useCloseGuard(stubController()));
    expect(getCloseGuardRequest()).toBe(hook.result.current.requestClose);
    hook.unmount();
    expect(getCloseGuardRequest()).toBeNull();
  });

  test('quit without saving reaches the native performer only', () => {
    const performer = vi.fn();
    registerClosePerformer(performer);
    const hook = renderHook(() => useCloseGuard(stubController()));
    expect(hook.result.current.canForceClose).toBe(true);

    act(() => {
      hook.result.current.quitWithoutSaving();
    });
    expect(performer).toHaveBeenCalledTimes(1);
  });

  test('no destructive quit is offered without a native performer', () => {
    const hook = renderHook(() => useCloseGuard(stubController()));
    expect(hook.result.current.canForceClose).toBe(false);
    expect(() => hook.result.current.quitWithoutSaving()).not.toThrow();
  });
});
