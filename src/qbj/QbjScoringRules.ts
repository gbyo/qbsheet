/**
 * Standard QBJ `ScoringRules` read as the scorer's `IScorekeeperFormat`.
 *
 * # Structure, never the name
 *
 * `ScoringRules.name` is a label. Nothing here branches on it, and nothing downstream may either: a
 * tournament called "NAQT" that has been edited to use 15-point powers is that edited format, and a
 * scorer that recognized the string would mis-score every game of it. Every behavioral decision in
 * this file comes from a structural field — `answer_types`, the bonus fields, the overtime fields,
 * the divisors.
 *
 * # Absent is not zero
 *
 * Almost every field in `IQbjScoringRules` is optional, and the interesting question is what an
 * absent one means. Two answers are wrong: treating it as zero, which produces a format that says a
 * bonus is worth nothing; and substituting a familiar rule set, which produces a format that is
 * confidently somebody else's tournament.
 *
 * So absence is tracked. A field that can be defaulted without changing what a game is worth is
 * defaulted and recorded in `assumptions`. A field whose absence would change scoring is a
 * `problem`, and a problem means the scorekeeper is asked rather than guessed at. The caller decides
 * how to ask; this module only refuses to invent.
 *
 * # The one thing QBJ cannot say
 *
 * There is no `timed` field anywhere in `IQbjScoringRules`. The reference implementation keeps it
 * outside QBJ entirely, in its own file extension. A timed round ends when the moderator calls time
 * rather than after a fixed count, so getting it wrong either cuts a game short or runs past its
 * end — which is why it is carried in the `_qbtcp` extension and why its absence is reported rather
 * than defaulted silently. See `docs/QBJ_ASSIGNMENT_PROFILE.md`.
 */
import {
  IScorekeeperAnswerType,
  IScorekeeperFormat,
  scorekeeperFormatProblems,
  scorekeeperFormatVersion,
} from '../scoring/ScorekeeperFormat';
import { QbjObject, finiteNumber, isPlainObject, nonBlankString } from './QbjSerialization';

export type QbjScoringRulesResult =
  | {
      ok: true;
      format: IScorekeeperFormat;
      /**
       * Fields QBJ did not specify that were given a value which cannot change what anything is
       * worth. Shown to the scorekeeper, never hidden.
       */
      assumptions: string[];
    }
  | {
      ok: false;
      /** Why this cannot be scored as-is. The scorekeeper is asked to supply or choose a format. */
      problems: string[];
    };

/** Caps chosen to be absurd for a real tournament and cheap to check. */
const maxAnswerTypes = 50;

/** The largest integer dividing every value, used when a document omits `total_divisor`. */
function greatestCommonDivisor(values: number[]): number {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  return values.reduce((carry, value) => gcd(carry, Math.abs(value)), 0) || 1;
}

/**
 * Read `answer_types`.
 *
 * `awards_bonus` is honoured when the document states it. When it does not, the fallback is the
 * reference implementation's own behavior — a buzz worth positive points earns a bonus — rather
 * than an invention. `isPower` and `isNeg` are likewise derived exactly as that implementation
 * derives them, so a format read from QBJ and the same format read from a `.qbg` agree.
 */
function readAnswerTypes(value: unknown): { types: IScorekeeperAnswerType[]; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(value) || value.length === 0) {
    return { types: [], problems: ['These scoring rules do not say how a tossup can be answered.'] };
  }
  if (value.length > maxAnswerTypes) {
    return { types: [], problems: ['These scoring rules list an implausible number of answer types.'] };
  }

  const types: IScorekeeperAnswerType[] = [];
  value.forEach((entry, position) => {
    if (!isPlainObject(entry)) {
      problems.push(`Answer type ${position + 1} is not an object.`);
      return;
    }
    if (!finiteNumber(entry.value)) {
      problems.push(`Answer type ${position + 1} has no point value.`);
      return;
    }
    const points = entry.value;
    const label = nonBlankString(entry.label) ? entry.label : String(points);
    const shortLabel = nonBlankString(entry.short_label) ? entry.short_label : label;
    types.push({
      index: types.length,
      value: points,
      label,
      shortLabel,
      isPower: points > 10,
      isNeg: points < 0,
      awardsBonus: typeof entry.awards_bonus === 'boolean' ? entry.awards_bonus : points > 0,
      qbjId: nonBlankString(entry.id) ? entry.id : `AnswerType_${label}`,
    });
  });

  if (types.length > 0 && !types.some((type) => type.value > 0)) {
    problems.push('These scoring rules have no way to score points on a tossup.');
  }

  // YellowFruit's order: descending by value, powers first and negs last. Reindex after sorting so
  // `index` stays the position events reference.
  types.sort((a, b) => b.value - a.value);
  types.forEach((type, position) => {
    type.index = position;
  });

  return { types, problems };
}

