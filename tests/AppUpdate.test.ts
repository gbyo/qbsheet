/**
 * The one property that matters: a new build never takes a game off the screen.
 *
 * These are sequence tests, because every way this can go wrong is an ordering. A worker that
 * installs while a bonus is being scored, a first install mistaken for an update, a reload fired
 * before the new worker has control, a scorekeeper who presses Update now in the half-second between
 * the last tossup and the submission — none of those is reachable from a single call, and none of them
 * is exercised by a real browser in a unit test.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  AppUpdateWatcher,
  IAppUpdateState,
  IContainerLike,
  IRegistrationLike,
  IWorkerLike,
  updateApplyTimeoutMs,
  updateCheckIntervalMs,
  updateReady,
} from '../src/pwa/AppUpdate';
import { updatesAllowedOn } from '../src/app/App';

/** A worker whose state a test can move, the way a browser would. */
class FakeWorker implements IWorkerLike {
  state = 'installing';

  readonly messages: unknown[] = [];

  private readonly listeners = new Set<() => void>();

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  addEventListener(_type: 'statechange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'statechange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  /** Finish installing, as a browser does once the precache has been written. */
  becomeInstalled(): void {
    this.state = 'installed';
    this.listeners.forEach((listener) => listener());
  }
}

class FakeRegistration implements IRegistrationLike {
  installing: FakeWorker | null = null;

  waiting: FakeWorker | null = null;

  updateCalls = 0;

  private readonly listeners = new Set<() => void>();

  update(): Promise<unknown> {
    this.updateCalls += 1;
    return Promise.resolve();
  }

  addEventListener(_type: 'updatefound', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'updatefound', listener: () => void): void {
    this.listeners.delete(listener);
  }

  /** A new build has started downloading. */
  findUpdate(worker: FakeWorker): void {
    this.installing = worker;
    this.listeners.forEach((listener) => listener());
  }

  /** The browser promotes a fully installed worker into `waiting`. */
  promoteToWaiting(): void {
    this.waiting = this.installing;
    this.installing = null;
  }
}

class FakeContainer implements IContainerLike {
  controller: unknown = null;

  private readonly listeners = new Set<() => void>();

