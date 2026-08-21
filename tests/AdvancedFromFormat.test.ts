/**
 * Opening the rules form on a format it did not create.
 *
 * Every other path through `AdvancedScoringRules` runs forwards, from a form to a format. This is
 * the reverse, and it exists because a game being corrected mid-round has a format that arrived in a
 * QBJ file or over QBTCP rather than one anybody typed in here. See `formatCorrection`.
 *
 * The property is a round trip: whatever the form is opened on, saving it unchanged must produce the
 * rules the game was already being scored under. Anything less means a scorekeeper who opens the
 * dialog to check the rules and closes it again has silently changed them.
 */
import { describe, expect, test } from 'vitest';
import {
  advancedFromFormat,
  advancedScorekeeperFormat,
  advancedScoringRulesProblems,
} from '../src/qbj/AdvancedScoringRules';
import { readQbjScoringRules } from '../src/qbj/QbjScoringRules';
import { IScorekeeperFormat, scorekeeperFormatProblems } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';

/**
 * The two fields a round trip through the form cannot preserve, and does not have to.
 *
 * `qbjId` is minted fresh for every row on every save. `name` comes back as the QBJ reader's own
 * fallback when the format had none. Both are labels rather than rules, and `correctFormat` carries
 * both across from the original rather than letting a correction rewrite them — see the note there.
 */
function withoutLabels(format: IScorekeeperFormat) {
  return {
    ...format,
    name: '',
    answerTypes: format.answerTypes.map(({ qbjId: _qbjId, ...rest }) => rest),
  };
}

function roundTrip(format: IScorekeeperFormat): IScorekeeperFormat | null {
  return advancedScorekeeperFormat(advancedFromFormat(format));
}

