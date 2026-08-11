/**
 * The keyboard model: fixed keys, derived meanings, and the combinations that mean nothing.
 *
 * The thing most worth pinning here is that no ruling is written down. A layout that hard-coded +15 and
 * −5 would work perfectly at every NAQT tournament and record the wrong score at the first one using
 * anything else, and it would do it silently. So most of what follows drives the same functions with
 * three deliberately different formats and asserts that the *format* decided.
 */
import { describe, expect, test } from 'vitest';
import {
  bonusKeyLegend,
  bonusOptionForCode,
  keyboardSeatCount,
  modifierLegend,
  roleForModifiers,
  rulingForRole,
  seatForCode,
  seatKeyCodes,
  seatKeyLabels,
} from '../src/scorer/KeyboardScoring';
import { negRuling, normalCorrect, powerCorrect, unreachableAnswerTypes } from '../src/scorer/tossupRulings';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import { validPackage } from './packages';

function answerType(overrides: Partial<IScorekeeperAnswerType> & { index: number; value: number }): IScorekeeperAnswerType {
  return {
    label: String(overrides.value),
    shortLabel: String(overrides.value),
    isPower: overrides.value > 10,
    isNeg: overrides.value < 0,
    awardsBonus: overrides.value > 0,
    qbjId: `AnswerType_${overrides.value}`,
    ...overrides,
  };
}

/** A format with only the answer types given, and everything else from the real fixture. */
function formatWith(values: IScorekeeperAnswerType[]): IScorekeeperFormat {
  return { ...validPackage().scorekeeperFormat, answerTypes: values };
}

/** Powers, tens, negs. The common case. */
const powersFormat = formatWith([
  answerType({ index: 0, value: 15 }),
  answerType({ index: 1, value: 10 }),
  answerType({ index: 2, value: -5 }),
]);

/** No power at all, which is most of the format space outside NAQT rules. */
const flatFormat = formatWith([answerType({ index: 0, value: 10 }), answerType({ index: 1, value: -5 })]);

/**
 * A deliberately nonstandard tournament: a base tossup worth 20, a 30-point power, a −10 penalty, and a
 * middle tier at 25 that this layout has no room for.
 *
 * The 20 matters most. `isPower` is documented as being exactly `value > 10`, so this format's *base*
 * answer has the power flag set. A layout that bound Shift to `isPower` would leave the unmodified key
 * with nothing and put the ordinary correct answer behind a modifier.
 */
const oddFormat = formatWith([
  answerType({ index: 0, value: 30, label: 'Super', shortLabel: 'S' }),
  answerType({ index: 1, value: 25 }),
  answerType({ index: 2, value: 20 }),
  answerType({ index: 3, value: -10 }),
]);

