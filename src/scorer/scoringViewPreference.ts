/**
 * Which of the two scoring surfaces this device draws: the scoresheet, or the table.
 *
 * # Presentation, and nothing else
 *
 * Both views record the same events through the same callbacks — see `TableView`, which is handed
 * the display-mapped state the scoresheet already derived and calls the wrappers `TeamPanel` calls.
 * Choosing between them changes what a scorekeeper looks at and changes nothing about what is
 * written, which is why this is a preference rather than a setting: it belongs to whoever is at this
 * Chromebook, it is not a property of the tournament, and it must never reach the event history, a
 * QBJ, or tournament control.
 *
 * # Scoresheet unless somebody said otherwise
 *
 * The default is the view every existing scorekeeper already knows. A room that has been scoring
 * from ruled rows all season should not find a floor plan in front of it because a version shipped.
 *
 * Kept beside `keyboardPreference`, whose shape this follows deliberately, and not aged out for the
 * same reason: somebody who chose the table view in the morning has not changed their mind by the
 * afternoon.
 */

export const scoringViewVersion = 1;

export const scoringViewStorageKey = `qbsheet.scorer.view.v${scoringViewVersion}`;

/** `scoresheet` is the ruled rows; `table` is the spatial view of the room. */
export type ScoringView = 'scoresheet' | 'table';

export const defaultScoringView: ScoringView = 'scoresheet';

/** What the Game menu calls each of them. Stated once so the menu and any hint agree. */
export const scoringViewLabels: Record<ScoringView, string> = {
  scoresheet: 'Scoresheet',
  table: 'Table',
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

function isScoringView(value: string | null): value is ScoringView {
  return value === 'scoresheet' || value === 'table';
}

export function loadScoringView(storage: IPreferenceStorage | null = browserStorage()): ScoringView {
  try {
    const stored = storage?.getItem(scoringViewStorageKey) ?? null;
    return isScoringView(stored) ? stored : defaultScoringView;
  } catch {
    return defaultScoringView;
  }
}

export function saveScoringView(
  view: ScoringView,
  storage: IPreferenceStorage | null = browserStorage(),
): boolean {
  try {
    storage?.setItem(scoringViewStorageKey, view);
    return storage !== null;
  } catch {
    // Nothing depends on this sticking. The choice still applies for as long as the tab is open.
    return false;
  }
}

/**
 * The preference as a live value, so every reader agrees within one turn.
 *
 * Module state rather than context, for the reason `keyboardPreference` documents: there is one
 * scorekeeper per device, the menu entry and the scoring surface have to change together, and a copy
 * held in `useState` would leave one of them an interaction behind the other.
 */
let current = loadScoringView();
const listeners = new Set<(value: ScoringView) => void>();

export function scoringView(): ScoringView {
  return current;
}

export function setScoringView(value: ScoringView): void {
  if (value === current) return;
  current = value;
  saveScoringView(value);
  listeners.forEach((listener) => listener(value));
}

export function subscribeScoringView(listener: (value: ScoringView) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Forget the choice and return this device to the scoresheet in the same turn.
 *
 * Removing storage alone is not enough, for the reason `clearKeyboardPreference` documents: the
 * module singleton may already hold the table view, and every mounted subscriber has to agree with
 * Settings immediately rather than after a reload.
 */
export function clearScoringView(storage: IPreferenceStorage | null = browserStorage()): boolean {
  let cleared = storage !== null;
  try {
    storage?.removeItem(scoringViewStorageKey);
  } catch {
    cleared = false;
  }
  if (current !== defaultScoringView) {
    current = defaultScoringView;
    listeners.forEach((listener) => listener(current));
  }
  return cleared;
}

/** Re-read storage. For tests, which clear it between cases. */
export function resetScoringView(): void {
  current = loadScoringView();
  listeners.forEach((listener) => listener(current));
}
