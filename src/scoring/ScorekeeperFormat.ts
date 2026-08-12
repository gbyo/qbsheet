/**
 * A room-safe structural description of a tournament's scoring rules.
 *
 * # Why this exists
 *
 * `YellowFruitScoringRulesToModaq` translates `ScoringRules` into MODAQ's `IGameFormat`, and has to
 * refuse a long list of configurations YellowFruit supports but MODAQ cannot express: a base tossup
 * value other than 10, more than one neg, lightning rounds, irregular bonuses, any bonus that isn't
 * three 10-point parts. Those refusals are correct — guessing would mis-score real games — but they
 * mean the browser can only be used for a subset of the tournaments YellowFruit itself can run.
 *
 * This descriptor is the other side of that. It is not a translation into somebody else's model; it
 * is `ScoringRules` restated as plain data, so a scorer built against it can score anything
 * YellowFruit can represent. It never fails, because there is nothing to fail at: every field here
 * is something the rules already say.
 *
 * # What "room-safe" means
 *
 * Plain data, no classes, no getters, JSON round-trippable. It crosses the HTTP API into a browser
 * that has no access to YellowFruit's object graph, and it gets cached in `localStorage` for
 * emergency scoring, so it has to survive `JSON.parse` with its meaning intact. That rules out
 * shipping `ScoringRules` itself, whose `regulationTossupCount`, `totalDivisor`, `isPower` and
 * `isNeg` are all computed getters that would serialize to nothing.
 *
 * # What is deliberately absent
 *
 * `IQbjScoringRules` declares `maximumLightningScore` and `lightningsBounceBack`, and
 * `IQbjAnswerType` declares `awardsBonus`. None of the three is implemented by the corresponding
 * YellowFruit class, so none of them has a value to carry and none appears here. Adding them would
 * mean inventing rules YellowFruit does not have.
 *
 * There is also no timed-round duration, because YellowFruit does not store one anywhere: `timed`
 * is a bare boolean in the .yft file's YfData. A scorer for a timed round has to be told by the
 * moderator that time expired.
 */

/** Bumped when the descriptor's shape changes. An unrecognized version is treated as unusable. */
export const scorekeeperFormatVersion = 1;

/** Bounds for untrusted or hand-assembled format data. */
export const scorekeeperFormatLimits = {
  answerTypes: 50,
  count: 10_000,
  players: 200,
  points: 1_000_000_000,
} as const;

/**
 * One way a tossup can be answered.
 *
 * The point value is the whole of it. YellowFruit does not record a marker, a packet position, or
 * any other property of the buzz — `AnswerType` is a value with optional labels.
 */
export interface IScorekeeperAnswerType {
  /**
   * Position in this format's `answerTypes`, and the identifier events should reference.
   *
   * Not `qbjId`, which is not reliably unique: `AnswerType.id` is `AnswerType_${label}`, and `label`
   * falls back to the point value, so two answer types sharing a label share an id. The index is
   * stable for the lifetime of a format, which is all a game needs.
   */
  index: number;
  value: number;
  label: string;
  shortLabel: string;
  /**
   * Whether YellowFruit counts this as a power.
   *
   * Derived, because `AnswerType.isPower` is itself derived: it is exactly `value > 10`, with no
   * stored field behind it and no way to set it. A format whose base tossup is worth more than 10
   * therefore has a "power" it did not ask for, in YellowFruit as much as here. Carrying the flag
   * rather than recomputing it downstream keeps that judgement in one place.
   */
  isPower: boolean;
  /** Likewise derived: `AnswerType.isNeg` is exactly `value < 0`. */
  isNeg: boolean;
  /**
   * Whether converting this earns the team a bonus, when the format uses bonuses at all.
   *
   * `IQbjAnswerType.awardsBonus` exists in the schema but `AnswerType` does not implement it, so
   * this is what YellowFruit actually does: `MatchTeam.getBonusesHeard` counts buzzes whose value is
   * positive. Combine with `bonus.enabled` — this field says nothing about whether bonuses are used.
   */
  awardsBonus: boolean;
  /** `AnswerType.id`, for QBJ ref pointers on export. See the note on `index` before keying on it. */
  qbjId: string;
}

export interface IScorekeeperRegulation {
  /**
   * Timed rounds end when the moderator calls time rather than after a fixed number of tossups.
   * YellowFruit stores no duration, so a scorer can only say that the round is timed.
   */
  timed: boolean;
  /**
   * Tossups in regulation.
   *
   * For a timed format this is `ScoringRules.defaultRegulationTossupCount` (20) regardless of
   * `maximumTossupCount` — the getter hardcodes it, with a comment noting that a manual setting may
   * come later. Treat it as a planning figure for a timed round, not a target.
   */
  tossupCount: number;
  /** For untimed play, the only allowed regulation length outside of tiebreakers. */
  maximumTossupCount: number;
}

