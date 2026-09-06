import { describe, expect, test, vi } from 'vitest';
import { AppUpdateWatcher, IContainerLike, IRegistrationLike, IWorkerLike } from '../src/pwa/AppUpdate';

class Worker implements IWorkerLike {
  state = 'installed';
  postMessage(_message: unknown): void {}
  addEventListener(_type: 'statechange', _listener: () => void): void {}
  removeEventListener(_type: 'statechange', _listener: () => void): void {}
}

class Registration implements IRegistrationLike {
  installing: IWorkerLike | null = null;
  waiting: IWorkerLike | null = null;
  update = vi.fn(async () => undefined);
  addEventListener(_type: 'updatefound', _listener: () => void): void {}
  removeEventListener(_type: 'updatefound', _listener: () => void): void {}
}

class Container implements IContainerLike {
  controller: unknown = { id: 'current' };
  addEventListener(_type: 'controllerchange', _listener: () => void): void {}
  removeEventListener(_type: 'controllerchange', _listener: () => void): void {}
}

describe('stopping app update observation', () => {
  test('manual checks no longer use the registration after stop', async () => {
    const registration = new Registration();
    const watcher = new AppUpdateWatcher({ reload: vi.fn() });
    watcher.observe(registration, new Container());

    watcher.stop();
    await watcher.checkNow();

    expect(registration.update).not.toHaveBeenCalled();
  });

  test('clears an in-flight apply so a later observation can apply normally', () => {
    const first = new Registration();
    first.waiting = new Worker();
    const watcher = new AppUpdateWatcher({ reload: vi.fn() });
    watcher.observe(first, new Container());
    watcher.setReplaceable(true);

    expect(watcher.apply()).toBe(true);
    expect(watcher.snapshot()).toEqual({ available: true, applying: true });

    watcher.stop();
    expect(watcher.snapshot()).toEqual({ available: false, applying: false });

    const second = new Registration();
    second.waiting = new Worker();
    watcher.observe(second, new Container());

    expect(watcher.snapshot()).toEqual({ available: true, applying: false });
    expect(watcher.apply()).toBe(true);
    watcher.stop();
  });
});
