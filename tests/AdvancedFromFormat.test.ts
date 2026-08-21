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
import { advancedFromFormat, advancedScorekeeperFormat } from '../src/qbj/AdvancedScoringRules';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
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