describe('the seat layout', () => {
  test('all eight keys address the seats they are printed on', () => {
    expect(seatForCode('KeyA')).toEqual({ side: 'left', seat: 0 });
    expect(seatForCode('KeyS')).toEqual({ side: 'left', seat: 1 });
    expect(seatForCode('KeyD')).toEqual({ side: 'left', seat: 2 });
    expect(seatForCode('KeyF')).toEqual({ side: 'left', seat: 3 });
    expect(seatForCode('KeyJ')).toEqual({ side: 'right', seat: 0 });
    expect(seatForCode('KeyK')).toEqual({ side: 'right', seat: 1 });
    expect(seatForCode('KeyL')).toEqual({ side: 'right', seat: 2 });
    expect(seatForCode('Semicolon')).toEqual({ side: 'right', seat: 3 });
  });

  test('the printed labels stay paired with the physical codes for each seat', () => {
    const pairings = [
      ['left', 0, 'KeyA', 'A'],
      ['left', 1, 'KeyS', 'S'],
      ['left', 2, 'KeyD', 'D'],
      ['left', 3, 'KeyF', 'F'],
      ['right', 0, 'KeyJ', 'J'],
      ['right', 1, 'KeyK', 'K'],
      ['right', 2, 'KeyL', 'L'],
      ['right', 3, 'Semicolon', ';'],
    ] as const;

    for (const [side, seat, code, label] of pairings) {
      expect(seatKeyCodes[side][seat]).toBe(code);
      expect(seatKeyLabels[side][seat]).toBe(label);
      expect(seatForCode(code)).toEqual({ side, seat });
    }
  });

  test('nothing else addresses a seat', () => {
    for (const code of ['KeyG', 'KeyH', 'KeyQ', 'Digit1', 'Space', 'Enter', 'Quote', 'Comma']) {
      expect(seatForCode(code), code).toBeNull();
    }
  });

  test('the layout covers four seats a side and says so', () => {
    expect(keyboardSeatCount).toBe(4);
    expect(seatKeyCodes.left).toHaveLength(keyboardSeatCount);
    expect(seatKeyCodes.right).toHaveLength(keyboardSeatCount);
    // The printed labels stay parallel to the codes, which is what the legend renders.
    expect(seatKeyLabels.left).toHaveLength(seatKeyCodes.left.length);
    expect(seatKeyLabels.right).toHaveLength(seatKeyCodes.right.length);
  });

  test('the two hands do not overlap', () => {
    const all = [...seatKeyCodes.left, ...seatKeyCodes.right];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('which role a keystroke asks for', () => {
  const held = (modifiers: Partial<Record<'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey', boolean>>) =>
    roleForModifiers({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...modifiers });

  test('bare is the ordinary correct answer', () => {
    expect(held({})).toBe('normal');
  });

  test('Shift is the power, Alt is the penalty, and Ctrl is not a seat modifier', () => {
    expect(held({ shiftKey: true })).toBe('power');
    expect(held({ altKey: true })).toBe('neg');
    expect(held({ ctrlKey: true })).toBeNull();
  });

  test('two modifiers at once is a fumble, and a fumble records nothing', () => {
    expect(held({ shiftKey: true, altKey: true })).toBeNull();
    expect(held({ ctrlKey: true, shiftKey: true })).toBeNull();
    expect(held({ altKey: true, ctrlKey: true })).toBeNull();
  });

  test('Meta is never part of the layout, because Cmd+A is Select All', () => {
    expect(held({ metaKey: true })).toBeNull();
    expect(held({ metaKey: true, shiftKey: true })).toBeNull();
  });
});

describe('what a role means, according to the format', () => {
  test('the ordinary correct answer is the cheapest positive one', () => {
    expect(rulingForRole(powersFormat, 'normal', true)).toEqual({ kind: 'buzz', answerType: expect.objectContaining({ value: 10 }) });
    expect(rulingForRole(flatFormat, 'normal', true)).toEqual({ kind: 'buzz', answerType: expect.objectContaining({ value: 10 }) });
    // The case that breaks an `isPower`-based layout: this format's base answer has the flag set.
    expect(rulingForRole(oddFormat, 'normal', true)).toEqual({ kind: 'buzz', answerType: expect.objectContaining({ value: 20 }) });
  });

  test('the power is the dearest positive one, when there is a choice', () => {
    expect(rulingForRole(powersFormat, 'power', true)).toEqual({ kind: 'buzz', answerType: expect.objectContaining({ value: 15 }) });
    expect(rulingForRole(oddFormat, 'power', true)).toEqual({ kind: 'buzz', answerType: expect.objectContaining({ value: 30 }) });
  });

  test('a format with one correct answer has no power, and Shift does nothing', () => {
    // Not an alias for the unmodified key. A keyboard that records +10 for a power this format does not
    // have is a keyboard that has scored the wrong thing.
    expect(powerCorrect(flatFormat)).toBeNull();
    expect(rulingForRole(flatFormat, 'power', true)).toBeNull();
  });

  test('the penalty comes from the format, whatever it is worth', () => {
    expect(rulingForRole(powersFormat, 'neg', true)).toEqual({ kind: 'buzz', answerType: expect.objectContaining({ value: -5 }) });
    expect(rulingForRole(oddFormat, 'neg', true)).toEqual({ kind: 'buzz', answerType: expect.objectContaining({ value: -10 }) });
  });

  test('Alt does nothing once a neg is no longer a legal ruling', () => {
    // The same condition that removes the −5 button: somebody has answered, so the question has been
    // read out and nobody can be penalized on it.
    expect(rulingForRole(powersFormat, 'neg', false)).toBeNull();
  });

  test('a format with no penalty at all leaves Alt dead', () => {
    const noNegs = formatWith([answerType({ index: 0, value: 10 })]);

    expect(negRuling(noNegs)).toBeNull();
    expect(rulingForRole(noNegs, 'neg', true)).toBeNull();
  });

  test('a format with no positive answer cannot be scored, and says so rather than guessing', () => {
    const broken = formatWith([answerType({ index: 0, value: -5 })]);

    expect(normalCorrect(broken)).toBeNull();
    expect(rulingForRole(broken, 'normal', true)).toBeNull();
  });
});

describe('rulings this layout cannot reach', () => {
  test('a middle tier is left to the buttons and reported', () => {
    // Three seat rulings is the layout. Inventing Ctrl+Alt+Shift+D for a third positive tier would
    // produce something nobody can use at speed.
    expect(unreachableAnswerTypes(oddFormat).map((type) => type.value)).toEqual([25]);
  });

  test('an ordinary format leaves nothing behind', () => {
    expect(unreachableAnswerTypes(powersFormat)).toEqual([]);
    expect(unreachableAnswerTypes(flatFormat)).toEqual([]);
  });
});

describe('the legend', () => {
  test('says the format’s real values, not +15 and −5', () => {
    const rows = modifierLegend(oddFormat, true);

    expect(rows.map((row) => row.meaning)).toEqual([
      '+20',
      'S',
      '−10',
    ]);
    expect(rows.some((row) => row.keys === 'Ctrl + seat')).toBe(false);
  });

  test('marks a modifier unavailable rather than hiding it', () => {
    // The shape of the legend stays the same between formats, so somebody who reaches for Shift learns
    // why it did nothing instead of wondering whether they mistyped.
    const rows = modifierLegend(flatFormat, true);
    const shift = rows.find((row) => row.keys === 'Shift + seat');

    expect(shift?.available).toBe(false);
    expect(shift?.meaning).toBe('no power in this format');
  });

  test('marks the penalty unavailable once a neg is illegal on this tossup', () => {
    const rows = modifierLegend(powersFormat, false);

    expect(rows.find((row) => row.keys === 'Alt + seat')?.available).toBe(false);
  });
});

describe('bonus digits', () => {
  test('the choices are numbered left to right from one', () => {
    expect(bonusKeyLegend([0, 10, 20, 30]).map((row) => `${row.keys}=${row.meaning}`)).toEqual([
      '1=0',
      '2=10',
      '3=20',
      '4=30',
    ]);
  });

  test('the values come from the caller, not from an assumption about thirty', () => {
    // A five-point-a-part bonus over four parts.
    expect(bonusKeyLegend([0, 5, 10, 15, 20]).map((row) => row.meaning)).toEqual(['0', '5', '10', '15', '20']);
  });

  test('a digit selects the option in that position', () => {
    const options = [0, 10, 20, 30];

    expect(bonusOptionForCode('Digit1', options)).toBe(0);
    expect(bonusOptionForCode('Digit3', options)).toBe(20);
    expect(bonusOptionForCode('Digit4', options)).toBe(30);
  });

  test('a digit past the end of the choices addresses nothing', () => {
    expect(bonusOptionForCode('Digit9', [0, 10, 20, 30])).toBeNull();
  });

  test('anything that is not a digit addresses nothing', () => {
    expect(bonusOptionForCode('KeyA', [0, 10])).toBeNull();
    expect(bonusOptionForCode('Digit0', [0, 10])).toBeNull();
  });

  test('more than nine choices leaves the rest on the buttons', () => {
    const many = Array.from({ length: 15 }, (_value, index) => index);

    expect(bonusKeyLegend(many)).toHaveLength(9);
    expect(bonusOptionForCode('Digit9', many)).toBe(8);
  });
});
