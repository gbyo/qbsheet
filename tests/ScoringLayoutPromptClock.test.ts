import { describe, expect, test } from 'vitest';
import {
  rememberScoringLayoutChoice,
  resetScoringLayoutPrompts,
  scoringLayoutChosen,
} from '../src/scorer/scoringLayoutPrompt';

class TestStorage {
  values = new Map<string, string>();

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

describe('scoring layout prompt clock corrections', () => {
  test('a backward clock correction does not make an answered game ask again', () => {
    resetScoringLayoutPrompts();
    const storage = new TestStorage();
    const savedAt = new Date('2026-09-06T18:00:00.000Z');

    expect(rememberScoringLayoutChoice('round-4', savedAt, storage)).toBe(true);

    // Simulate a reload after NTP/manual correction moves the Chromebook clock backward.
    resetScoringLayoutPrompts();
    const correctedNow = new Date(savedAt.getTime() - 60 * 60 * 1000);

    expect(scoringLayoutChosen('round-4', correctedNow, storage)).toBe(true);
  });
});
