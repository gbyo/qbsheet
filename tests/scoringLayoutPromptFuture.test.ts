import { beforeEach, describe, expect, test } from 'vitest';
import {
  resetScoringLayoutPrompts,
  scoringLayoutChosen,
  scoringLayoutPromptMaxAgeMs,
  scoringLayoutPromptStorageKey,
  scoringLayoutPromptVersion,
} from '../src/scorer/scoringLayoutPrompt';

class MemoryStorage {
  private readonly values = new Map<string, string>();

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

function storeMarker(storage: MemoryStorage, gameKey: string, answeredAt: Date): void {
  storage.setItem(
    scoringLayoutPromptStorageKey(gameKey),
    JSON.stringify({ version: scoringLayoutPromptVersion, answeredAt: answeredAt.toISOString() }),
  );
}

describe('scoring layout prompt timestamp validation', () => {
  beforeEach(() => resetScoringLayoutPrompts());

  test('accepts a modest future clock skew but rejects implausibly future markers', () => {
    const storage = new MemoryStorage();
    const now = new Date('2026-09-08T03:00:00.000Z');

    storeMarker(storage, 'small-skew', new Date(now.getTime() + 5 * 60 * 1000));
    storeMarker(storage, 'bad-future', new Date(now.getTime() + scoringLayoutPromptMaxAgeMs + 1));

    expect(scoringLayoutChosen('small-skew', now, storage)).toBe(true);
    expect(scoringLayoutChosen('bad-future', now, storage)).toBe(false);
  });
});
