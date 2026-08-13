import { describe, expect, test, vi } from 'vitest';
import {
  clearOperatorIdentity,
  operatorNameAskedStorageKey,
  operatorNameStorageKey,
} from '../src/app/OperatorIdentity';
import {
  clearKeyboardPreference,
  keyboardEnabled,
  keyboardPreferenceStorageKey,
  setKeyboardEnabled,
  subscribeKeyboardEnabled,
} from '../src/scorer/keyboardPreference';

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

describe('narrow device preference reset APIs', () => {
  test('operator reset names both identity keys and leaves unrelated storage alone', () => {
    const storage = new TestStorage();
    storage.setItem(operatorNameStorageKey, 'Gibson Bell');
    storage.setItem(operatorNameAskedStorageKey, '1');
    storage.setItem('qbsheet.game-journal.do-not-touch', 'saved game');

    expect(clearOperatorIdentity(storage)).toBe(true);
    expect(storage.getItem(operatorNameStorageKey)).toBeNull();
    expect(storage.getItem(operatorNameAskedStorageKey)).toBeNull();
    expect(storage.getItem('qbsheet.game-journal.do-not-touch')).toBe('saved game');
  });

  test('keyboard reset removes only its key, turns the live singleton off, and notifies subscribers', () => {
    const storage = new TestStorage();
    storage.setItem(keyboardPreferenceStorageKey, 'on');
    storage.setItem('qbsheet.player-seating.do-not-touch', 'saved seating');
    setKeyboardEnabled(true);
    const listener = vi.fn();
    const unsubscribe = subscribeKeyboardEnabled(listener);

    expect(clearKeyboardPreference(storage)).toBe(true);
    expect(storage.getItem(keyboardPreferenceStorageKey)).toBeNull();
    expect(storage.getItem('qbsheet.player-seating.do-not-touch')).toBe('saved seating');
    expect(keyboardEnabled()).toBe(false);
    expect(listener).toHaveBeenCalledWith(false);
    unsubscribe();
  });
});
