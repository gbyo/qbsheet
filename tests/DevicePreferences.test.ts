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
import {
  forgetScoringLayoutChoice,
  rememberScoringLayoutChoice,
  resetScoringLayoutPrompts,
  scoringLayoutChosen,
  scoringLayoutPromptMaxAgeMs,
  scoringLayoutPromptStorageKey,
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

/**
 * Whether a game has already been asked which layout to score it in.
 *
 * The failure this guards is a modal that comes back: after a reload, after a recovery, or in the
 * middle of a round somebody was already scoring. It is a device fact and nothing else — no event,
 * no QBJ, nothing undo can reach — and on a device that refuses storage it still has to hold for as
 * long as the tab is open.
 */
describe('the per-game layout question', () => {
  const now = new Date('2026-04-11T14:00:00.000Z');

  test('a game nobody has been asked about is asked', () => {
    resetScoringLayoutPrompts();
    expect(scoringLayoutChosen('round-4', now, new TestStorage())).toBe(false);
  });

  test('an answered game is not asked again', () => {
    resetScoringLayoutPrompts();
    const storage = new TestStorage();

    expect(rememberScoringLayoutChoice('round-4', now, storage)).toBe(true);

    expect(scoringLayoutChosen('round-4', now, storage)).toBe(true);
    // And only that game: the next round is a different scorekeeper's question.
    expect(scoringLayoutChosen('round-5', now, storage)).toBe(false);
  });

  test('an answer from a tournament that finished is not held against the next one', () => {
    resetScoringLayoutPrompts();
    const storage = new TestStorage();
    rememberScoringLayoutChoice('round-4', now, storage);
    // A new tab: the in-memory answer is gone and only the stored marker is left. Nothing calls a
    // cleanup, so the age check is what stops a Chromebook accumulating a row per game it has ever
    // scored — and a game nobody has touched since yesterday is one worth asking about again.
    resetScoringLayoutPrompts();
    const laterStill = new Date(now.getTime() + scoringLayoutPromptMaxAgeMs + 1000);

    expect(scoringLayoutChosen('round-4', laterStill, storage)).toBe(false);
    // Within the window it still counts.
    expect(scoringLayoutChosen('round-4', new Date(now.getTime() + 60_000), storage)).toBe(true);
  });

  test('a marker in a shape this build does not recognize means never asked', () => {
    resetScoringLayoutPrompts();
    const storage = new TestStorage();
    storage.setItem(scoringLayoutPromptStorageKey('round-4'), 'not json at all');

    expect(scoringLayoutChosen('round-4', now, storage)).toBe(false);
  });

  test('a device that cannot store still only asks once per tab', () => {
    resetScoringLayoutPrompts();
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

    // The write is refused and says so, and the answer holds anyway.
    expect(rememberScoringLayoutChoice('round-4', now, broken)).toBe(false);
    expect(scoringLayoutChosen('round-4', now, broken)).toBe(true);
  });

  test('forgetting an answer asks again, which is what a device reset is for', () => {
    resetScoringLayoutPrompts();
    const storage = new TestStorage();
    rememberScoringLayoutChoice('round-4', now, storage);

    forgetScoringLayoutChoice('round-4', storage);

    expect(scoringLayoutChosen('round-4', now, storage)).toBe(false);
    expect(storage.getItem(scoringLayoutPromptStorageKey('round-4'))).toBeNull();
  });
});