/**
 * Whether this rule set uses bonuses at all.
 *
 * QBJ has no `useBonuses` flag; bonuses are used when the bonus fields are there. Reading
 * `awards_bonus` as well matters for a document that describes the award side without restating the
 * bonus structure.
 */
function bonusesAreUsed(rules: QbjObject, answerTypes: IScorekeeperAnswerType[]): boolean {
  const bonusFields = [
    'maximum_bonus_score',
    'bonus_divisor',
    'points_per_bonus_part',
    'minimum_parts_per_bonus',
    'maximum_parts_per_bonus',
    'bonuses_bounce_back',
  ];
  if (bonusFields.some((field) => rules[field] !== undefined)) return true;
  return answerTypes.some((type) => type.awardsBonus && type.value > 0 && rules.awards_bonus === true);
}

/**
 * Read QBJ scoring rules as a scorer format.
 *
 * @param rules the `ScoringRules` object, or null when the document had none
 * @param timed the timed flag from the `_qbtcp` extension, or undefined when it was not carried
 */
export function readQbjScoringRules(rules: QbjObject | null, timed?: boolean): QbjScoringRulesResult {
  if (!rules) {
    return {
      ok: false,
      problems: ['This QBJ does not specify enough scoring information.'],
    };
  }

  const problems: string[] = [];
  const assumptions: string[] = [];

  const { types: answerTypes, problems: answerProblems } = readAnswerTypes(rules.answer_types);
  problems.push(...answerProblems);

  const useBonuses = bonusesAreUsed(rules, answerTypes);

  // --- regulation -----------------------------------------------------------------------------
  const regulationTossupCount = finiteNumber(rules.regulation_tossup_count) ? rules.regulation_tossup_count : undefined;
  const maximumRegulation = finiteNumber(rules.maximum_regulation_tossup_count)
    ? rules.maximum_regulation_tossup_count
    : undefined;

  if (regulationTossupCount === undefined && maximumRegulation === undefined) {
    problems.push('These scoring rules do not say how many tossups a game has.');
  }
  const tossupCount = regulationTossupCount ?? maximumRegulation ?? 0;
  const maximumTossupCount = maximumRegulation ?? tossupCount;
  if (regulationTossupCount === undefined && maximumRegulation !== undefined) {
    assumptions.push(`Regulation length was taken from the maximum tossup count (${maximumRegulation}).`);
  }

  // --- bonus ----------------------------------------------------------------------------------
  const pointsPerPart = finiteNumber(rules.points_per_bonus_part) ? rules.points_per_bonus_part : undefined;
  const minimumParts = finiteNumber(rules.minimum_parts_per_bonus) ? rules.minimum_parts_per_bonus : undefined;
  const maximumParts = finiteNumber(rules.maximum_parts_per_bonus) ? rules.maximum_parts_per_bonus : undefined;
  const maximumBonusScore = finiteNumber(rules.maximum_bonus_score) ? rules.maximum_bonus_score : undefined;
  const bonusDivisor = finiteNumber(rules.bonus_divisor) ? rules.bonus_divisor : undefined;

  if (useBonuses && maximumBonusScore === undefined && pointsPerPart === undefined) {
    problems.push('These scoring rules use bonuses but do not say what a bonus is worth.');
  }

  const resolvedMinimumParts = minimumParts ?? maximumParts ?? 3;
  const resolvedMaximumParts = maximumParts ?? minimumParts ?? 3;
  if (useBonuses && minimumParts === undefined && maximumParts === undefined) {
    assumptions.push('Bonuses were assumed to have three parts, which these rules did not state.');
  }
  const resolvedMaximumBonusScore =
    maximumBonusScore ?? (pointsPerPart !== undefined ? pointsPerPart * resolvedMaximumParts : 0);
  const resolvedBonusDivisor = bonusDivisor ?? pointsPerPart ?? (useBonuses ? 10 : 0);
  if (useBonuses && bonusDivisor === undefined && pointsPerPart === undefined) {
    assumptions.push('A bonus part was assumed to be worth a multiple of 10, which these rules did not state.');
  }

  // Regular means every bonus has the same number of parts, each worth the same. That is exactly
  // what lets the scorer offer fixed buttons instead of a free-entry total.
  const regular = useBonuses && pointsPerPart !== undefined && resolvedMinimumParts === resolvedMaximumParts;

  // --- overtime -------------------------------------------------------------------------------
  const minimumOvertime = finiteNumber(rules.minimum_overtime_question_count)
    ? rules.minimum_overtime_question_count
    : undefined;
  if (minimumOvertime === undefined) {
    assumptions.push('Overtime was assumed to be sudden death, which these rules did not state.');
  }
  const minimumQuestionCount = minimumOvertime ?? 1;

  // --- lightning ------------------------------------------------------------------------------
  const lightningCount = finiteNumber(rules.lightning_count_per_team) ? rules.lightning_count_per_team : 0;
  const lightningDivisor = finiteNumber(rules.lightning_divisor) ? rules.lightning_divisor : 10;

  // --- players --------------------------------------------------------------------------------
  const maximumPlayers = finiteNumber(rules.maximum_players_per_team) ? rules.maximum_players_per_team : undefined;
  if (maximumPlayers === undefined) {
    assumptions.push('Four active players per team were assumed, which these rules did not state.');
  }

  // --- divisor --------------------------------------------------------------------------------
  const statedTotalDivisor = finiteNumber(rules.total_divisor) ? rules.total_divisor : undefined;
  const derivedDivisor = greatestCommonDivisor(
    [
      ...answerTypes.map((type) => type.value).filter((value) => value !== 0),
      ...(useBonuses ? [resolvedBonusDivisor] : []),
      ...(lightningCount > 0 ? [lightningDivisor] : []),
    ].filter((value) => value !== 0),
  );

  if (problems.length > 0) return { ok: false, problems };

  const format: IScorekeeperFormat = {
    version: scorekeeperFormatVersion,
    name: nonBlankString(rules.name) ? rules.name : 'Imported scoring rules',
    answerTypes,
    regulation: {
      timed: timed === true,
      tossupCount,
      maximumTossupCount,
    },
    bonus: {
      enabled: useBonuses,
      bounceBack: rules.bonuses_bounce_back === true,
      regular,
      divisor: resolvedBonusDivisor,
      minimumParts: resolvedMinimumParts,
      maximumParts: resolvedMaximumParts,
      ...(regular && pointsPerPart !== undefined ? { pointsPerPart } : {}),
      maximumScore: resolvedMaximumBonusScore,
    },
    overtime: {
      minimumQuestionCount,
      suddenDeath: minimumQuestionCount === 1,
      includesBonuses: rules.overtime_includes_bonuses === true,
    },
    lightning: {
      enabled: lightningCount > 0,
      countPerTeam: lightningCount,
      divisor: lightningDivisor,
    },
    players: { maximumActive: maximumPlayers ?? 4 },
    totalDivisor: statedTotalDivisor ?? derivedDivisor,
  };

  // The format is structurally complete. Ask the shared judgement whether it describes a game
  // anybody could play, so a QBJ import and a `.qbg` import fail for the same reasons.
  const playability = scorekeeperFormatProblems(format);
  if (playability.length > 0) return { ok: false, problems: playability };

  if (timed === undefined) {
    assumptions.push(
      'This QBJ does not say whether rounds are timed. The game is being scored as untimed; change this if the round runs on a clock.',
    );
  }

  return { ok: true, format, assumptions };
}

