/**
 * A scoring rule set, for tests, and the projection from it onto `IScorekeeperFormat`.
 *
 * # Why this exists at all
 *
 * The desktop builds a format by projecting its own `ScoringRules` — a class with computed getters,
 * a mutable API and a dependency on the rest of its data model. This repository's contract is the
 * projected descriptor, and a scorer that could only be tested by first constructing somebody
 * else's object graph would not really be standalone.
 *
 * So the rule sets and the projection are reimplemented here, in test code, deliberately small. The
 * four preset shapes are the exact output of the desktop's projection for the four rule sets its
 * own tests use, captured from it, so a scoring test ported from there is testing the same format
 * it was testing before.
 *
 * # Why it keeps the desktop's field names
 *
 * Because the scoring tests are ported wholesale, and every one of them says things like
 * `rules.maximumPlayersPerTeam = 2`. Renaming would mean rewriting two hundred call sites by hand
 * in the one part of this repository where a silent change to a fixture is indistinguishable from a
 * change to what is being asserted.
 *
 * # It is a fixture, not a mode
 *
 * Nothing in the engine branches on which of these it was handed, and nothing may. They are here
 * because they are the shapes real tournaments run under — powers and no powers, timed and untimed,
 * sudden death and a three-question overtime — and a bug that only appears under one of them is
 * exactly the bug worth catching.
 */
import { IScorekeeperAnswerType, IScorekeeperFormat, scorekeeperFormatVersion } from '../src/scoring/ScorekeeperFormat';
import AnswerType from './AnswerType';

export enum CommonRuleSets {
  Acf = 'acf',
  AcfPowers = 'acfPowers',
  NaqtTimed = 'naqtTimed',
  NaqtUntimed = 'naqtUntimed',
}

export class ScoringRules {
  name = '';

  /** Descending by value: powers first, negs last, which is the order the descriptor promises. */
  answerTypes: AnswerType[] = [];

  timed = false;

  maximumRegulationTossupCount = 20;

  minimumOvertimeQuestionCount = 1;

  overtimeIncludesBonuses = false;

  useBonuses = true;

  bonusesBounceBack = false;

  bonusDivisor = 10;

  minimumPartsPerBonus = 3;

  maximumPartsPerBonus = 3;

  /** Undefined is what makes a bonus irregular: the parts need not be worth the same. */
  pointsPerBonusPart: number | undefined = 10;

  maximumBonusScore = 30;

  lightningCountPerTeam = 0;

  lightningDivisor = 10;

  maximumPlayersPerTeam = 4;

  constructor(ruleSet: CommonRuleSets = CommonRuleSets.Acf) {
    this.applyRuleSet(ruleSet);
  }

  applyRuleSet(ruleSet: CommonRuleSets): void {
    this.answerTypes =
      ruleSet === CommonRuleSets.Acf
        ? [new AnswerType(10), new AnswerType(-5)]
        : [new AnswerType(15), new AnswerType(10), new AnswerType(-5)];
    this.timed = ruleSet === CommonRuleSets.NaqtTimed;
    this.maximumRegulationTossupCount = ruleSet === CommonRuleSets.NaqtTimed ? 24 : 20;
    this.minimumOvertimeQuestionCount =
      ruleSet === CommonRuleSets.NaqtTimed || ruleSet === CommonRuleSets.NaqtUntimed ? 3 : 1;
  }

  /** A timed round has no target; the default twenty is a planning figure, not an end condition. */
  get regulationTossupCount(): number {
    return this.timed ? 20 : this.maximumRegulationTossupCount;
  }

  /** Every bonus the same number of parts, worth the same each. Without both, there is nothing to enumerate. */
  bonusesAreRegular(): boolean {
    return this.pointsPerBonusPart !== undefined && this.minimumPartsPerBonus === this.maximumPartsPerBonus;
  }

  useLightningRounds(): boolean {
    return this.lightningCountPerTeam > 0;
  }

  setUseBonuses(useBonuses: boolean): void {
    this.useBonuses = useBonuses;
    if (!useBonuses) {
      this.bonusesBounceBack = false;
      this.overtimeIncludesBonuses = false;
    }
  }

  /**
   * The largest integer that always divides a team's score.
   *
   * Any value that is not a multiple of five drops it to one; any that is a multiple of five but
   * not of ten drops it to five.
   */
  get totalDivisor(): number {
    let divisor = 10;
    for (const answerType of this.answerTypes) {
      if (answerType.value % 5) return 1;
      if (answerType.value % 10) divisor = 5;
    }
    if (this.bonusDivisor % 5) return 1;
    if (this.bonusDivisor % 10) divisor = 5;
    if (this.lightningCountPerTeam > 0) {
      if (this.lightningDivisor % 5) return 1;
      if (this.lightningDivisor % 10) divisor = 5;
    }
    return divisor;
  }
}

function projectAnswerType(answerType: AnswerType, index: number): IScorekeeperAnswerType {
  return {
    index,
    value: answerType.value,
    label: answerType.label,
    shortLabel: answerType.shortLabel,
    isPower: answerType.isPower,
    isNeg: answerType.isNeg,
    // What the desktop actually does: a buzz worth anything positive earns the bonus.
    awardsBonus: answerType.value > 0,
    qbjId: answerType.id,
  };
}

/** Restate a rule set as the descriptor a scorer is driven by. Total by construction. */
export default function scoringRulesToScorekeeperFormat(rules: ScoringRules): IScorekeeperFormat {
  return {
    version: scorekeeperFormatVersion,
    name: rules.name,
    answerTypes: rules.answerTypes.map(projectAnswerType),
    regulation: {
      timed: rules.timed,
      tossupCount: rules.regulationTossupCount,
      maximumTossupCount: rules.maximumRegulationTossupCount,
    },
    bonus: {
      enabled: rules.useBonuses,
      bounceBack: rules.useBonuses && rules.bonusesBounceBack,
      regular: rules.bonusesAreRegular(),
      divisor: rules.bonusDivisor,
      minimumParts: rules.minimumPartsPerBonus,
      maximumParts: rules.maximumPartsPerBonus,
      pointsPerPart: rules.pointsPerBonusPart,
      maximumScore: rules.maximumBonusScore,
    },
    overtime: {
      minimumQuestionCount: rules.minimumOvertimeQuestionCount,
      // There is no separate sudden-death flag: sudden death is what a one-question period is.
      suddenDeath: rules.minimumOvertimeQuestionCount === 1,
      includesBonuses: rules.useBonuses && rules.overtimeIncludesBonuses,
    },
    lightning: {
      enabled: rules.useLightningRounds(),
      countPerTeam: rules.lightningCountPerTeam,
      divisor: rules.lightningDivisor,
    },
    players: { maximumActive: rules.maximumPlayersPerTeam },
    totalDivisor: rules.totalDivisor,
  };
}

/** Index of the answer type worth this many points. */
export function typeIndex(format: IScorekeeperFormat, value: number): number {
  const found = format.answerTypes.find((answerType) => answerType.value === value);
  if (!found) throw new Error(`No answer type worth ${value}`);
  return found.index;
}
