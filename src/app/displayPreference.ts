/**
 * How this device draws the scoresheet: appearance, and how big the text is.
 *
 * # Why these are device preferences and not settings
 *
 * They belong to whoever is sitting at this Chromebook, exactly like the keyboard and seating
 * preferences next to them. They are not a property of the tournament, they never reach the event
 * history, a QBJ, or tournament control, and a device that loses them has lost nothing that matters
 * to a result. See `keyboardPreference`, whose shape this follows deliberately so that a third
 * preference is a known quantity rather than a new invention.
 *
 * # Appearance defaults to the device, not to light
 *
 * `index.html` used to declare `color-scheme: light dark` while every stylesheet painted a fixed
 * light palette. That combination is worse than either half: the browser takes the declaration at
 * its word and renders the parts it owns — `<select>` popups, scrollbars, form controls, autofill —
 * in dark, on top of white surfaces the application drew. The result was unreadable native widgets
 * on a device somebody had set to dark, which is most school Chromebooks after four o'clock.
 *
 * The fix is to mean it. `system` follows `prefers-color-scheme` and is the default, because a room
 * that has already told its device what it wants should not have to tell the scoresheet again.
 * `light` and `dark` are for the scorekeeper whose device preference is wrong for the room they are
 * actually sitting in — a gym at full brightness, an auditorium with the lights down.
 *
 * # Text size is a multiplier, not a size
 *
 * The stylesheets express type in `rem`, so the browser's own font-size preference already reaches
 * every label on the scoresheet. This scales on top of that rather than replacing it: a scorekeeper
 * who has already set a large default font gets large text *and* the larger step if they ask for it.
 * Applied by scaling the root font size, so one declaration moves every `rem` in the application.
 */

export const displayPreferenceVersion = 1;

export const appearanceStorageKey = `qbsheet.display.appearance.v${displayPreferenceVersion}`;
export const textSizeStorageKey = `qbsheet.display.text-size.v${displayPreferenceVersion}`;

/** `system` follows the device. The other two override it for this browser profile. */
export type Appearance = 'system' | 'light' | 'dark';

/**
 * The three steps, and why there are only three.
 *
 * Spacing and control heights stay in pixels, so the type can grow a good way before a row stops
 * fitting the 1366×768 Chromebook the layout is sized for. `large` is the biggest step that still
 * holds the scoresheet grid together at that width; a fourth step would be a promise the layout
 * cannot keep. Anybody who needs more than this has browser zoom, which the `rem` conversion also
 * made work properly.
 */
export type TextSize = 'standard' | 'comfortable' | 'large';

export const textSizeScales: Record<TextSize, number> = {
  standard: 1,
  comfortable: 1.125,
  large: 1.25,
};

export const textSizeLabels: Record<TextSize, string> = {
  standard: 'Standard',
  comfortable: 'Comfortable',
  large: 'Large',
};

export const appearanceLabels: Record<Appearance, string> = {
  system: 'Match device',
  light: 'Light',
  dark: 'Dark',
};

interface IPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): IPreferenceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // A locked-down profile. The choice then lasts as long as the tab, which is a degradation worth
    // having rather than a reason to refuse.
    return null;
  }
}

function isAppearance(value: string | null): value is Appearance {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isTextSize(value: string | null): value is TextSize {
  return value === 'standard' || value === 'comfortable' || value === 'large';
}

export function loadAppearance(storage: IPreferenceStorage | null = browserStorage()): Appearance {
  try {
    const stored = storage?.getItem(appearanceStorageKey) ?? null;
    return isAppearance(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function loadTextSize(storage: IPreferenceStorage | null = browserStorage()): TextSize {
  try {
    const stored = storage?.getItem(textSizeStorageKey) ?? null;
    return isTextSize(stored) ? stored : 'standard';
  } catch {
    return 'standard';
  }
}

/**
 * Put the current choices on the root element.
 *
 * Two separate mechanisms because they answer to different things. Appearance is an attribute, so
 * the stylesheets can say "dark unless the scorekeeper explicitly asked for light" in one selector
 * and have the device preference lose to a deliberate choice. Text size is a root font size, so
 * every `rem` in every stylesheet follows without any of them knowing this module exists.
 *
 * `100%` rather than `16px` is load-bearing: it is the browser's own font-size preference, which is
 * the thing the pixel sizes used to ignore. The multiplier scales that, rather than replacing it.
 */
export function applyDisplayPreferences(
  appearance: Appearance,
  textSize: TextSize,
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): void {
  if (!root) return;
  try {
    if (appearance === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', appearance);
    root.style.setProperty('--room-text-scale', String(textSizeScales[textSize]));
  } catch {
    // Nothing here is worth throwing out of. A device that will not take the attribute renders the
    // application exactly as it did before this module existed.
  }
}

/**
 * The live values, held once so every reader agrees.
 *
 * Module state for the same reason as the keyboard preference: there is one screen per device, and a
 * copy in `useState` would leave the Settings dialog and the scoresheet one interaction apart.
 */
let appearance = loadAppearance();
let textSize = loadTextSize();
const listeners = new Set<() => void>();

/** A stable snapshot, so `useSyncExternalStore` is not handed a fresh object on every render. */
let snapshot: { appearance: Appearance; textSize: TextSize } = { appearance, textSize };

function announce(): void {
  snapshot = { appearance, textSize };
  applyDisplayPreferences(appearance, textSize);
  listeners.forEach((listener) => listener());
}

export function displayPreferences(): { appearance: Appearance; textSize: TextSize } {
  return snapshot;
}

export function subscribeDisplayPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setAppearance(
  value: Appearance,
  storage: IPreferenceStorage | null = browserStorage(),
): void {
  if (value === appearance) return;
  appearance = value;
  try {
    storage?.setItem(appearanceStorageKey, value);
  } catch {
    // The choice still applies to this tab.
  }
  announce();
}

export function setTextSize(value: TextSize, storage: IPreferenceStorage | null = browserStorage()): void {
  if (value === textSize) return;
  textSize = value;
  try {
    storage?.setItem(textSizeStorageKey, value);
  } catch {
    // As above.
  }
  announce();
}

/**
 * Forget both choices and return the screen to the device's own defaults in the same turn.
 *
 * Removing storage alone is not enough, for the reason `clearKeyboardPreference` documents: the
 * module singletons may already hold an override, and every mounted subscriber has to agree with
 * Settings immediately rather than after a reload.
 */
export function clearDisplayPreferences(storage: IPreferenceStorage | null = browserStorage()): boolean {
  let cleared = storage !== null;
  try {
    storage?.removeItem(appearanceStorageKey);
    storage?.removeItem(textSizeStorageKey);
  } catch {
    cleared = false;
  }
  if (appearance !== 'system' || textSize !== 'standard') {
    appearance = 'system';
    textSize = 'standard';
    announce();
  }
  return cleared;
}

/** Re-read storage. For tests, which clear it between cases. */
export function resetDisplayPreferences(): void {
  appearance = loadAppearance();
  textSize = loadTextSize();
  announce();
}

/**
 * Apply what was stored, before the first paint.
 *
 * Called from `main.tsx` ahead of `createRoot`. Doing it in an effect would show one frame of the
 * device's appearance before switching to the scorekeeper's, which is a flash of white on a device
 * somebody chose dark on precisely because white hurts.
 */
export function startDisplayPreferences(): void {
  applyDisplayPreferences(appearance, textSize);
}
