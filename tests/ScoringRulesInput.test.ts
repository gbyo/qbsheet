/**
 * The wrapper that lets one screen hold either form of scoring rules.
 *
 * # Why the reader matters more than it looks
 *
 * Drafts and presets are already on devices, stored as the basic form's bare fields. The wrapper is a
 * new shape around them, so every one of those stored values has to keep loading — a coach whose
 * half-typed practice setup vanished on upgrade would reasonably conclude the autosave does not work.
 * That is what most of this file is about.
 *
 * # And that converting between forms cannot change a score
 *
 * The other claim is that moving between the two forms is either lossless or refused. Basic to
 * advanced always works. Advanced to basic works only for a format the basic fields can state, and the
 * proof that it worked is that both produce the same `IScorekeeperFormat` — not that the fields look
 * similar.
 */
import { describe, expect, test } from 'vitest';
import {
  IBasicScoringRulesInput,
  basicScoringRulesDefaults,
  basicScorekeeperFormat,
} from '../src/qbj/BasicScoringRules';
import {
  advancedFitsBasicForm,
  advancedFromBasic,
  advancedScorekeeperFormat,
  advancedScoringRulesProblems,
  basicFromAdvanced,
  newAdvancedAnswerType,
} from '../src/qbj/AdvancedScoringRules';
import {
  advancedRulesInput,
  basicRulesInput,
  readScoringRulesInput,
  scoringRulesInputAs,
  scoringRulesInputFormat,
  scoringRulesInputIsTimed,
  scoringRulesInputProblems,
  scoringRulesInputTossupCount,
} from '../src/qbj/ScoringRulesInput';

const basic = (overrides: Partial<IBasicScoringRulesInput> = {}): IBasicScoringRulesInput => ({
  ...basicScoringRulesDefaults,
  ...overrides,
});

describe('reading rules that were already stored', () => {
  test('the pre-advanced shape — the basic fields, bare — still loads', () => {
    const stored = { ...basicScoringRulesDefaults, tossupValue: 10, powerValue: 15, negValue: -5 };

    const read = readScoringRulesInput(JSON.parse(JSON.stringify(stored)));
    expect(read).toEqual(basicRulesInput(stored));
  });

  test('a bare stored value missing fields this build added is filled from the defaults', () => {
    // What a draft written by an older build looks like: no overtime or lightning fields at all.
    const read = readScoringRulesInput({ tossupValue: 10, useBonuses: true, tossupCount: 24 });

    expect(read?.mode).toBe('basic');
    expect(read).toEqual(basicRulesInput(basic({ tossupCount: 24 })));
  });

  test('a wrapped basic value round-trips', () => {
    const input = basicRulesInput(basic({ tossupCount: 24 }));

    expect(readScoringRulesInput(JSON.parse(JSON.stringify(input)))).toEqual(input);
  });

  test('a wrapped advanced value round-trips, keeping its answer types', () => {
    const input = advancedRulesInput({
      ...advancedFromBasic(basicScoringRulesDefaults),
      answerTypes: [
        newAdvancedAnswerType({ value: 20, label: 'Superpower', shortLabel: 'S' }),
        newAdvancedAnswerType({ value: 10, label: 'Correct', shortLabel: 'C' }),
      ],
      bonusStructure: 'irregular',
      maximumBonusScore: 40,
      bonusDivisor: 10,
      minimumPartsPerBonus: 2,
      maximumPartsPerBonus: 3,
    });

    const read = readScoringRulesInput(JSON.parse(JSON.stringify(input)));
    expect(read).toEqual(input);
  });

  test('an advanced value with no answer types in it is refused rather than given a default tossup', () => {
    // Inventing a 10-point tossup here would be substituting somebody else's rules for a stored value
    // this build cannot read, silently, on the screen a game is about to start from.
    expect(readScoringRulesInput({ mode: 'advanced', advanced: { useBonuses: true } })).toBeNull();
    expect(readScoringRulesInput({ mode: 'advanced' })).toBeNull();
  });

  test('nothing usable reads as nothing', () => {
    expect(readScoringRulesInput(null)).toBeNull();
    expect(readScoringRulesInput('ten points')).toBeNull();
    expect(readScoringRulesInput({ mode: 'basic' })).toBeNull();
  });
});

