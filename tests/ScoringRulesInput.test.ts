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

  test('what does and does not fit the basic form', () => {
    const fits = (overrides: Parameters<typeof advancedRulesInput>[0]) => advancedFitsBasicForm(overrides);
    const from = (rules: IBasicScoringRulesInput) => advancedFromBasic(rules);

    expect(fits(from(basic()))).toBe(true);
    expect(fits(from(basic({ powerValue: 15 })))).toBe(true);
    expect(fits(from(basic({ negValue: undefined })))).toBe(true);

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

  /*
   * The cases a format built by `advancedFromBasic` cannot reach.
   *
   * Every test above starts from the simple form, so its rows arrive already named Power / Correct /
   * Neg and its regulation length is already a single number. Those are exactly the two properties
   * the fit check has to police, which means a conversion test that starts from basic can never fail
   * when the check is wrong about them. So these formats are written out by hand, the way a director
   * entering unusual rules — or a stored draft from the advanced form — actually produces them.
   */
  describe('what "nothing is lost" has to cover, from a format the advanced form built', () => {
    /** An ordinary powers-and-negs format stated directly in the advanced form. */
    const handEntered = (
      overrides: Partial<Parameters<typeof advancedRulesInput>[0]> = {},
    ): Parameters<typeof advancedRulesInput>[0] => ({
      answerTypes: [
        newAdvancedAnswerType({ value: 15, label: 'Power', shortLabel: 'P' }),
        newAdvancedAnswerType({ value: 10, label: 'Correct', shortLabel: 'C' }),
        newAdvancedAnswerType({ value: -5, label: 'Neg', shortLabel: 'N', awardsBonus: false }),
      ],
      useBonuses: true,
      bonusStructure: 'regular',
      pointsPerBonusPart: 10,
      partsPerBonus: 3,
      bonusesBounceBack: false,
      tossupCount: 20,
      maximumPlayersPerTeam: 4,
      overtimeQuestionCount: 1,
      overtimeIncludesBonuses: false,
      ...overrides,
    });

    test('the hand-entered baseline does fit, so the refusals below are about one field each', () => {
      expect(advancedFitsBasicForm(handEntered())).toBe(true);
      // Stating the same number twice is not an extension, so it is not a loss.
      expect(advancedFitsBasicForm(handEntered({ maximumTossupCount: 20 }))).toBe(true);
    });

    test('a regulation that may be extended does not fit, because the simple form flattens it', () => {
      // "Twenty tossups, up to twenty-four if the round runs long." Going back writes
      // maximum_regulation_tossup_count = tossupCount, which silently makes that 20/20.
      const extendable = handEntered({ maximumTossupCount: 24 });

      expect(advancedFitsBasicForm(extendable)).toBe(false);
      expect(basicFromAdvanced(extendable)).toBeNull();
      expect(scoringRulesInputAs(advancedRulesInput(extendable), 'basic').mode).toBe('advanced');
    });

    test('answer types the simple form would rename do not fit, even at identical point values', () => {
      // Worth 15 and 10 exactly as powers and correct answers are, and called something else. The
      // simple form has no field for a name, so coming back would relabel these Power / P and
      // Correct / C — the identity work in #91 undone on a screen that promised it would not be.
      const renamed = handEntered({
        answerTypes: [
          newAdvancedAnswerType({ value: 15, label: 'Early correct', shortLabel: 'E' }),
          newAdvancedAnswerType({ value: 10, label: 'Correct', shortLabel: 'C' }),
        ],
      });

      expect(advancedFitsBasicForm(renamed)).toBe(false);
      expect(basicFromAdvanced(renamed)).toBeNull();
    });

    test('two positives worth the same are told apart by name, not collapsed into one role', () => {
      // A row somebody is halfway through editing: added, and still worth what the row above it is
      // worth. The simple form is offered on the fit check alone, so this is a reachable way past it.
      //
      // Power / P beside Correct / C is what coming back writes, so nothing is lost by going. Two
      // Correct / C rows is the same two values and a different format — one of them comes back called
      // Power — and a check that keys the reconstruction by value cannot tell those two apart.
      const named = handEntered({
        answerTypes: [
          newAdvancedAnswerType({ value: 15, label: 'Power', shortLabel: 'P' }),
          newAdvancedAnswerType({ value: 15, label: 'Correct', shortLabel: 'C' }),
        ],
      });
      const bothOrdinary = handEntered({
        answerTypes: [
          newAdvancedAnswerType({ value: 15, label: 'Correct', shortLabel: 'C' }),
          newAdvancedAnswerType({ value: 15, label: 'Correct', shortLabel: 'C' }),
        ],
      });

      expect(advancedFitsBasicForm(named)).toBe(true);
      expect(advancedFitsBasicForm(bothOrdinary)).toBe(false);
      expect(basicFromAdvanced(bothOrdinary)).toBeNull();
      expect(scoringRulesInputAs(advancedRulesInput(bothOrdinary), 'basic').mode).toBe('advanced');
    });

    test('a short label alone is enough, and an unnamed row is too', () => {
      const shortLabelOnly = handEntered({
        answerTypes: [
          newAdvancedAnswerType({ value: 15, label: 'Power', shortLabel: 'PW' }),
          newAdvancedAnswerType({ value: 10, label: 'Correct', shortLabel: 'C' }),
        ],
      });
      // A row nobody named is not a row called "Correct"; the conversion would be inventing the name.
      const unnamed = handEntered({
        answerTypes: [newAdvancedAnswerType({ value: 10 }), newAdvancedAnswerType({ value: -5, awardsBonus: false })],
      });

      expect(advancedFitsBasicForm(shortLabelOnly)).toBe(false);
      expect(advancedFitsBasicForm(unnamed)).toBe(false);
    });

    test('surrounding whitespace is not a rule, and does not refuse the conversion', () => {
      const padded = handEntered({
        answerTypes: [
          newAdvancedAnswerType({ value: 10, label: ' Correct ', shortLabel: ' C ' }),
          newAdvancedAnswerType({ value: -5, label: 'Neg', shortLabel: 'N', awardsBonus: false }),
        ],
      });

      expect(advancedFitsBasicForm(padded)).toBe(true);
    });

    test('a format that does fit round-trips to exactly the same scoring rules', () => {
      // The claim the hint on screen makes, checked against the format rather than the fields: the
      // point of the whole check is that going back cannot change what comes out of the reader.
      const input = advancedRulesInput(handEntered());
      const back = scoringRulesInputAs(input, 'basic');

      expect(back.mode).toBe('basic');
      expect(scoringRulesInputFormat(back)).toEqual(scoringRulesInputFormat(input));
    });
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