  addEventListener(_type: 'controllerchange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'controllerchange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  /** The waiting worker took control. */
  changeController(): void {
    this.controller = { id: 'new' };
    this.listeners.forEach((listener) => listener());
  }
}

/** A device that already has a worker, a watcher attached, and a build waiting to replace it. */
function deviceWithWaitingBuild(reload = vi.fn()) {
  const registration = new FakeRegistration();
  const container = new FakeContainer();
  container.controller = { id: 'old' };
  const watcher = new AppUpdateWatcher({ reload });
  const states: IAppUpdateState[] = [];
  watcher.subscribe((state) => states.push(state));
  watcher.observe(registration, container);

  const incoming = new FakeWorker();
  registration.findUpdate(incoming);
  registration.promoteToWaiting();
  incoming.becomeInstalled();

  return { registration, container, watcher, incoming, reload, states };
}

describe('recognizing an update', () => {
  test('a first install on a device with no worker is not an update to offer', () => {
    const registration = new FakeRegistration();
    registration.waiting = new FakeWorker();

    // Nothing is controlling the page, so there is no running build to replace. Calling this an
    // update would put "Update now" in front of somebody who just opened the site for the first time.
    expect(updateReady(registration, false)).toBe(false);
  });

  test('a waiting worker on a controlled page is an update', () => {
    const registration = new FakeRegistration();
    registration.waiting = new FakeWorker();

    expect(updateReady(registration, true)).toBe(true);
  });

  test('a build still downloading is not offered', () => {
    const registration = new FakeRegistration();
    const container = new FakeContainer();
    container.controller = { id: 'old' };
    const watcher = new AppUpdateWatcher({ reload: vi.fn() });
    watcher.observe(registration, container);

    const incoming = new FakeWorker();
    registration.findUpdate(incoming);

    // `updatefound` has fired but the worker is still installing. A button now would reload into a
    // half-cached build.
    expect(watcher.snapshot().available).toBe(false);

    registration.promoteToWaiting();
    incoming.becomeInstalled();

    expect(watcher.snapshot().available).toBe(true);
  });

  test('subscribers hear about it once, not on every re-evaluation', () => {
    const { watcher, states } = deviceWithWaitingBuild();

    void watcher.checkNow();

    expect(states.filter((state) => state.available)).toHaveLength(1);
  });

  test('observing again detaches the old registration handlers', () => {
    const watcher = new AppUpdateWatcher({ reload: vi.fn() });
    const firstRegistration = new FakeRegistration();
    const firstContainer = new FakeContainer();
    firstContainer.controller = { id: 'old-1' };
    watcher.observe(firstRegistration, firstContainer);

    const secondRegistration = new FakeRegistration();
    const secondContainer = new FakeContainer();
    secondContainer.controller = { id: 'old-2' };
    watcher.observe(secondRegistration, secondContainer);

    const stale = new FakeWorker();
    firstRegistration.findUpdate(stale);
    firstRegistration.promoteToWaiting();
    stale.becomeInstalled();

    expect(watcher.snapshot().available).toBe(false);
    watcher.stop();
  });
});

describe('refusing to replace a running game', () => {
  test('apply does nothing while the application has not declared itself replaceable', () => {
    const { watcher, incoming, reload } = deviceWithWaitingBuild();

    // The default. A device that never got round to saying it was safe is a device that does not
    // update, which is the harmless direction to be wrong in.
    expect(watcher.apply()).toBe(false);
    expect(incoming.messages).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  test('apply is refused again once a game comes back on screen', () => {
    const { watcher, incoming } = deviceWithWaitingBuild();

    watcher.setReplaceable(true);
    watcher.setReplaceable(false);

    expect(watcher.apply()).toBe(false);
    expect(incoming.messages).toEqual([]);
  });

  test('the scoring screen is never a screen updates are allowed on', () => {
    expect(updatesAllowedOn({ kind: 'scoring', recordId: 'game-1' })).toBe(false);
    expect(updatesAllowedOn({ kind: 'practice' })).toBe(false);
    expect(updatesAllowedOn({ kind: 'duplicate', recordId: 'game-1' })).toBe(false);
    expect(updatesAllowedOn({ kind: 'completed', recordId: 'game-1' })).toBe(false);
    // Two typed rosters that exist nowhere else yet. A worker swap would discard them mid-sentence.
    expect(updatesAllowedOn({ kind: 'create' })).toBe(false);

    expect(updatesAllowedOn({ kind: 'home' })).toBe(true);
    expect(updatesAllowedOn({ kind: 'pairing', returnTo: 'home' })).toBe(true);
    expect(updatesAllowedOn({ kind: 'room' })).toBe(true);
    expect(updatesAllowedOn({ kind: 'readiness' })).toBe(true);
  });

  test('a controller change nobody asked for does not reload the page', () => {
    const reload = vi.fn();
    const { container } = deviceWithWaitingBuild(reload);

    // This is what a first install looks like from the page's point of view, and what a worker
    // activating because every other tab closed looks like too. Reloading here restarts the
    // application under somebody who did nothing.
    container.changeController();

    expect(reload).not.toHaveBeenCalled();
  });
});

describe('applying an update on purpose', () => {
  test('the swap is asked for, and the reload waits for the new worker to have control', () => {
    const reload = vi.fn();
    const { watcher, container, incoming } = deviceWithWaitingBuild(reload);
    watcher.setReplaceable(true);

    expect(watcher.apply()).toBe(true);
    expect(incoming.messages).toEqual(['qbsheet:skip-waiting']);
    // Reloading now would land back on the old worker and look like a button that does nothing.
    expect(reload).not.toHaveBeenCalled();

    container.changeController();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('pressing Update now twice reloads once', () => {
    const reload = vi.fn();
    const { watcher, container, incoming } = deviceWithWaitingBuild(reload);
    watcher.setReplaceable(true);

    watcher.apply();
    expect(watcher.apply()).toBe(false);
    container.changeController();

    expect(incoming.messages).toEqual(['qbsheet:skip-waiting']);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a swap already in flight completes even if the screen changes under it', () => {
    const reload = vi.fn();
    const { watcher, container } = deviceWithWaitingBuild(reload);
    watcher.setReplaceable(true);
    watcher.apply();

    // By now the new worker is activating and has deleted the old cache. Leaving the page controlled
    // by a worker whose cache is gone is worse than completing the reload.
    watcher.setReplaceable(false);
    container.changeController();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('an apply that never takes control becomes retryable', async () => {
    vi.useFakeTimers();
    try {
      const { watcher, incoming } = deviceWithWaitingBuild();
      watcher.setReplaceable(true);

      expect(watcher.apply()).toBe(true);
      expect(watcher.snapshot().applying).toBe(true);

      await vi.advanceTimersByTimeAsync(updateApplyTimeoutMs);

      expect(watcher.snapshot()).toEqual({ available: true, applying: false });
      expect(watcher.apply()).toBe(true);
      expect(incoming.messages).toEqual(['qbsheet:skip-waiting', 'qbsheet:skip-waiting']);
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('apply with nothing waiting is a no-op rather than a reload', () => {
    const reload = vi.fn();
    const registration = new FakeRegistration();
    const container = new FakeContainer();
    container.controller = { id: 'old' };
    const watcher = new AppUpdateWatcher({ reload });
    watcher.observe(registration, container);
    watcher.setReplaceable(true);

    expect(watcher.apply()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('checking for updates', () => {
  test('a check is skipped while the browser reports no network', async () => {
    const { registration, watcher } = deviceWithWaitingBuild();
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    try {
      await watcher.checkNow();
      expect(registration.updateCalls).toBe(0);
    } finally {
      online.mockRestore();
    }
  });

  test('a check is skipped while the document is hidden', async () => {
    const { registration, watcher } = deviceWithWaitingBuild();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    try {
      await watcher.checkNow();
      expect(registration.updateCalls).toBe(0);
    } finally {
      visibility.mockRestore();
    }
  });

  test('an observed watcher checks periodically while it is running', async () => {
    vi.useFakeTimers();
    try {
      const registration = new FakeRegistration();
      const container = new FakeContainer();
      container.controller = { id: 'old' };
      const watcher = new AppUpdateWatcher({ reload: vi.fn() });
      watcher.observe(registration, container);

      await vi.advanceTimersByTimeAsync(updateCheckIntervalMs);

      expect(registration.updateCalls).toBe(1);
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a check that throws is silent and leaves the state alone', async () => {
    const { registration, watcher } = deviceWithWaitingBuild();
    registration.update = () => Promise.reject(new Error('captive portal'));

    await expect(watcher.checkNow()).resolves.toBeUndefined();
    expect(watcher.snapshot().available).toBe(true);
  });

  test('stopping the watcher stops the periodic check', () => {
    vi.useFakeTimers();
    try {
      const registration = new FakeRegistration();
      const container = new FakeContainer();
      const watcher = new AppUpdateWatcher({ reload: vi.fn() });
      watcher.observe(registration, container);
      watcher.stop();

      vi.advanceTimersByTime(60 * 60 * 1000);

      expect(registration.updateCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
