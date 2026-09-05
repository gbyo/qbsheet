import { describe, expect, test, vi } from 'vitest';
import { AppUpdateWatcher, IContainerLike, IRegistrationLike, IWorkerLike } from '../src/pwa/AppUpdate';

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
});
