/**
 * The keyboard layer: a fixed layout, derived rulings, and the rules about when a key means nothing.
 *
 * # Seats, not people
 *
 * ```
 *   LEFT                RIGHT
 *   A  S  D  F          J  K  L  ;
 *   1  2  3  4          1  2  3  4
 * ```
 *
 * The keys address *seats*, which is what a scorekeeper is already watching — the third column of a
 * paper scoresheet stays the third column all game, and a substitute takes the seat of the player they
 * came on for (see `PlayerSeating`). So a substitution needs no rebinding: the key was never bound to
 * the person. That is also why the layout is fixed rather than configurable. The entire value is that
 * the fourth seat is `F` on every device at every tournament, and a remapping feature would trade that
 * away for a preference nobody can rely on in somebody else's room.
 *
 * # Physical keys, deliberately
 *
 * Bindings are matched on `KeyboardEvent.code` rather than `key`, for two reasons that point the same
 * way. `Alt+A` on macOS reports `key` as `å`, so a layout built on `key` loses the neg modifier
 * outright. And the layout is *spatial* — the point is the shape under the hand — so the physical key
 * is the thing being named, not the letter printed on it.
 *
 * # No format knowledge
 *
 * The modifiers mean roles, and the roles are resolved against the live format by `tossupRulings`.
 * Shift is the power *if the format has one*; Alt is the penalty *if a neg is legal on this tossup*. A
 * modifier with nothing behind it is reported as unavailable and does nothing at all, rather than
 * falling back to something adjacent — a keyboard that quietly records +10 because this format has no
 * power is a keyboard that has scored the wrong thing.
 *
 * # And no new chords
 *
 * Four rulings per seat is the whole layout. A format with more answer types than that leaves the
 * extras on the buttons, and the legend says so. Inventing `Ctrl+Alt+Shift+D` for a third positive
 * tier would produce something nobody can use at speed, which is the only thing this feature is for.
 */
import { LeftOrRight } from '../scoring/types';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { negRuling, normalCorrect, powerCorrect, rulingLabel } from './tossupRulings';

