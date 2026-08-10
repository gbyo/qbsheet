/**
 * The bonus buttons are generated, never assumed. No test here mentions 0/10/20/30 as a given.
 */
import { describe, expect, test } from 'vitest';
import scoringRulesToScorekeeperFormat from './rules';
import { CommonRuleSets, ScoringRules } from './rules';
import {
  bonusPartProblem,
  bonusScoreProblem,
  bonusTotalProblem,
  bouncebackOptions,
  lightningTotalProblem,
  regularBonusTotals,
} from '../src/scorer/bonusOptions';

function bonusFor(mutate: (rules: ScoringRules) => void = () => {}) {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  mutate(rules);
  return scoringRulesToScorekeeperFormat(rules).bonus;
}

describe('regular bonus totals', () => {
  test('a three-part ten-point bonus offers four buttons', () => {
    expect(regularBonusTotals(bonusFor())).toEqual([0, 10, 20, 30]);
  });

  test('a four-part bonus offers five', () => {
    const bonus = bonusFor((rules) => {
      rules.minimumPartsPerBonus = 4;
      rules.maximumPartsPerBonus = 4;
      rules.pointsPerBonusPart = 10;
      rules.maximumBonusScore = 40;
    });

    expect(regularBonusTotals(bonus)).toEqual([0, 10, 20, 30, 40]);
  });

  test('a five-point-a-part bonus counts in fives', () => {
    const bonus = bonusFor((rules) => {
      rules.pointsPerBonusPart = 5;
      rules.maximumBonusScore = 15;
      rules.bonusDivisor = 5;
    });

    expect(regularBonusTotals(bonus)).toEqual([0, 5, 10, 15]);
  });

  test('a two-part bonus offers three', () => {
    const bonus = bonusFor((rules) => {
      rules.minimumPartsPerBonus = 2;
      rules.maximumPartsPerBonus = 2;
      rules.pointsPerBonusPart = 10;
      rules.maximumBonusScore = 20;
    });

    expect(regularBonusTotals(bonus)).toEqual([0, 10, 20]);
  });

  test('an irregular bonus has nothing to enumerate', () => {
    const bonus = bonusFor((rules) => {
      rules.pointsPerBonusPart = undefined;
    });

    expect(regularBonusTotals(bonus)).toBeNull();
  });

  test('a varying part count is likewise irregular', () => {
    const bonus = bonusFor((rules) => {
      rules.minimumPartsPerBonus = 2;
      rules.maximumPartsPerBonus = 4;
    });

    expect(regularBonusTotals(bonus)).toBeNull();
  });

  test('a maximum that is not a whole number of parts is still reachable', () => {
    const bonus = bonusFor((rules) => {
      rules.pointsPerBonusPart = 10;
      rules.maximumBonusScore = 25;
    });

    expect(regularBonusTotals(bonus)).toEqual([0, 10, 20, 25]);
  });
});

describe('bouncebacks', () => {
  test('the opponent is offered only what the controlling team left', () => {
    const bonus = bonusFor((rules) => {
      rules.bonusesBounceBack = true;
    });

    expect(bouncebackOptions(bonus, 20)).toEqual([0, 10]);
  });

  test('a fully converted bonus leaves nothing to bounce', () => {
    const bonus = bonusFor((rules) => {
      rules.bonusesBounceBack = true;
    });

    expect(bouncebackOptions(bonus, 30)).toEqual([0]);
  });

  test('a bonus nobody converted leaves all of it', () => {
    const bonus = bonusFor((rules) => {
      rules.bonusesBounceBack = true;
    });

    expect(bouncebackOptions(bonus, 0)).toEqual([0, 10, 20, 30]);
  });

  test('an irregular bonus falls back to the divisor for its step', () => {
    const bonus = bonusFor((rules) => {
      rules.bonusesBounceBack = true;
      rules.pointsPerBonusPart = undefined;
      rules.bonusDivisor = 5;
      rules.maximumBonusScore = 20;
    });

    expect(bouncebackOptions(bonus, 10)).toEqual([0, 5, 10]);
  });

  test('the exact remainder is offered when the step does not land on it', () => {
    const bonus = bonusFor((rules) => {
      rules.bonusesBounceBack = true;
      rules.pointsPerBonusPart = undefined;
      rules.bonusDivisor = 5;
      rules.maximumBonusScore = 30;
    });

    expect(bouncebackOptions(bonus, 12)).toEqual([0, 5, 10, 15, 18]);
  });
});