/**
 * Write a scorer format back out as standard QBJ `ScoringRules`.
 *
 * The inverse of the read, and deliberately lossy in exactly one place: `timed` has no QBJ field and
 * is written to the `_qbtcp` extension by the caller instead of being smuggled into a standard one.
 */
export function writeQbjScoringRules(format: IScorekeeperFormat, id = 'ScoringRules'): QbjObject {
  const rules: QbjObject = {
    type: 'ScoringRules',
    id,
    name: format.name,
    teams_per_match: 2,
    maximum_players_per_team: format.players.maximumActive,
    regulation_tossup_count: format.regulation.tossupCount,
    maximum_regulation_tossup_count: format.regulation.maximumTossupCount,
    minimum_overtime_question_count: format.overtime.minimumQuestionCount,
    overtime_includes_bonuses: format.overtime.includesBonuses,
    total_divisor: format.totalDivisor,
    answer_types: format.answerTypes.map((type) => ({
      type: 'AnswerType',
      id: type.qbjId,
      value: type.value,
      label: type.label,
      short_label: type.shortLabel,
      awards_bonus: type.awardsBonus,
    })),
  };

  if (format.bonus.enabled) {
    rules.maximum_bonus_score = format.bonus.maximumScore;
    rules.bonus_divisor = format.bonus.divisor;
    rules.minimum_parts_per_bonus = format.bonus.minimumParts;
    rules.maximum_parts_per_bonus = format.bonus.maximumParts;
    rules.bonuses_bounce_back = format.bonus.bounceBack;
    if (format.bonus.pointsPerPart !== undefined) rules.points_per_bonus_part = format.bonus.pointsPerPart;
  }

  if (format.lightning.enabled) {
    rules.lightning_count_per_team = format.lightning.countPerTeam;
    rules.lightning_divisor = format.lightning.divisor;
  }

  return rules;
}
