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

  if (format.version !== scorekeeperFormatVersion) {
    problems.push('These scoring rules were saved by a different version of YellowFruit.');
    // Nothing below can be trusted to mean what it appears to mean.
    return problems;
  }

  if (format.answerTypes.length === 0) {
    problems.push('This tournament has no answer types defined, so there is nothing to score.');
  } else if (!format.answerTypes.some((answerType) => answerType.value > 0)) {
    problems.push('This tournament has no way to score points on a tossup.');
  }

  if (format.regulation.tossupCount < 1) {
    problems.push('This tournament has no tossups in regulation.');
  }

  if (format.overtime.minimumQuestionCount < 1) {
    problems.push('This tournament has an overtime period with no tossups in it.');
  }

  return problems;
}

/** Whether a game can be scored under this format. */
export function isScorekeeperFormatUsable(format: IScorekeeperFormat | null): format is IScorekeeperFormat {
  if (!format) return false;
  return scorekeeperFormatProblems(format).length === 0;
}
