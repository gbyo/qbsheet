import { describe, expect, test } from 'vitest';
import {
  ResultDeliveryCapabilityStore,
  type IResultDeliveryCapabilityStorage,
} from '../src/app/ResultDeliveryCapability';
import { completedGameRetentionMs } from '../src/game/GameStore';

class MemoryStorage implements IResultDeliveryCapabilityStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const capability = {
  baseUrl: 'https://control.example.test',
  sessionId: 'session-1',
  sessionToken: 'secret',
};

describe('result delivery capability retention', () => {
  test('round-trips the complete LAN authority without changing primary-only entries', () => {
    const storage = new MemoryStorage();
    const store = new ResultDeliveryCapabilityStore(storage, () => new Date('2026-08-11T14:05:00.000Z'));
    expect(
      store.remember(
        'game-lan',
        {
          ...capability,
          lanBaseUrl: 'http://lan.test',
          lanSessionId: 'lan-session',
          lanSessionToken: 'lan-secret',
        },
        '2026-08-11T14:00:00.000Z',
      ),
    ).toBe(true);
    expect(store.remember('game-primary', capability, '2026-08-11T14:00:00.000Z')).toBe(true);

    const reloaded = new ResultDeliveryCapabilityStore(storage, () => new Date('2026-08-11T14:05:00.000Z'));
    expect(reloaded.get('game-lan')).toEqual({
      ...capability,
      lanBaseUrl: 'http://lan.test',
      lanSessionId: 'lan-session',
      lanSessionToken: 'lan-secret',
    });
    expect(reloaded.get('game-primary')).toEqual(capability);
  });

  test('does not extend a private capability beyond retention when completion is future-dated', () => {
    let now = new Date('2026-08-11T14:00:00.000Z');
    const store = new ResultDeliveryCapabilityStore(new MemoryStorage(), () => now);

    expect(store.remember('game-1', capability, '2027-08-11T14:00:00.000Z')).toBe(true);
    expect(store.has('game-1')).toBe(true);

    now = new Date(new Date('2026-08-11T14:00:00.000Z').getTime() + completedGameRetentionMs + 1);
    expect(store.has('game-1')).toBe(false);
  });

  test('keeps an ordinary past completion anchored to its actual completion time', () => {
    let now = new Date('2026-08-12T14:00:00.000Z');
    const store = new ResultDeliveryCapabilityStore(new MemoryStorage(), () => now);

    expect(store.remember('game-1', capability, '2026-08-11T14:00:00.000Z')).toBe(true);

    now = new Date('2026-08-18T13:59:59.999Z');
    expect(store.has('game-1')).toBe(true);
    now = new Date('2026-08-18T14:00:00.000Z');
    expect(store.has('game-1')).toBe(false);
  });
});
