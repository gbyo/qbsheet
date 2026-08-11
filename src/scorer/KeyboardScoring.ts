/**
 * The keyboard layer: numeric seats, two-key rulings, and the rules about when a key means nothing.
 *
 * Seats are global rather than team-local: 1–4 are the left team's seats and 5–8 are the right
 * team's seats. A tossup ruling is then a short sequence — for example `1` then `P` for a power by
 * the first left player, or `5` then `C` for an ordinary correct answer by the first right player.
 * Keeping the action separate from the seat makes the layout easy to remember and leaves the number
 * row available for the team-to-seat mapping the scorekeeper is already watching.
 *
 * No ruling is hard-coded here. The action keys are resolved through `tossupRulings`, so the live
 * format decides what ordinary correct, power, and neg mean. A format with an unavailable action
 * simply leaves that action dead; it never silently falls back to another value.
 */
import { LeftOrRight } from '../scoring/types';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { negRuling, normalCorrect, powerCorrect, rulingLabel } from './tossupRulings';

/** How many seats the layout can address per side. Beyond this, the buttons are the only way. */
export const keyboardSeatCount = 4;

/** The global numbers printed in the keyboard map, parallel to each side's seat order. */
export const keyboardSeatNumbers: Record<LeftOrRight, readonly number[]> = {
  left: [1, 2, 3, 4],
  right: [5, 6, 7, 8],
};

/** Shortcut labels shared by the live map, the keyboard drill, and guided-practice hints. */
export const keyboardShortcutLabels = {
  noBuzz: 'Space',
  undo: 'Ctrl/⌘ + Z',
  /** Bound by the same listener as undo, with Shift held. See `useScorerKeyboard`. */
  redo: 'Ctrl/⌘ + Shift + Z',
} as const;

/** The second key in a tossup sequence. `0` records a wrong answer with no penalty. */
export const keyboardActionLabels = {
  correct: 'C',
  power: 'P',
  neg: 'N',
  wrong: '0',
} as const;

export type KeyboardAction = keyof typeof keyboardActionLabels;

/**
 * What each action is called when it is read back to the scorekeeper.
 *
 * A name, never a value. "Power" is what P means in every format; what a power is *worth* comes from
 * the format and is appended by the caller, so this table stays true for a tournament whose power is
 * 20 and for one that has no power at all.
 */
export const keyboardActionNames: Record<KeyboardAction, string> = {
  correct: 'Correct',
  power: 'Power',
  neg: 'Neg',
  wrong: 'Wrong',
};

export interface ISeatKey {
  side: LeftOrRight;
  /** Zero-based position among the players currently on the floor, in the room's own order. */
  seat: number;
  /** The global number a scorekeeper presses to select this seat. */
  number: number;
}

/** Which seat a global number addresses, or null if it addresses none. */
export function seatForNumber(value: string | number): ISeatKey | null {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > keyboardSeatCount * 2) return null;

  if (number <= keyboardSeatCount) {
    return { side: 'left', seat: number - 1, number };
  }
  return { side: 'right', seat: number - keyboardSeatCount - 1, number };
}

/** Read a physical number-row or numpad key as a global seat number. */
export function numberForCode(code: string): number | null {
  const match = /^(?:Digit|Numpad)([1-8])$/.exec(code);
  return match ? Number(match[1]) : null;
}

/** Read the action key that completes a tossup sequence. */
export function actionForKey(key: string): KeyboardAction | null {
  switch (key.toLowerCase()) {
    case 'c':
      return 'correct';
    case 'p':
      return 'power';
    case 'n':
      return 'neg';
    case '0':
      return 'wrong';
    default:
      return null;
  }
}

/** What an action resolves to against a live format and the state of the current tossup. */
export type SeatRuling = { kind: 'buzz'; answerType: IScorekeeperAnswerType };

export function rulingForAction(
  format: IScorekeeperFormat,
  action: Exclude<KeyboardAction, 'wrong'>,
  negsAvailable: boolean,
): SeatRuling | null {
  if (action === 'correct') {
    const answerType = normalCorrect(format);
    return answerType ? { kind: 'buzz', answerType } : null;
  }
  if (action === 'power') {
    const answerType = powerCorrect(format);
    return answerType ? { kind: 'buzz', answerType } : null;
  }
  if (!negsAvailable) return null;
  const answerType = negRuling(format);
  return answerType ? { kind: 'buzz', answerType } : null;
}

