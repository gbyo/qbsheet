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