export interface IScorekeeperBonus {
  /** `ScoringRules.useBonuses`. A YellowFruit-internal flag; in QBJ it is the presence of bonus fields. */
  enabled: boolean;
  bounceBack: boolean;
  /**
   * Whether every bonus has the same number of parts worth the same each, i.e.
   * `ScoringRules.bonusesAreRegular()`. False means `pointsPerPart` is undefined or the part count
   * varies, and a scorer must let the total be entered rather than offering fixed buttons.
   *
   * Also what decides whether bounceback parts heard can be calculated at all —
   * `canCalculateBounceBackPartsHeard()` is exactly this.
   */
  regular: boolean;
  divisor: number;
  minimumParts: number;
  maximumParts: number;
  /** Undefined when parts are not all worth the same. This is what makes a bonus irregular. */
  pointsPerPart?: number;
  maximumScore: number;
}

export interface IScorekeeperOvertime {
  /** Tossups in an overtime period. 1 means sudden death. */
  minimumQuestionCount: number;
  /**
   * Convenience for `minimumQuestionCount === 1`. YellowFruit has no separate sudden-death flag;
   * sudden death is what a one-question overtime period is.
   */
  suddenDeath: boolean;
  includesBonuses: boolean;
}

export interface IScorekeeperLightning {
  /** `ScoringRules.useLightningRounds()`, i.e. `countPerTeam > 0`. */
  enabled: boolean;
  countPerTeam: number;
  /**
   * The largest number that always divides a lightning score. YellowFruit records lightning as one
   * point total per team per game, so this is the increment that total moves in.
   */
  divisor: number;
}

export interface IScorekeeperPlayers {
  /** How many players a team may have active at once. */
  maximumActive: number;
}

/** Everything a room needs in order to score a game under this tournament's rules. */
export interface IScorekeeperFormat {
  version: number;
  /** The rule set's name. A label only — a scorer should never branch on it. */
  name: string;
  /**
   * In YellowFruit's order: descending by value, so powers first and negs last. `sortAnswerTypes`
   * establishes this when a file is parsed, and it is the order the settings UI shows.
   */
  answerTypes: IScorekeeperAnswerType[];
  regulation: IScorekeeperRegulation;
  bonus: IScorekeeperBonus;
  overtime: IScorekeeperOvertime;
  lightning: IScorekeeperLightning;
  players: IScorekeeperPlayers;
  /**
   * The largest integer that always evenly divides a team's score, derived by `ScoringRules` from
   * the answer types together with the bonus and lightning divisors. Useful for flagging a total
   * that cannot be right; never for rejecting one on its own.
   */
  totalDivisor: number;
}

/**
 * Reasons this format cannot be scored by anything, in words a scorekeeper can act on.
 *
 * A much shorter list than the MODAQ adapter's, and for a different reason: these are not gaps in
 * what the scorer supports, they are rule sets that do not describe a playable game. Everything
 * YellowFruit can represent as a playable format returns an empty array.
 *
 * `FileParsing` already rejects a saved tournament with no positive answer type, so in practice
 * these are reachable only from a format assembled in memory.
 *
 * @returns an empty array when the format is scoreable
 */