/**
 * The action keys that would land right now, for the prompt shown while a seat is waiting.
 *
 * Drawn from the same resolution the keystroke itself uses, so the prompt cannot offer a key that
 * does nothing. A format with no power leaves P out of the prompt rather than listing it and then
 * swallowing it.
 */
export function availableActionKeys(format: IScorekeeperFormat, negsAvailable: boolean): string[] {
  const scoring: Exclude<KeyboardAction, 'wrong'>[] = ['correct', 'power', 'neg'];
  const keys = scoring
    .filter((action) => rulingForAction(format, action, negsAvailable) !== null)
    .map((action) => keyboardActionLabels[action]);
  // Wrong-with-no-penalty needs nothing from the format: every format can record a used chance.
  return [...keys, keyboardActionLabels.wrong];
}

export interface IKeyLegendEntry {
  /** What a person reads in the keyboard map. */
  keys: string;
  /** Derived from the format, never written down as a fixed point value. */
  meaning: string;
  /** False when this row is part of the layout but has nothing behind it in this format. */
  available: boolean;
}

/** The action legend for one seat, in a fixed order so the shape is the same on every screen. */
export function sequenceLegend(format: IScorekeeperFormat, negsAvailable: boolean): IKeyLegendEntry[] {
  const normal = normalCorrect(format);
  const power = powerCorrect(format);
  const neg = negRuling(format);
  return [
    {
      keys: `seat → ${keyboardActionLabels.correct}`,
      meaning: normal ? rulingLabel(normal) : 'no correct answer in this format',
      available: normal !== null,
    },
    {
      keys: `seat → ${keyboardActionLabels.power}`,
      meaning: power ? rulingLabel(power) : 'no power in this format',
      available: power !== null,
    },
    {
      keys: `seat → ${keyboardActionLabels.neg}`,
      meaning: neg ? rulingLabel(neg) : 'no penalty in this format',
      available: neg !== null && negsAvailable,
    },
    {
      keys: `seat → ${keyboardActionLabels.wrong}`,
      meaning: 'wrong · 0',
      available: true,
    },
  ];
}

/**
 * Which digit picks which bonus total.
 *
 * The digit is the position in the row counted from zero — which, for the totals a regular bonus can be
 * worth, is the number of parts it got. The moderator says "two parts" or "twenty", and either way the key
 * is 2. Counting from one instead put nothing under `0` and made `1` mean a bonus that scored nothing,
 * which is the one value on the row a scorekeeper would never look for under a key that says one.
 *
 * It also means the digits are the same shape as the parts: a three-part bonus uses 0 to 3 and stops,
 * rather than 1 to 4 with the top of the range moving whenever the format does.
 */
export function bonusKeyLegend(options: readonly number[]): IKeyLegendEntry[] {
  return options.slice(0, 10).map((points, index) => ({
    keys: String(index),
    meaning: String(points),
    available: true,
  }));
}

/** Which option a digit key selects, or null when that digit addresses nothing on screen. */
export function bonusOptionForCode(code: string, options: readonly number[]): number | null {
  const match = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (!match) return null;
  const index = Number(match[1]);
  return index < options.length ? options[index] : null;
}

/**
 * Whether this keystroke belongs to whatever it landed on rather than to the scoresheet.
 *
 * A scorekeeper typing in a dialog or number field must not score a tossup. The same guard is shared
 * by the tossup and bonus listeners, so printable keys have one consistent answer about ownership.
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

const activationSelector = 'button, a[href], summary, [role="button"], [role="link"], [role="tab"]';

function matches(element: unknown, selector: string): boolean {
  return element instanceof Element && element.closest(selector) !== null;
}

export function keystrokeBelongsToControl(event: KeyboardEvent, root: Document = document): boolean {
  if (matches(event.target, controlSelector) || matches(root.activeElement, controlSelector)) return true;
  return root.querySelector('dialog[open]') !== null;
}

/** Whether Space or Enter belongs to a focused control rather than to the scoresheet. */
export function activationKeyBelongsToControl(event: KeyboardEvent, root: Document = document): boolean {
  return matches(event.target, activationSelector) || matches(root.activeElement, activationSelector);
}
