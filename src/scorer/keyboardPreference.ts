/**
 * Whether this device's scorekeeper has asked for keyboard scoring.
 *
 * # Off unless somebody said otherwise
 *
 * The default is off, and it stays off for everybody who has ever used QBSheet without it. A scoresheet
 * that silently started treating `A` as "seat one, ten points" would be a scoresheet that recorded a
 * tossup the first time somebody used a browser shortcut, and the people most likely to be surprised
 * are exactly the experienced scorekeepers this feature is for.
 *
 * # Device-scoped, and not part of the game
 *
 * Kept beside the seating preference and for the same reasons: it belongs to whoever is sitting at this
 * Chromebook, it is not a property of the tournament, and it must never reach the event history, a QBJ,
 * or tournament control. Unlike the seating preference it is *not* aged out — a scorekeeper who turned
 * this on in the morning has not changed their mind by the afternoon, and making them find the toggle
 * again after lunch would be worse than useless.
 */

export const keyboardPreferenceVersion = 1;

export const keyboardPreferenceStorageKey = `qbsheet.scorer.keyboard.v${keyboardPreferenceVersion}`;

interface IPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): IPreferenceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // A locked-down profile. Keyboard scoring then lasts as long as the tab, which is a degradation
    // worth having rather than a reason to refuse.
    return null;
  }
}

export function loadKeyboardEnabled(storage: IPreferenceStorage | null = browserStorage()): boolean {
  try {
    return storage?.getItem(keyboardPreferenceStorageKey) === 'on';
  } catch {
    return false;
  }
}

export function saveKeyboardEnabled(enabled: boolean, storage: IPreferenceStorage | null = browserStorage()): boolean {
  try {
    storage?.setItem(keyboardPreferenceStorageKey, enabled ? 'on' : 'off');
    return true;
  } catch {
    // Nothing depends on this sticking. The toggle still works for this tab.
    return false;
  }
}

/**
 * The preference as a live value, so two places can render it without disagreeing.
 *
 * The toggle is in the scorer's own menu and the practice coach has to teach the keys that toggle turns
 * on. Reading storage on render would leave the coach one interaction behind — showing keystroke hints
 * for a mode that had just been switched off, or hiding them for one just switched on — so the value is
 * held once and subscribed to.
 *
 * Module state rather than context because there is one keyboard per device, the same reason
 * `PlayerSeating` is keyed per game and this is not.
 */
let enabled = loadKeyboardEnabled();
const listeners = new Set<(value: boolean) => void>();

export function keyboardEnabled(): boolean {
  return enabled;
}

export function setKeyboardEnabled(value: boolean): void {
  if (value === enabled) return;
  enabled = value;
  saveKeyboardEnabled(value);
  listeners.forEach((listener) => listener(value));
}

export function subscribeKeyboardEnabled(listener: (value: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Remove the persisted choice and make the live device preference OFF in the same turn.
 *
 * Removing storage alone is not enough: the module singleton may already be ON and every mounted
 * subscriber has to agree with Settings immediately rather than waiting for a reload.
 */
export function clearKeyboardPreference(storage: IPreferenceStorage | null = browserStorage()): boolean {
  let cleared = storage !== null;
  try {
    storage?.removeItem(keyboardPreferenceStorageKey);
  } catch {
    cleared = false;
  }
  if (enabled) {
    enabled = false;
    listeners.forEach((listener) => listener(enabled));
  }
  return cleared;
}

/** Re-read storage. For tests, which clear it between cases. */
export function resetKeyboardPreference(): void {
  enabled = loadKeyboardEnabled();
  listeners.forEach((listener) => listener(enabled));
}
