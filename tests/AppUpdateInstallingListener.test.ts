import { describe, expect, test, vi } from 'vitest';
import {
  AppUpdateWatcher,
  IContainerLike,
  IRegistrationLike,
  IWorkerLike,
} from '../src/pwa/AppUpdate';

class Worker implements IWorkerLike {
  state = 'installing';

  private readonly listeners = new Set<() => void>();

  postMessage(): void {}

  addEventListener(_type: 'statechange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'statechange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

class Registration implements IRegistrationLike {
  installing: Worker | null = null;

  waiting: Worker | null = null;

  private readonly listeners = new Set<() => void>();

  update(): Promise<unknown> {
    return Promise.resolve();
  }

  addEventListener(_type: 'updatefound', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'updatefound', listener: () => void): void {
    this.listeners.delete(listener);
  }

  findUpdate(worker: Worker): void {
    this.installing = worker;
    this.listeners.forEach((listener) => listener());
  }
}

class Container implements IContainerLike {
  controller: unknown = { id: 'old' };

  private readonly listeners = new Set<() => void>();

  addEventListener(_type: 'controllerchange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'controllerchange', listener: () => void): void {
    this.listeners.delete(listener);
  }
}

describe('installing worker listener cleanup', () => {
  test('replacing observation detaches the old installing worker listener', () => {
    const watcher = new AppUpdateWatcher({ reload: vi.fn() });
    const firstRegistration = new Registration();
    const installing = new Worker();

    watcher.observe(firstRegistration, new Container());
    firstRegistration.findUpdate(installing);
    expect(installing.listenerCount()).toBe(1);

    watcher.observe(new Registration(), new Container());

    expect(installing.listenerCount()).toBe(0);
    watcher.stop();
  });

  test('stopping observation detaches an in-flight installing worker listener', () => {
    const watcher = new AppUpdateWatcher({ reload: vi.fn() });
    const registration = new Registration();
    const installing = new Worker();

    watcher.observe(registration, new Container());
    registration.findUpdate(installing);
    expect(installing.listenerCount()).toBe(1);

    watcher.stop();

    expect(installing.listenerCount()).toBe(0);
  });
});