/** Which physical keys address which seat, in reading order. Fixed; see the note above. */
export const seatKeyCodes: Record<LeftOrRight, readonly string[]> = {
  left: ['KeyA', 'KeyS', 'KeyD', 'KeyF'],
  right: ['KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
};

/** What is printed on those keys, for the legend. Parallel to `seatKeyCodes` by index. */
export const seatKeyLabels: Record<LeftOrRight, readonly string[]> = {
  left: ['A', 'S', 'D', 'F'],
  right: ['J', 'K', 'L', ';'],
};

/** How many seats the layout can address per side. Beyond this, the buttons are the only way. */
export const keyboardSeatCount = 4;

export interface ISeatKey {
  side: LeftOrRight;
  /** Zero-based position among the players currently on the floor, in the room's own order. */
  seat: number;
}

/** Which seat a physical key addresses, or null if it addresses none. */
export function seatForCode(code: string): ISeatKey | null {
  for (const side of ['left', 'right'] as LeftOrRight[]) {
    const seat = seatKeyCodes[side].indexOf(code);
    if (seat >= 0) return { side, seat };
  }
  return null;
}

/** The four roles a seat key can play. */
export type RulingRole = 'normal' | 'power' | 'neg' | 'no-penalty';

/**
 * Which role a keystroke is asking for, or null when the combination is not part of the layout.
 *
 * Exactly one modifier, and never two. `Shift+Alt+A` is not a third ruling, it is a scorekeeper
 * fumbling, and the safe response to a fumble is to record nothing.
 */
export function roleForModifiers(event: {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): RulingRole | null {
  // Meta is never part of this layout: it belongs to the browser and the operating system, and
  // Cmd+A is Select All in every room in the country.
  if (event.metaKey) return null;
  const held = [event.shiftKey, event.altKey, event.ctrlKey].filter(Boolean).length;
  if (held > 1) return null;
  if (held === 0) return 'normal';
  if (event.shiftKey) return 'power';
  if (event.altKey) return 'neg';
  return 'no-penalty';
}

/** What a role resolves to against a live format and the state of the current tossup. */
export type SeatRuling =
  | { kind: 'buzz'; answerType: IScorekeeperAnswerType }
  /** A wrong answer that costs nothing. The zero button beside the values. */
  | { kind: 'no-penalty' };

/**
 * What this role means right now, or null when it means nothing.
 *
 * `negsAvailable` is the same flag the buttons use, so Alt is live exactly when the −5 button is on
 * screen and dead exactly when it is not.
 */
export function rulingForRole(
  format: IScorekeeperFormat,
  role: RulingRole,
  negsAvailable: boolean,
): SeatRuling | null {
  if (role === 'no-penalty') return { kind: 'no-penalty' };
  if (role === 'normal') {
    const answerType = normalCorrect(format);
    return answerType ? { kind: 'buzz', answerType } : null;
  }
  if (role === 'power') {
    const answerType = powerCorrect(format);
    return answerType ? { kind: 'buzz', answerType } : null;
  }
  if (!negsAvailable) return null;
  const answerType = negRuling(format);
  return answerType ? { kind: 'buzz', answerType } : null;
}

export interface IKeyLegendEntry {
  /** `A`, `Shift+A`, `1`. What a person reads. */
  keys: string;
  /** `+10`, `−5`, `0`, `20`. Derived from the format, never written down here. */
  meaning: string;
  /** False when this row is part of the layout but has nothing behind it in this format. */
  available: boolean;
}

/**
 * The modifier legend for one seat, in a fixed order so the shape is the same on every screen.
 *
 * Built for one representative key rather than all eight, because eight copies of the same four lines
 * is not a legend, it is a wall. The map names the seat keys once and the modifiers once.
 */
export function modifierLegend(format: IScorekeeperFormat, negsAvailable: boolean): IKeyLegendEntry[] {
  const normal = normalCorrect(format);
  const power = powerCorrect(format);
  const neg = negRuling(format);
  return [
    {
      keys: 'seat',
      meaning: normal ? rulingLabel(normal) : 'no correct answer in this format',
      available: normal !== null,
    },
    {
      keys: 'Shift + seat',
      meaning: power ? rulingLabel(power) : 'no power in this format',
      available: power !== null,
    },
    {
      keys: 'Alt + seat',
      meaning: neg ? rulingLabel(neg) : 'no penalty in this format',
      available: neg !== null && negsAvailable,
    },
    { keys: 'Ctrl + seat', meaning: '0, wrong with no penalty', available: true },
  ];
}

/**
 * Which digit picks which bonus total.
 *
 * Left to right across the choices already on screen, which is the only mapping that needs no learning:
 * the third button is `3`. The values come from the caller, which got them from the format — nothing
 * here assumes a bonus is worth thirty or comes in three parts.
 *
 * Capped at nine because there is no `0` key in a left-to-right count that starts at one, and a bonus
 * with ten distinct totals is one the buttons should be used for.
 */
export function bonusKeyLegend(options: readonly number[]): IKeyLegendEntry[] {
  return options.slice(0, 9).map((points, index) => ({
    keys: String(index + 1),
    meaning: String(points),
    available: true,
  }));
}

/** Which option a digit key selects, or null when that digit addresses nothing on screen. */
export function bonusOptionForCode(code: string, options: readonly number[]): number | null {
  const match = /^Digit([1-9])$/.exec(code);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return index < options.length ? options[index] : null;
}

/**
 * Whether this keystroke belongs to whatever it landed on rather than to the scoresheet.
 *
 * The single most important function in the feature. A scorekeeper typing a player's name into the
 * Players dialog must not score four tossups doing it, and somebody typing a bonus total into a number
 * field must not have the digits stolen by a bonus shortcut.
 *
 * Stricter than the check the Space and undo shortcuts used before this existed, and now shared with
 * them, so there is one answer to "is the keyboard aimed at something else" rather than two:
 *
 *   - the obvious form controls, including `contenteditable`, which the old check missed entirely;
 *   - anything with a text-entry or list-selection role, where printable keys are the control's own —
 *     a combobox filters on them;
 *   - anything inside a dialog, ours or the platform's;
 *   - and, whatever the event says it landed on, an *open* `<dialog>` anywhere in the document.
 *
 * That last one is the belt-and-braces case: a modal is open, so nothing behind it is being aimed at,
 * regardless of what has focus. It is also what makes this safe when focus is on `document.body`,
 * which is where it sits after a dialog opens programmatically.
 */
const controlSelector = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="spinbutton"]',
  '[role="slider"]',
  'dialog',
].join(', ');

/**
 * Things the platform activates with Space or Enter.
 *
 * Separate from the list above, because the two need different answers and conflating them is a bug in
 * both directions. A focused button does not consume the letter `D`, so blocking seat keys while one has
 * focus would break the ordinary mixed workflow — click a substitution, then keep scoring on the
 * keyboard — for no safety gained. But it very much does consume Space, and stealing that would score
 * one thing while the scorekeeper pressed another.
 */
const activationSelector = 'button, a[href], summary, [role="button"], [role="link"], [role="tab"]';

function matches(element: unknown, selector: string): boolean {
  return element instanceof Element && element.closest(selector) !== null;
}

export function keystrokeBelongsToControl(event: KeyboardEvent, root: Document = document): boolean {
  // A keydown can be dispatched at something that is not an element — the document itself, for one —
  // and reaching straight for closest() on that throws out of a listener the whole scoring screen
  // depends on. Ask whether there is an element before asking it anything.
  if (matches(event.target, controlSelector) || matches(root.activeElement, controlSelector)) return true;
  // Any modal open anywhere means the scoresheet is not what is being typed at, whatever has focus.
  // This is the case that holds when focus is on `document.body`, which is where it sits after a dialog
  // has been opened programmatically.
  return root.querySelector('dialog[open]') !== null;
}

/**
 * Whether a Space or Enter belongs to something focused rather than to the scoresheet.
 *
 * Checked *in addition* to `keystrokeBelongsToControl` for those two keys only. This is the safeguard
 * the Space shortcut has always had, kept exactly as it was.
 */
export function activationKeyBelongsToControl(event: KeyboardEvent, root: Document = document): boolean {
  return matches(event.target, activationSelector) || matches(root.activeElement, activationSelector);
}