describe('moving between the two forms', () => {
  test('basic to advanced keeps the format identical', () => {
    const input = basicRulesInput(basic({ powerValue: 15, tossupCount: 24, maximumPlayersPerTeam: 3 }));
    const advanced = scoringRulesInputAs(input, 'advanced');

    expect(advanced.mode).toBe('advanced');
    expect(scoringRulesInputFormat(advanced)).toEqual(scoringRulesInputFormat(input));
  });

  test('advanced back to basic keeps the format identical when it fits', () => {
    const advanced = scoringRulesInputAs(basicRulesInput(basic({ powerValue: 15 })), 'advanced');
    const back = scoringRulesInputAs(advanced, 'basic');

    expect(back.mode).toBe('basic');
    expect(scoringRulesInputFormat(back)).toEqual(scoringRulesInputFormat(advanced));
  });

  test('a format the basic fields cannot state stays where it is rather than being cut down', () => {
    const advanced = advancedRulesInput({
      ...advancedFromBasic(basic({ powerValue: 15 })),
      answerTypes: [
        newAdvancedAnswerType({ value: 20, label: 'Superpower', shortLabel: 'S' }),
        newAdvancedAnswerType({ value: 15, label: 'Power', shortLabel: 'P' }),
        newAdvancedAnswerType({ value: 10, label: 'Correct', shortLabel: 'C' }),
      ],
    });

    expect(advancedFitsBasicForm(advanced.advanced)).toBe(false);
    expect(basicFromAdvanced(advanced.advanced)).toBeNull();
    // Unchanged, so the screen keeps showing the format that was entered.
    expect(scoringRulesInputAs(advanced, 'basic')).toBe(advanced);
  });

  test('a format with no bonuses in it arrives playable, and goes back unchanged', () => {
    // The bug this covers: the rows carried `awardsBonus: true` regardless, `bonusesAreUsed` reads one
    // such flag as bonuses being in play, and `advancedScoringRulesToQbj` writes no bonus fields when
    // they are off — so pressing "Advanced rules" on a bonus-free format landed on a screen that could
    // not start a game, complaining about bonuses the scorekeeper had just turned off.
    const rules = basic({ useBonuses: false });
    const advanced = advancedFromBasic(rules);

    expect(advanced.answerTypes.map((type) => type.awardsBonus)).toEqual([false, false]);
    expect(advancedScoringRulesProblems(advanced)).toEqual([]);
    // The same game, not merely a form that stopped complaining.
    expect(advancedScorekeeperFormat(advanced)).toEqual(basicScorekeeperFormat(rules));
    expect(advancedScorekeeperFormat(advanced)?.bonus.enabled).toBe(false);

    expect(advancedFitsBasicForm(advanced)).toBe(true);
    expect(basicFromAdvanced(advanced)).toEqual(rules);
  });

  test('a row that earns a bonus in a bonus-free format is named as the row that caused it', () => {
    const advanced = {
      ...advancedFromBasic(basic({ useBonuses: false })),
      answerTypes: [
        newAdvancedAnswerType({ value: 10, label: 'Correct', shortLabel: 'C', awardsBonus: true }),
        newAdvancedAnswerType({ value: -5, label: 'Neg', shortLabel: 'N', awardsBonus: false }),
      ],
    };

    const problems = advancedScoringRulesProblems(advanced);
    // The reader still reports the bonus structure it now believes is missing, because one stated
    // flag is all `bonusesAreUsed` needs. The point is that the list opens with the row to untick
    // rather than five complaints about fields the form is not showing.
    expect(problems[0]).toBe('"Correct" earns a bonus, but this format does not use bonuses.');

    // Untick it and the format is playable, which is what says the complaint was about the right row.
    const fixed = {
      ...advanced,
      answerTypes: advanced.answerTypes.map((type) => ({ ...type, awardsBonus: false })),
    };
    expect(advancedScoringRulesProblems(fixed)).toEqual([]);
    // And a row disagreeing with the bonus setting is not something the basic fields can state.
    expect(advancedFitsBasicForm(advanced)).toBe(false);
    expect(advancedFitsBasicForm(fixed)).toBe(true);
  });

  test('what does and does not fit the basic form', () => {
    const fits = (overrides: Parameters<typeof advancedRulesInput>[0]) => advancedFitsBasicForm(overrides);
    const from = (rules: IBasicScoringRulesInput) => advancedFromBasic(rules);

    expect(fits(from(basic()))).toBe(true);
    expect(fits(from(basic({ powerValue: 15 })))).toBe(true);
    expect(fits(from(basic({ negValue: undefined })))).toBe(true);
    expect(fits(from(basic({ useBonuses: false })))).toBe(true);

    // An irregular bonus, a second neg, a zero-point answer, and a row with nothing in it.
    expect(fits({ ...from(basic()), bonusStructure: 'irregular' })).toBe(false);
    expect(
      fits({
        ...from(basic()),
        answerTypes: [
          newAdvancedAnswerType({ value: 10, label: 'Correct', shortLabel: 'C' }),
          newAdvancedAnswerType({ value: -5, label: 'Neg', shortLabel: 'N', awardsBonus: false }),
          newAdvancedAnswerType({ value: -10, label: 'Bad neg', shortLabel: 'B', awardsBonus: false }),
        ],
      }),
    ).toBe(false);
    expect(
      fits({
        ...from(basic()),
        answerTypes: [
          newAdvancedAnswerType({ value: 10, label: 'Correct', shortLabel: 'C' }),
          newAdvancedAnswerType({ value: 0, label: 'Wrong after readout', shortLabel: 'W', awardsBonus: false }),
        ],
      }),
    ).toBe(false);
    expect(fits({ ...from(basic()), answerTypes: [newAdvancedAnswerType({ label: 'Correct' })] })).toBe(false);
    // A neg that earns a bonus is a real rule the advanced form can state and the basic one cannot.
    expect(
      fits({
        ...from(basic()),
        answerTypes: [
          newAdvancedAnswerType({ value: 10, label: 'Correct', shortLabel: 'C' }),
          newAdvancedAnswerType({ value: -5, label: 'Neg', shortLabel: 'N', awardsBonus: true }),
        ],
      }),
    ).toBe(false);
  });

  test('the two power values come back the right way round', () => {
    const advanced = advancedFromBasic(basic({ tossupValue: 10, powerValue: 15 }));
    const back = basicFromAdvanced(advanced);

    expect(back?.tossupValue).toBe(10);
    expect(back?.powerValue).toBe(15);
  });
});

