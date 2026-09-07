import { describe, expect, test } from 'vitest';
import { loadSeating, saveSeating } from '../src/scorer/PlayerSeating';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('player seating persistence', () => {
  test('keeps a fresh seating preference after the device clock moves backward', () => {
    const durable = storage();
    const savedAt = new Date('2026-09-06T18:00:00.000Z');

    expect(saveSeating('game-1', { left: ['Alex'], right: [] }, savedAt, durable)).toBe(true);

    expect(loadSeating('game-1', new Date('2026-09-06T17:00:00.000Z'), durable)).toEqual({
      left: ['Alex'],
      right: [],
    });
  });
});