describe('validating a typed bonus total', () => {
  test('a total within the rules is accepted', () => {
    expect(bonusTotalProblem(bonusFor(), 20)).toBeNull();
  });

  test('more than the maximum is refused, and says the maximum', () => {
    const problem = bonusTotalProblem(bonusFor(), 40);

    expect(problem).toContain('30');
  });

  test('a negative total is refused', () => {
    expect(bonusTotalProblem(bonusFor(), -10)).toContain('negative');
  });

  test('a total that does not fit the divisor is refused', () => {
    expect(bonusTotalProblem(bonusFor(), 15)).toContain('divisible by 10');
  });

  test('a divisor of 5 accepts what a divisor of 10 would not', () => {
    const bonus = bonusFor((rules) => {
      rules.pointsPerBonusPart = undefined;
      rules.bonusDivisor = 5;
    });

    expect(bonusTotalProblem(bonus, 15)).toBeNull();
  });

  test('a regular five-point part format accepts its expressed part totals', () => {
    const bonus = bonusFor((rules) => {
      rules.pointsPerBonusPart = 5;
      rules.maximumBonusScore = 15;
    });

    expect(bonusTotalProblem(bonus, 5)).toBeNull();
    expect(bonusPartProblem(bonus, 5, 0)).toBeNull();
  });

  test('a fractional total is refused', () => {
    expect(bonusTotalProblem(bonusFor(), 12.5)).toContain('whole number');
  });

  test.each([7, 17, 35])('a standard bonus rejects %s points', (points) => {
    expect(bonusTotalProblem(bonusFor(), points)).not.toBeNull();
  });

  test('a controlled and bounceback pair shares the total contract', () => {
    expect(
      bonusScoreProblem(
        bonusFor((rules) => {
          rules.bonusesBounceBack = true;
        }),
        20,
        10,
      ),
    ).toBeNull();
    expect(
      bonusScoreProblem(
        bonusFor((rules) => {
          rules.bonusesBounceBack = true;
        }),
        20,
        20,
      ),
    ).not.toBeNull();
  });

  test('regular parts accept only their format outcomes', () => {
    expect(bonusPartProblem(bonusFor(), 10, 0)).toBeNull();
    expect(bonusPartProblem(bonusFor(), 7, 0)).toContain('0 or 10');
  });

  test('non-finite totals and forbidden bouncebacks are refused explicitly', () => {
    expect(bonusTotalProblem(bonusFor(), Number.NaN)).toContain('whole number');
    expect(bonusTotalProblem(bonusFor(), Number.POSITIVE_INFINITY)).toContain('whole number');
    expect(bonusScoreProblem(bonusFor(), 20, 10)).toContain('does not allow bounceback');
  });

  test('one part cannot award both teams or contain a non-finite value', () => {
    const bonus = bonusFor((rules) => {
      rules.bonusesBounceBack = true;
    });

    expect(bonusPartProblem(bonus, 10, 10)).toContain('both teams');
    expect(bonusPartProblem(bonus, Number.NaN, 0)).toContain('whole number');
  });
});

describe('validating a lightning total', () => {
  test('a total on the divisor is accepted', () => {
    expect(lightningTotalProblem(10, 60)).toBeNull();
  });

  test('one off the divisor is flagged', () => {
    expect(lightningTotalProblem(10, 65)).toContain('divisible by 10');
  });

  test('a negative total is refused', () => {
    expect(lightningTotalProblem(5, -5)).toContain('negative');
  });

  test('fractional and non-finite totals are refused', () => {
    expect(lightningTotalProblem(5, 12.5)).toContain('whole number');
    expect(lightningTotalProblem(5, Number.NaN)).toContain('whole number');
  });
});
