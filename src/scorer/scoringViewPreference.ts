/**
 * Which of the two scoring layouts this device draws last: the scoresheet, or the table.
 *
 * # "Scoring layout" is the name; `view` is the spelling history left behind
 *
 * The scorekeeper is offered a *scoring layout*, and every label, description and menu entry says so.
 * The type, the functions and the storage key still say `view`, and deliberately: renaming the key
 * would migrate every device that has already chosen for no gain, and renaming the symbols would be
 * churn across six files to say the same thing. The copy lives in `scoringLayoutLabels` and
 * `scoringLayoutDescriptions` below, which is what anybody looking for the wording will find.
 *
 * # Presentation, and nothing else
 *
 * Both layouts record the same events through the same callbacks — see `TableView`, which is handed
 * the display-mapped state the scoresheet already derived and calls the wrappers `TeamPanel` calls.
 * Choosing between them changes what a scorekeeper looks at and changes nothing about what is
 * written, which is why this is a preference rather than a setting: it belongs to whoever is at this
 * Chromebook, it is not a property of the tournament, and it must never reach the event history, a
 * QBJ, or tournament control.
 *
 * # This is the *last used* layout, not the layout in force
 *
 * A new game asks which layout to score it in and preselects what is stored here; see
 * `scoringLayoutPrompt` for why it asks rather than silently inheriting. So this value is a default
 * offered to the next scorekeeper, and the scoresheet default is what somebody who has never chosen
 * is offered first — a room that has scored from ruled rows all season should not find a floor plan
 * in front of it because a version shipped.
 *
 * Kept beside `keyboardPreference`, whose shape this follows deliberately, and not aged out for the
 * same reason: somebody who chose the table in the morning has not changed their mind by lunchtime.
 */

export const scoringViewVersion = 1;

export const scoringViewStorageKey = `qbsheet.scorer.view.v${scoringViewVersion}`;

export const tableOrientationStorageKey = `qbsheet.scorer.table-orientation.v${scoringViewVersion}`;

/** `scoresheet` is the ruled rows; `table` is the room's own seating. */
export type ScoringView = 'scoresheet' | 'table';

export const defaultScoringView: ScoringView = 'scoresheet';

/** The order the two are offered in, everywhere they are offered. */
export const scoringLayouts: readonly ScoringView[] = ['scoresheet', 'table'];

/** What each layout is called. Stated once, so the chooser, the switcher and the menu agree. */
export const scoringLayoutLabels: Record<ScoringView, string> = {
  scoresheet: 'Scoresheet',
  table: 'Table',
};

/** The half-line under the name, for the surfaces that have room for one. */
export const scoringLayoutTaglines: Record<ScoringView, string> = {
  scoresheet: 'Traditional layout',
  table: 'Matches the room',
};

/** What choosing it actually gets you. Written for somebody who has never seen either. */
export const scoringLayoutDescriptions: Record<ScoringView, string> = {
  scoresheet: 'Players are listed in rows with scoring controls beside each name.',
  table: 'Players appear in seating order. Tap a player, then choose the ruling.',
};

/**
 * Which way the tables run on screen.
 *
 * # Not a third layout
 *
 * This is the table seen from a different chair, and nothing else: the same tiles, the same picker,
 * the same seat order, the same everything. A scorekeeper sitting alongside the tables sees each
 * team's seats running left to right, which is what they see in the room. A scorekeeper at the end of
 * the room — beside the moderator, which is where most of them actually sit — is looking *down* the
 * tables, and the seats run away from them. Drawing that as a row is asking somebody to rotate the
 * room in their head on every buzz.
 *
 * So it belongs with the layout preference rather than beside it. There are two layouts and the
 * table has two orientations; there are not four layouts.
 *
 * # Across unless somebody said otherwise
 *
 * `across` is what the table has always drawn, so a device that has been using it keeps what it has.
 */
export type TableOrientation = 'across' | 'down';

export const defaultTableOrientation: TableOrientation = 'across';

/** The order the two are offered in. */
export const tableOrientations: readonly TableOrientation[] = ['across', 'down'];

/** What each one is called. Short, because the control sits in a strip beside two others. */
export const tableOrientationLabels: Record<TableOrientation, string> = {
  across: 'Across',
  down: 'Down',
};

/**
 * Which chair each one is for.
 *
 * Named for where the scorekeeper is rather than for the axis, because "vertical" is a fact about
 * pixels and "you are sitting at the end of the room" is the fact they are answering.
 */
export const tableOrientationDescriptions: Record<TableOrientation, string> = {
  across: 'Seats run left to right, for a scorekeeper sitting alongside the tables.',
  down: 'Seats run top to bottom, for a scorekeeper at the end of the room looking down them.',
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

function isTableOrientation(value: string | null): value is TableOrientation {
  return value === 'across' || value === 'down';
}

export function loadTableOrientation(
  storage: IPreferenceStorage | null = browserStorage(),
): TableOrientation {
  try {
    const stored = storage?.getItem(tableOrientationStorageKey) ?? null;
    return isTableOrientation(stored) ? stored : defaultTableOrientation;
  } catch {
    return defaultTableOrientation;
  }
}

export function saveTableOrientation(
  orientation: TableOrientation,
  storage: IPreferenceStorage | null = browserStorage(),
): boolean {
  try {
    storage?.setItem(tableOrientationStorageKey, orientation);
    return storage !== null;
  } catch {
    return false;
  }
}

/** The orientation as a live value, held the same way and for the same reasons as the layout. */
let orientation = loadTableOrientation();
const orientationListeners = new Set<(value: TableOrientation) => void>();

export function tableOrientation(): TableOrientation {
  return orientation;
}

export function setTableOrientation(value: TableOrientation): void {
  if (value === orientation) return;
  orientation = value;
  saveTableOrientation(value);
  orientationListeners.forEach((listener) => listener(value));
}

export function subscribeTableOrientation(listener: (value: TableOrientation) => void): () => void {
  orientationListeners.add(listener);
  return () => {
    orientationListeners.delete(listener);
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
    storage?.removeItem(tableOrientationStorageKey);
  } catch {
    cleared = false;
  }
  if (current !== defaultScoringView) {
    current = defaultScoringView;
    listeners.forEach((listener) => listener(current));
  }
  if (orientation !== defaultTableOrientation) {
    orientation = defaultTableOrientation;
    orientationListeners.forEach((listener) => listener(orientation));
  }
  return cleared;
}

/** Re-read storage. For tests, which clear it between cases. */
export function resetScoringView(): void {
  current = loadScoringView();
  listeners.forEach((listener) => listener(current));
  orientation = loadTableOrientation();
  orientationListeners.forEach((listener) => listener(orientation));
}
