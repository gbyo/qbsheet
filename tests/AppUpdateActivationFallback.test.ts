import { describe, expect, test, vi } from 'vitest';
import { AppUpdateWatcher, IContainerLike, IRegistrationLike, IWorkerLike } from '../src/pwa/AppUpdate';

class WaitingWorker implements IWorkerLike {
  state = 'installed';

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

  activate(): void {
    this.state = 'activated';
    this.listeners.forEach((listener) => listener());
  }
}

class WaitingRegistration implements IRegistrationLike {
  installing = null;

  constructor(readonly waiting: WaitingWorker | null) {}

  update(): Promise<unknown> {
    return Promise.resolve();
  }

  addEventListener(): void {}

  removeEventListener(): void {}
}

class ControlledContainer implements IContainerLike {
  controller: unknown = { id: 'old' };

  addEventListener(): void {}

  removeEventListener(): void {}
}

describe('Update now activation fallback', () => {
  test('reloads when the requested worker activates even without controllerchange', () => {
    const worker = new WaitingWorker();
    const reload = vi.fn();
    const watcher = new AppUpdateWatcher({ reload });
    watcher.observe(new WaitingRegistration(worker), new ControlledContainer());
    watcher.setReplaceable(true);

    expect(watcher.apply()).toBe(true);
    expect(worker.messages).toEqual(['qbsheet:skip-waiting']);
    expect(reload).not.toHaveBeenCalled();

    worker.activate();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(watcher.snapshot()).toEqual({ available: false, applying: false });
  });

  test('a failed postMessage leaves the update retryable instead of sticking on Updating', () => {
    const worker = new WaitingWorker();
    worker.postMessage = () => {
      throw new Error('worker became unavailable');
    };
    const watcher = new AppUpdateWatcher({ reload: vi.fn() });
    watcher.observe(new WaitingRegistration(worker), new ControlledContainer());
    watcher.setReplaceable(true);

    expect(watcher.apply()).toBe(false);
    expect(watcher.snapshot()).toEqual({ available: true, applying: false });
  });
});