describe('a format, back into the form that produces one', () => {
  test.each([
    CommonRuleSets.Acf,
    CommonRuleSets.AcfPowers,
    CommonRuleSets.NaqtTimed,
    CommonRuleSets.NaqtUntimed,
  ])('%s round-trips to itself', (ruleSet) => {
    const format = scoringRulesToScorekeeperFormat(new ScoringRules(ruleSet));
    const returned = roundTrip(format);
    expect(returned).not.toBeNull();
    expect(withoutLabels(returned as IScorekeeperFormat)).toEqual(withoutLabels(format));
  });

  test('carries the answer types’ own labels rather than renaming them to the standard three', () => {
    const format = scoringRulesToScorekeeperFormat(new ScoringRules(CommonRuleSets.AcfPowers));
    const renamed: IScorekeeperFormat = {
      ...format,
      answerTypes: format.answerTypes.map((answerType) =>
        answerType.isPower ? { ...answerType, label: 'Early correct', shortLabel: 'E' } : answerType,
      ),
    };
    const input = advancedFromFormat(renamed);
    expect(input.answerTypes.map((type) => type.shortLabel)).toContain('E');
    expect(roundTrip(renamed)?.answerTypes.find((type) => type.isPower)?.label).toBe('Early correct');
  });

  test('keeps an extended regulation, which the simple form has nowhere to put', () => {
    // NAQT's timed round is 20 tossups that may run to 24; a form that lost the second number would
    // be changing when the round ends rather than what it scores.
    const format = scoringRulesToScorekeeperFormat(new ScoringRules(CommonRuleSets.NaqtTimed));
    const input = advancedFromFormat(format);
    expect(input.tossupCount).toBe(format.regulation.tossupCount);
    expect(input.maximumTossupCount).toBe(format.regulation.maximumTossupCount);
    expect(input.timed).toBe(true);
  });

  test('describes an irregular bonus as irregular, with the fields that shape it', () => {
    const format = scoringRulesToScorekeeperFormat(new ScoringRules(CommonRuleSets.Acf));
    const irregular: IScorekeeperFormat = {
      ...format,
      bonus: {
        enabled: true,
        bounceBack: false,
        regular: false,
        divisor: 5,
        minimumParts: 2,
        maximumParts: 4,
        pointsPerPart: undefined,
        maximumScore: 30,
      },
    };
    const input = advancedFromFormat(irregular);
    expect(input.bonusStructure).toBe('irregular');
    expect(input).toMatchObject({
      maximumBonusScore: 30,
      bonusDivisor: 5,
      minimumPartsPerBonus: 2,
      maximumPartsPerBonus: 4,
    });
  });

  test('a format with no bonuses does not come back asking for bonus structure', () => {
    const format = scoringRulesToScorekeeperFormat(new ScoringRules(CommonRuleSets.Acf));
    const tossupsOnly: IScorekeeperFormat = {
      ...format,
      answerTypes: format.answerTypes.map((answerType) => ({ ...answerType, awardsBonus: false })),
      bonus: { ...format.bonus, enabled: false },
    };
    const input = advancedFromFormat(tossupsOnly);
    expect(input.useBonuses).toBe(false);
    expect(roundTrip(tossupsOnly)?.bonus.enabled).toBe(false);
  });

  /*
   * The same claim, made about a format nobody built by hand.
   *
   * The test above constructs its bonus-free format by clearing `awardsBonus` on every answer type
   * as well as switching bonuses off -- which is the one step the import path does not take, and so
   * the one step that made the test pass while a real tossup-only QBJ opened a dialog with six
   * complaints on it and every button disabled. `awardsBonus` says nothing on its own about whether
   * bonuses are used (see `ScorekeeperFormat`), but the trip out of this form writes it as
   * `awards_bonus`, which is exactly what `bonusesAreUsed` reads. So the assertion has to start
   * where a tournament's file starts.
   */
  test('a tossup-only format read from a QBJ opens in the form with nothing to complain about', () => {
    const read = readQbjScoringRules(
      {
        // No bonus fields and no `awards_bonus` anywhere, which is what a round with no bonuses in
        // it actually ships as. Every other field is one the reader requires.
        answer_types: [{ value: 10 }, { value: -5 }],
        regulation_tossup_count: 20,
        maximum_regulation_tossup_count: 20,
        minimum_overtime_question_count: 1,
        maximum_players_per_team: 4,
      },
      false,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(scorekeeperFormatProblems(read.format)).toEqual([]);
    expect(read.format.bonus.enabled).toBe(false);

    // Openable, which is the whole property this file is about.
    expect(advancedScoringRulesProblems(advancedFromFormat(read.format))).toEqual([]);
    expect(withoutLabels(roundTrip(read.format) as IScorekeeperFormat)).toEqual(withoutLabels(read.format));
  });

  /*
   * And openable even for a format that reached the scorer already carrying the contradiction --
   * a record written by an earlier build, or a descriptor assembled in code. A correction dialog
   * that cannot be used is not an acceptable way to report one.
   */
  test('a format that claims a bonus with bonuses switched off still opens', () => {
    const format = scoringRulesToScorekeeperFormat(new ScoringRules(CommonRuleSets.Acf));
    const contradictory: IScorekeeperFormat = {
      ...format,
      answerTypes: format.answerTypes.map((answerType) => ({ ...answerType, awardsBonus: answerType.value > 0 })),
      bonus: { ...format.bonus, enabled: false },
    };
    expect(advancedFromFormat(contradictory).useBonuses).toBe(false);
    expect(advancedScoringRulesProblems(advancedFromFormat(contradictory))).toEqual([]);
    expect(roundTrip(contradictory)?.bonus.enabled).toBe(false);
  });

  test('carries lightning only when the format plays it', () => {
    const format = scoringRulesToScorekeeperFormat(new ScoringRules(CommonRuleSets.Acf));
    expect(advancedFromFormat(format).useLightning).toBe(false);

    const withLightning: IScorekeeperFormat = {
      ...format,
      lightning: { enabled: true, countPerTeam: 2, divisor: 10 },
    };
    expect(advancedFromFormat(withLightning)).toMatchObject({
      useLightning: true,
      lightningCountPerTeam: 2,
      lightningDivisor: 10,
    });
  });
});