describe('dispatching to whichever form is live', () => {
  test('problems and the format come from the branch in hand', () => {
    const bad = basicRulesInput(basic({ tossupValue: 0, negValue: -5 }));

    expect(scoringRulesInputProblems(bad)).toContain('These scoring rules have no way to score points on a tossup.');
    expect(scoringRulesInputFormat(bad)).toBeNull();

    const good = advancedRulesInput(advancedFromBasic(basic()));
    expect(scoringRulesInputProblems(good)).toEqual([]);
    expect(scoringRulesInputFormat(good)).toEqual(advancedScorekeeperFormat(good.advanced));
  });

  test('neither branch is a second engine: both agree with their own module', () => {
    const rules = basic({ powerValue: 15, tossupCount: 24 });

    expect(scoringRulesInputFormat(basicRulesInput(rules))).toEqual(basicScorekeeperFormat(rules));
  });

  test('the timed flag and the tossup count are readable without knowing the branch', () => {
    expect(scoringRulesInputIsTimed(basicRulesInput(basic({ timed: true })))).toBe(true);
    expect(scoringRulesInputIsTimed(advancedRulesInput(advancedFromBasic(basic({ timed: false }))))).toBe(false);

    expect(scoringRulesInputTossupCount(basicRulesInput(basic({ tossupCount: 24 })))).toBe(24);
    expect(scoringRulesInputTossupCount(advancedRulesInput(advancedFromBasic(basic({ tossupCount: 15 }))))).toBe(15);
  });
});
