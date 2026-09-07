import { describe, expect, test, vi } from 'vitest';
import { AppUpdateWatcher, IContainerLike, IRegistrationLike, IWorkerLike } from '../src/pwa/AppUpdate';

class SlowRegistration implements IRegistrationLike {
  installing: IWorkerLike | null = null;

  waiting: IWorkerLike | null = null;

  private resolveUpdate: (() => void) | null = null;

  readonly update = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        this.resolveUpdate = resolve;
      }),
  );

  addEventListener(_type: 'updatefound', _listener: () => void): void {}

  removeEventListener(_type: 'updatefound', _listener: () => void): void {}

  finishUpdate(): void {
    this.resolveUpdate?.();
    this.resolveUpdate = null;
  }
}

class Container implements IContainerLike {
  controller: unknown = { id: 'current' };

  addEventListener(_type: 'controllerchange', _listener: () => void): void {}

  removeEventListener(_type: 'controllerchange', _listener: () => void): void {}
}

describe('app update check coalescing', () => {
  test('overlapping checks share one service-worker update request', async () => {
    const registration = new SlowRegistration();
    const watcher = new AppUpdateWatcher();
    watcher.observe(registration, new Container());

    const first = watcher.checkNow();
    const second = watcher.checkNow();

    expect(second).toBe(first);
    expect(registration.update).toHaveBeenCalledTimes(1);

    registration.finishUpdate();
    await Promise.all([first, second]);

    const next = watcher.checkNow();
    expect(registration.update).toHaveBeenCalledTimes(2);
    registration.finishUpdate();
    await next;

    watcher.stop();
  });
});
