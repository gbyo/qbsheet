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
import {
  clearScoringView,
  loadScoringView,
  saveScoringView,
  scoringView,
  scoringViewStorageKey,
  setScoringView,
  subscribeScoringView,
} from '../src/scorer/scoringViewPreference';

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
  test('scoring view reset removes only its key, returns to the scoresheet, and notifies subscribers', () => {
    const storage = new TestStorage();
    storage.setItem(scoringViewStorageKey, 'table');
    storage.setItem('qbsheet.player-seating.do-not-touch', 'saved seating');
    setScoringView('table');
    const listener = vi.fn();
    const unsubscribe = subscribeScoringView(listener);

    expect(clearScoringView(storage)).toBe(true);
    expect(storage.getItem(scoringViewStorageKey)).toBeNull();
    expect(storage.getItem('qbsheet.player-seating.do-not-touch')).toBe('saved seating');
    expect(scoringView()).toBe('scoresheet');
    expect(listener).toHaveBeenCalledWith('scoresheet');
    unsubscribe();
  });
});

/**
 * The stored value, and what happens when the device will not keep it.
 *
 * A Chromebook with storage locked down still has to be able to score. Every path here therefore
 * answers with the scoresheet rather than throwing, and a refused write leaves the choice applying
 * for as long as the tab is open.
 */
describe('the scoring view preference on its own', () => {
  test('an absent or unrecognized value is the scoresheet', () => {
    const storage = new TestStorage();
    expect(loadScoringView(storage)).toBe('scoresheet');
    storage.setItem(scoringViewStorageKey, 'floor-plan');
    expect(loadScoringView(storage)).toBe('scoresheet');
  });

  test('a stored choice comes back', () => {
    const storage = new TestStorage();
    expect(saveScoringView('table', storage)).toBe(true);
    expect(storage.getItem(scoringViewStorageKey)).toBe('table');
    expect(loadScoringView(storage)).toBe('table');
  });

  test('storage that refuses to read or write is not a reason to refuse a view', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadScoringView(broken)).toBe('scoresheet');
    expect(saveScoringView('table', broken)).toBe(false);
    // Nothing here throws, so the toggle still works for this tab.
    expect(clearScoringView(broken)).toBe(false);
  });

  test('a device with no storage at all still answers', () => {
    expect(loadScoringView(null)).toBe('scoresheet');
    expect(saveScoringView('table', null)).toBe(false);
  });
});
