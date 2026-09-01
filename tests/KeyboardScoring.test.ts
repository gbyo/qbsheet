/**
 * The keyboard model: numeric seats, two-key actions, derived meanings, and the combinations that
 * mean nothing.
 */
import { describe, expect, test } from 'vitest';
import {
  actionForKey,
  availableActionKeys,
  bonusKeyLegend,
  bonusOptionForCode,
  keyboardActionLabels,
  keyboardSeatCount,
  keyboardSeatNumbers,
  numberForCode,
  rulingForAction,
  seatForNumber,
  sequenceLegend,
} from '../src/scorer/KeyboardScoring';
import { negRuling, normalCorrect, powerCorrect, unreachableAnswerTypes } from '../src/scorer/tossupRulings';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import { validPackage } from './packages';

function answerType(
  overrides: Partial<IScorekeeperAnswerType> & { index: number; value: number },
): IScorekeeperAnswerType {
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

const powersFormat = formatWith([
  answerType({ index: 0, value: 15 }),
  answerType({ index: 1, value: 10 }),
  answerType({ index: 2, value: -5 }),
]);

const flatFormat = formatWith([answerType({ index: 0, value: 10 }), answerType({ index: 1, value: -5 })]);

const oddFormat = formatWith([
  answerType({ index: 0, value: 30, label: 'Super', shortLabel: 'S' }),
  answerType({ index: 1, value: 25 }),
  answerType({ index: 2, value: 20 }),
  answerType({ index: 3, value: -10 }),
]);

describe('the numeric seat layout', () => {
  test('numbers 1–4 address the left seats and 5–8 address the right seats', () => {
    expect(seatForNumber(1)).toEqual({ side: 'left', seat: 0, number: 1 });
    expect(seatForNumber(4)).toEqual({ side: 'left', seat: 3, number: 4 });
    expect(seatForNumber(5)).toEqual({ side: 'right', seat: 0, number: 5 });
    expect(seatForNumber(8)).toEqual({ side: 'right', seat: 3, number: 8 });
  });

  test('number-row and numpad codes address the same seats', () => {
    expect(numberForCode('Digit1')).toBe(1);
    expect(numberForCode('Numpad5')).toBe(5);
    expect(seatForNumber(numberForCode('Digit5')!)).toEqual({ side: 'right', seat: 0, number: 5 });
  });

  test('nothing outside 1–8 addresses a seat', () => {
    for (const value of [0, 9, -1, 1.5, '0', '9', 'x']) expect(seatForNumber(value)).toBeNull();
    for (const code of ['Digit0', 'Digit9', 'KeyA', 'Space', 'Numpad0'])
      expect(numberForCode(code)).toBeNull();
  });

  test('the map exposes four global numbers per side', () => {
    expect(keyboardSeatCount).toBe(4);
    expect(keyboardSeatNumbers).toEqual({ left: [1, 2, 3, 4], right: [5, 6, 7, 8] });
  });
});

describe('the action key', () => {
  test('C, P, N, and 0 are the four actions', () => {
    expect(actionForKey('c')).toBe('correct');
    expect(actionForKey('P')).toBe('power');
    expect(actionForKey('n')).toBe('neg');
    expect(actionForKey('0')).toBe('wrong');
    expect(Object.values(keyboardActionLabels)).toEqual(['C', 'P', 'N', '0']);
  });

  test('other keys are not actions', () => {
    expect(actionForKey('a')).toBeNull();
    expect(actionForKey('1')).toBeNull();
    expect(actionForKey(' ')).toBeNull();
  });
});

describe('what an action means, according to the format', () => {
  test('C is the cheapest positive answer', () => {
    expect(rulingForAction(powersFormat, 'correct', true)).toEqual({
      kind: 'buzz',
      answerType: expect.objectContaining({ value: 10 }),
    });
    expect(rulingForAction(flatFormat, 'correct', true)).toEqual({
      kind: 'buzz',
      answerType: expect.objectContaining({ value: 10 }),
    });
    // This format's base answer has the power flag set; the action still means ordinary correct.
    expect(rulingForAction(oddFormat, 'correct', true)).toEqual({
      kind: 'buzz',
      answerType: expect.objectContaining({ value: 20 }),
    });
  });

  test('P is the dearest positive answer when there is a choice', () => {
    expect(rulingForAction(powersFormat, 'power', true)).toEqual({
      kind: 'buzz',
      answerType: expect.objectContaining({ value: 15 }),
    });
    expect(rulingForAction(oddFormat, 'power', true)).toEqual({
      kind: 'buzz',
      answerType: expect.objectContaining({ value: 30 }),
    });
  });

  test('P does nothing when the format has no power', () => {
    expect(powerCorrect(flatFormat)).toBeNull();
    expect(rulingForAction(flatFormat, 'power', true)).toBeNull();
  });

  test('N uses the format penalty and respects tossup eligibility', () => {
    expect(rulingForAction(powersFormat, 'neg', true)).toEqual({
      kind: 'buzz',
      answerType: expect.objectContaining({ value: -5 }),
    });
    expect(rulingForAction(oddFormat, 'neg', true)).toEqual({
      kind: 'buzz',
      answerType: expect.objectContaining({ value: -10 }),
    });
    expect(rulingForAction(powersFormat, 'neg', false)).toBeNull();
  });

  test('a format with no positive or negative answer does not guess', () => {
    const noNegs = formatWith([answerType({ index: 0, value: 10 })]);
    const broken = formatWith([answerType({ index: 0, value: -5 })]);
    expect(negRuling(noNegs)).toBeNull();
    expect(rulingForAction(noNegs, 'neg', true)).toBeNull();
    expect(normalCorrect(broken)).toBeNull();
    expect(rulingForAction(broken, 'correct', true)).toBeNull();
  });
});

describe('rulings this layout cannot reach', () => {
  test('a middle tier is left to the buttons and reported', () => {
    expect(unreachableAnswerTypes(oddFormat).map((type) => type.value)).toEqual([25]);
  });

  test('an ordinary format leaves nothing behind', () => {
    expect(unreachableAnswerTypes(powersFormat)).toEqual([]);
    expect(unreachableAnswerTypes(flatFormat)).toEqual([]);
  });
});

describe('the sequence legend', () => {
  test('says the format values and includes the wrong action', () => {
    const rows = sequenceLegend(oddFormat, true);

    expect(rows.map((row) => row.meaning)).toEqual(['+20', 'S', '−10', 'wrong, no penalty · 0']);
    expect(rows.map((row) => row.keys)).toEqual(['seat → C', 'seat → P', 'seat → N', 'seat → 0']);
  });

  test('marks unavailable actions rather than hiding them', () => {
    const rows = sequenceLegend(flatFormat, false);

    expect(rows.find((row) => row.keys === 'seat → P')?.available).toBe(false);
    expect(rows.find((row) => row.keys === 'seat → P')?.meaning).toBe('no power in this format');
    expect(rows.find((row) => row.keys === 'seat → N')?.available).toBe(false);
    expect(rows.find((row) => row.keys === 'seat → 0')?.available).toBe(true);
  });
});

describe('the keys offered to a seat that is waiting', () => {
  // The legend keeps unavailable rows and strikes them through, because it is a reference to the whole
  // layout. This prompt is the opposite: it is offered mid-sequence, and a key it lists that then does
  // nothing is worse than one it never mentioned.
  test('every action a format can pay for', () => {
    expect(availableActionKeys(powersFormat, true)).toEqual(['C', 'P', 'N', '0']);
  });

  test('a format with no power does not offer P', () => {
    expect(availableActionKeys(flatFormat, true)).toEqual(['C', 'N', '0']);
  });

  test('a tossup nobody can neg on does not offer N', () => {
    expect(availableActionKeys(powersFormat, false)).toEqual(['C', 'P', '0']);
  });

  test('the wrong answer is always offered — it costs the format nothing', () => {
    expect(availableActionKeys(flatFormat, false)).toEqual(['C', '0']);
  });
});

describe('bonus digits', () => {
  test('the digit is the number of parts, so nothing scored is 0 and not 1', () => {
    expect(bonusKeyLegend([0, 10, 20, 30]).map((row) => `${row.keys}=${row.meaning}`)).toEqual([
      '0=0',
      '1=10',
      '2=20',
      '3=30',
    ]);
  });

  test('the values come from the caller, not from an assumption about thirty', () => {
    expect(bonusKeyLegend([0, 5, 10, 15, 20]).map((row) => row.meaning)).toEqual([
      '0',
      '5',
      '10',
      '15',
      '20',
    ]);
    // A five-point part renumbers itself: four parts converted is still the key 4.
    expect(bonusKeyLegend([0, 5, 10, 15, 20]).map((row) => row.keys)).toEqual(['0', '1', '2', '3', '4']);
  });

  test('a number-row or numpad digit selects the option in that position', () => {
    const options = [0, 10, 20, 30];

    expect(bonusOptionForCode('Digit0', options)).toBe(0);
    expect(bonusOptionForCode('Numpad2', options)).toBe(20);
    expect(bonusOptionForCode('Digit3', options)).toBe(30);
  });

  test('a digit past the end, or a non-digit, addresses nothing', () => {
    expect(bonusOptionForCode('Digit4', [0, 10, 20, 30])).toBeNull();
    expect(bonusOptionForCode('Digit9', [0, 10, 20, 30])).toBeNull();
    expect(bonusOptionForCode('KeyA', [0, 10])).toBeNull();
    expect(bonusOptionForCode('Digit2', [0, 10])).toBeNull();
  });

  test('more than ten choices leaves the rest on the buttons', () => {
    const many = Array.from({ length: 15 }, (_value, index) => index);

    expect(bonusKeyLegend(many)).toHaveLength(10);
    expect(bonusOptionForCode('Digit9', many)).toBe(9);
  });
});