export function scorekeeperFormatProblems(format: IScorekeeperFormat): string[] {
  const problems: string[] = [];
  if (!format || typeof format !== 'object') return ['There is no usable scorekeeper format.'];

  if (format.version !== scorekeeperFormatVersion) {
    problems.push('These scoring rules were saved by a different version of YellowFruit.');
    // Nothing below can be trusted to mean what it appears to mean.
    return problems;
  }

  if (!Array.isArray(format.answerTypes)) {
    problems.push('This tournament has no answer types defined, so there is nothing to score.');
  } else if (format.answerTypes.length === 0) {
    problems.push('This tournament has no answer types defined, so there is nothing to score.');
  } else {
    if (format.answerTypes.length > scorekeeperFormatLimits.answerTypes) {
      problems.push('This tournament lists an implausible number of answer types.');
    }
    const ids = new Set<string>();
    format.answerTypes.forEach((answerType, position) => {
      if (!answerType || typeof answerType !== 'object') {
        problems.push(`Answer type ${position + 1} is not an object.`);
        return;
      }
      if (!Number.isInteger(answerType.index) || answerType.index !== position) {
        problems.push(`Answer type ${position + 1} is out of order or has the wrong index.`);
      }
      if (
        !Number.isFinite(answerType.value) ||
        !Number.isInteger(answerType.value) ||
        Math.abs(answerType.value) > scorekeeperFormatLimits.points
      ) {
        problems.push(`Answer type ${position + 1} does not have a usable whole-number point value.`);
      }
      if (typeof answerType.label !== 'string' || answerType.label.trim() === '') {
        problems.push(`Answer type ${position + 1} has no label.`);
      }
      if (typeof answerType.shortLabel !== 'string' || answerType.shortLabel.trim() === '') {
        problems.push(`Answer type ${position + 1} has no short label.`);
      }
      if (answerType.isPower !== (answerType.value > 10)) {
        problems.push(`Answer type ${position + 1} has an inconsistent power flag.`);
      }
      if (answerType.isNeg !== (answerType.value < 0)) {
        problems.push(`Answer type ${position + 1} has an inconsistent penalty flag.`);
      }
      if (typeof answerType.awardsBonus !== 'boolean') {
        problems.push(`Answer type ${position + 1} does not say whether it awards a bonus.`);
      }
      if (typeof answerType.qbjId !== 'string' || answerType.qbjId.trim() === '') {
        problems.push(`Answer type ${position + 1} has no QBJ identity.`);
      } else if (ids.has(answerType.qbjId)) {
        problems.push(`Answer type ${position + 1} reuses another answer type's QBJ identity.`);
      } else {
        ids.add(answerType.qbjId);
      }
    });
    if (!format.answerTypes.some((answerType) => answerType && typeof answerType === 'object' && answerType.value > 0)) {
      problems.push('This tournament has no way to score points on a tossup.');
    }
  }

  const regulation = format.regulation;
  if (typeof regulation?.timed !== 'boolean') problems.push('The regulation timed flag is not usable.');
  if (!Number.isInteger(regulation?.tossupCount) || regulation.tossupCount < 1) {
    problems.push('This tournament has no usable tossup count in regulation.');
  } else if (regulation.tossupCount > scorekeeperFormatLimits.count) {
    problems.push('This tournament has an implausibly long regulation round.');
  }
  if (!Number.isInteger(regulation?.maximumTossupCount) || regulation.maximumTossupCount < 1) {
    problems.push('This tournament has no usable maximum regulation tossup count.');
  } else if (regulation.maximumTossupCount > scorekeeperFormatLimits.count) {
    problems.push('This tournament has an implausibly long maximum regulation round.');
  }
  if (
    Number.isInteger(regulation?.tossupCount) &&
    Number.isInteger(regulation?.maximumTossupCount) &&
    regulation.maximumTossupCount < regulation.tossupCount
  ) {
    problems.push('The maximum regulation tossup count cannot be less than the regulation count.');
  }

  const bonus = format.bonus;
  if (!bonus || typeof bonus !== 'object') {
    problems.push('These scoring rules have no bonus section.');
  } else if (typeof bonus.enabled !== 'boolean') {
    problems.push('The bonus enabled flag is not usable.');
  } else if (typeof bonus.bounceBack !== 'boolean') {
    problems.push('The bonus bounceback flag is not usable.');
  } else if (typeof bonus.regular !== 'boolean') {
    problems.push('The regular-bonus flag is not usable.');
  } else if (bonus.enabled) {
    if (!Number.isInteger(bonus.divisor) || bonus.divisor < 1 || bonus.divisor > scorekeeperFormatLimits.points) {
      problems.push('Bonuses need a positive whole-number scoring divisor.');
    }
    if (!Number.isInteger(bonus.minimumParts) || bonus.minimumParts < 1 || bonus.minimumParts > scorekeeperFormatLimits.count) {
      problems.push('Bonuses need a usable minimum part count.');
    }
    if (!Number.isInteger(bonus.maximumParts) || bonus.maximumParts < 1 || bonus.maximumParts > scorekeeperFormatLimits.count) {
      problems.push('Bonuses need a usable maximum part count.');
    }
    if (
      Number.isInteger(bonus.minimumParts) &&
      Number.isInteger(bonus.maximumParts) &&
      bonus.maximumParts < bonus.minimumParts
    ) {
      problems.push('A bonus maximum part count cannot be less than its minimum.');
    }
    if (!Number.isInteger(bonus.maximumScore) || bonus.maximumScore < 0 || bonus.maximumScore > scorekeeperFormatLimits.points) {
      problems.push('Bonuses need a usable maximum score.');
    }
    if (bonus.pointsPerPart !== undefined && (!Number.isInteger(bonus.pointsPerPart) || bonus.pointsPerPart < 1)) {
      problems.push('A bonus part value must be a positive whole number.');
    }
    const shouldBeRegular =
      bonus.pointsPerPart !== undefined && bonus.minimumParts === bonus.maximumParts;
    if (bonus.regular !== shouldBeRegular) {
      problems.push('The regular-bonus flag does not match the stated part structure.');
    }
    if (
      bonus.regular &&
      typeof bonus.pointsPerPart === 'number' &&
      Number.isInteger(bonus.maximumParts) &&
      bonus.maximumScore !== bonus.pointsPerPart * bonus.maximumParts
    ) {
      problems.push('A regular bonus maximum score does not match its part value and count.');
    }
    const bonusStep =
      bonus.regular && typeof bonus.pointsPerPart === 'number' ? bonus.pointsPerPart : bonus.divisor;
    if (
      Number.isInteger(bonusStep) &&
      bonusStep > 0 &&
      Number.isInteger(bonus.maximumScore) &&
      bonus.maximumScore % bonusStep !== 0
    ) {
      problems.push('The maximum bonus score must be reachable in the stated scoring increments.');
    }
  } else if (bonus.bounceBack) {
    problems.push('Bouncebacks cannot be enabled when bonuses are disabled.');
  }

  const overtime = format.overtime;
  if (typeof overtime?.suddenDeath !== 'boolean') problems.push('The sudden-death flag is not usable.');
  if (typeof overtime?.includesBonuses !== 'boolean') problems.push('The overtime bonus flag is not usable.');
  if (!Number.isInteger(overtime?.minimumQuestionCount) || overtime.minimumQuestionCount < 1) {
    problems.push('This tournament has an overtime period with no usable tossup count.');
  } else if (overtime.minimumQuestionCount > scorekeeperFormatLimits.count) {
    problems.push('This tournament has an implausibly long overtime period.');
  }
  if (typeof overtime?.suddenDeath === 'boolean' && overtime.suddenDeath !== (overtime?.minimumQuestionCount === 1)) {
    problems.push('The sudden-death flag does not match the overtime question count.');
  }
  if (overtime?.includesBonuses && !bonus?.enabled) {
    problems.push('Overtime cannot include bonuses when bonuses are disabled.');
  }

  const lightning = format.lightning;
  if (!lightning || typeof lightning !== 'object') {
    problems.push('These scoring rules have no lightning section.');
  } else if (typeof lightning.enabled !== 'boolean') {
    problems.push('The lightning enabled flag is not usable.');
  } else if (lightning.enabled) {
    if (!Number.isInteger(lightning.countPerTeam) || lightning.countPerTeam < 1 || lightning.countPerTeam > scorekeeperFormatLimits.count) {
      problems.push('Lightning needs a positive whole-number count per team.');
    }
    if (!Number.isInteger(lightning.divisor) || lightning.divisor < 1 || lightning.divisor > scorekeeperFormatLimits.points) {
      problems.push('Lightning needs a positive whole-number scoring divisor.');
    }
  } else if (lightning.countPerTeam !== 0) {
    problems.push('A disabled lightning round must have zero questions per team.');
  }

  if (!Number.isInteger(format.players?.maximumActive) || format.players.maximumActive < 1) {
    problems.push('A team must have at least one active player.');
  } else if (format.players.maximumActive > scorekeeperFormatLimits.players) {
    problems.push('This tournament allows an implausible number of active players.');
  }

  if (!Number.isInteger(format.totalDivisor) || format.totalDivisor < 1 || format.totalDivisor > scorekeeperFormatLimits.points) {
    problems.push('The total score divisor must be a positive whole number.');
  } else if (Array.isArray(format.answerTypes)) {
    for (const answerType of format.answerTypes) {
      if (
        answerType &&
        typeof answerType === 'object' &&
        Number.isFinite(answerType.value) &&
        answerType.value % format.totalDivisor !== 0
      ) {
        problems.push('The total score divisor must divide every answer type value.');
        break;
      }
    }
    if (bonus?.enabled && Number.isInteger(bonus.divisor) && bonus.divisor % format.totalDivisor !== 0) {
      problems.push('The total score divisor must divide the bonus divisor.');
    }
    if (
      bonus?.enabled &&
      typeof bonus.pointsPerPart === 'number' &&
      bonus.pointsPerPart % format.totalDivisor !== 0
    ) {
      problems.push('The total score divisor must divide the bonus part value.');
    }
    if (lightning?.enabled && Number.isInteger(lightning.divisor) && lightning.divisor % format.totalDivisor !== 0) {
      problems.push('The total score divisor must divide the lightning divisor.');
    }
  }

  return problems;
}

/** Whether a game can be scored under this format. */
export function isScorekeeperFormatUsable(format: IScorekeeperFormat | null): format is IScorekeeperFormat {
  if (!format) return false;
  return scorekeeperFormatProblems(format).length === 0;
}
