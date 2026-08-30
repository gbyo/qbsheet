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
  scorekeeperFormatLimits,
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

/** The largest integer dividing every value, used when a document omits `total_divisor`. */
function greatestCommonDivisor(values: number[]): number {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  return values.reduce((carry, value) => gcd(carry, Math.abs(value)), 0) || 1;
}

/**
 * Read `answer_types`.
 *
 * `awards_bonus` is honoured when the document states it. A legacy no-bonus document may omit the
 * field because it has no effect there; once bonus structure is present the caller rejects a missing
 * per-answer flag rather than deciding that every positive answer earns one. A per-answer true flag
 * without bonus structure is also treated as incomplete rather than silently disabling the bonus.
 * `isPower` and `isNeg` are derived exactly as the reference implementation derives them, so a
 * format read from QBJ and the same format read from a `.qbg` agree.
 *
 * @param useBonuses whether this rule set uses bonuses at all, which is what the *default* for a
 * silent `awards_bonus` depends on. "A positive answer earns a bonus" is a statement about a format
 * that has bonuses; asserted about one that does not, it produces an answer type claiming a bonus in
 * a rule set with no bonuses to claim — a contradiction nothing downstream can act on, and one that
 * `advancedFromFormat` cannot put back into the rules form. An explicit flag is never overruled:
 * `bonusesAreUsed` already reads a single explicit `true` as bonuses being in play, so when this is
 * false the only values reaching the default are absent ones.
 */
function readAnswerTypes(
  value: unknown,
  useBonuses: boolean,
): { types: IScorekeeperAnswerType[]; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(value) || value.length === 0) {
    return { types: [], problems: ['These scoring rules do not say how a tossup can be answered.'] };
  }
  if (value.length > scorekeeperFormatLimits.answerTypes) {
    return { types: [], problems: ['These scoring rules list an implausible number of answer types.'] };
  }

  const numericValues = value
    .filter(
      (entry): entry is QbjObject =>
        isPlainObject(entry) && finiteNumber(entry.value) && Number.isInteger(entry.value),
    )
    .map((entry) => Number(entry.value));
  const positiveValues = numericValues.filter((points) => points > 0);
  const highestPositive = positiveValues.length > 0 ? Math.max(...positiveValues) : undefined;

  const types: IScorekeeperAnswerType[] = [];
  const usedIds = new Set<string>();
  const reservedExplicitIds = new Set(
    value
      .filter((entry): entry is QbjObject => isPlainObject(entry) && nonBlankString(entry.id))
      .map((entry) => entry.id),
  );
  const generatedIdCounts = new Map<string, number>();
  value.forEach((entry, position) => {
    if (!isPlainObject(entry)) {
      problems.push(`Answer type ${position + 1} is not an object.`);
      return;
    }
    if (!finiteNumber(entry.value) || !Number.isInteger(entry.value)) {
      problems.push(`Answer type ${position + 1} needs a finite whole-number point value.`);
      return;
    }
    const points = entry.value;
    // Labels are presentation, not scoring semantics. When a legacy source omits them, retain the
    // familiar structural wording used by the old scorer; explicit custom labels remain untouched.
    const label = nonBlankString(entry.label)
      ? entry.label
      : points > 0
        ? positiveValues.length > 1 && points === highestPositive
          ? 'Power'
          : 'Correct'
        : points < 0
          ? 'Neg'
          : 'Wrong';
    const shortLabel = nonBlankString(entry.short_label) ? entry.short_label : label;
    const explicitId = nonBlankString(entry.id) ? entry.id : undefined;
    let qbjId = explicitId;
    if (qbjId !== undefined) {
      if (usedIds.has(qbjId)) {
        problems.push(`Answer type ${position + 1} reuses another answer type's QBJ identity.`);
      }
    } else {
      const base = `AnswerType_${label}`;
      let suffix = generatedIdCounts.get(base) ?? 0;
      let candidate = base;
      do {
        suffix += 1;
        candidate = suffix === 1 ? base : `${base}_${suffix}`;
      } while (usedIds.has(candidate) || reservedExplicitIds.has(candidate));
      generatedIdCounts.set(base, suffix);
      qbjId = candidate;
    }
    usedIds.add(qbjId);
    types.push({
      index: types.length,
      value: points,
      label,
      shortLabel,
      isPower: points > 10,
      isNeg: points < 0,
      awardsBonus: typeof entry.awards_bonus === 'boolean' ? entry.awards_bonus : useBonuses && points > 0,
      qbjId,
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
 * QBJ has no `useBonuses` flag. Bonus structure is definitive when any bonus field is present, and
 * an answer type that explicitly awards a bonus is evidence that the missing structure is incomplete
 * rather than proof that bonuses are disabled. A root-level `awards_bonus` flag is ignored because
 * the schema places the property on each `AnswerType`.
 */
function bonusesAreUsed(rules: QbjObject): boolean {
  const bonusFields = [
    'maximum_bonus_score',
    'bonus_divisor',
    'points_per_bonus_part',
    'minimum_parts_per_bonus',
    'maximum_parts_per_bonus',
  ];
  if (bonusFields.some((field) => rules[field] !== undefined)) return true;
  if (rules.bonuses_bounce_back === true) return true;
  if (
    Array.isArray(rules.answer_types) &&
    rules.answer_types.some((entry) => isPlainObject(entry) && entry.awards_bonus === true)
  ) {
    return true;
  }
  return false;
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

  if (timed !== true && timed !== false) {
    problems.push(
      'These scoring rules do not say whether the round is timed. Choose timed or untimed before scoring.',
    );
  }

  // Read before the answer types, because the default for a silent `awards_bonus` depends on it.
  const useBonuses = bonusesAreUsed(rules);

  const { types: answerTypes, problems: answerProblems } = readAnswerTypes(rules.answer_types, useBonuses);
  problems.push(...answerProblems);

  if (useBonuses && typeof rules.bonuses_bounce_back !== 'boolean') {
    problems.push('These scoring rules use bonuses but do not say whether missed parts bounce back.');
  }
  if (useBonuses && typeof rules.overtime_includes_bonuses !== 'boolean') {
    problems.push('These scoring rules use bonuses but do not say whether overtime includes bonuses.');
  }
  if (useBonuses && Array.isArray(rules.answer_types)) {
    rules.answer_types.forEach((entry, position) => {
      if (isPlainObject(entry) && typeof entry.awards_bonus !== 'boolean') {
        problems.push(`Answer type ${position + 1} does not say whether it awards a bonus.`);
      }
    });
  }

  // --- regulation -----------------------------------------------------------------------------
  const regulationTossupCount = finiteNumber(rules.regulation_tossup_count)
    ? rules.regulation_tossup_count
    : undefined;
  const maximumRegulation = finiteNumber(rules.maximum_regulation_tossup_count)
    ? rules.maximum_regulation_tossup_count
    : undefined;

  if (regulationTossupCount === undefined) {
    problems.push('These scoring rules do not say how many tossups are in regulation.');
  } else if (!Number.isInteger(regulationTossupCount) || regulationTossupCount < 1) {
    problems.push('The regulation tossup count must be a positive whole number.');
  }
  if (maximumRegulation === undefined) {
    problems.push('These scoring rules do not say the maximum regulation tossup count.');
  } else if (!Number.isInteger(maximumRegulation) || maximumRegulation < 1) {
    problems.push('The maximum regulation tossup count must be a positive whole number.');
  }
  const tossupCount = regulationTossupCount ?? 0;
  const maximumTossupCount = maximumRegulation ?? tossupCount;

  // --- bonus ----------------------------------------------------------------------------------
  const pointsPerPart = finiteNumber(rules.points_per_bonus_part) ? rules.points_per_bonus_part : undefined;
  const minimumParts = finiteNumber(rules.minimum_parts_per_bonus)
    ? rules.minimum_parts_per_bonus
    : undefined;
  const maximumParts = finiteNumber(rules.maximum_parts_per_bonus)
    ? rules.maximum_parts_per_bonus
    : undefined;
  const maximumBonusScore = finiteNumber(rules.maximum_bonus_score) ? rules.maximum_bonus_score : undefined;
  const bonusDivisor = finiteNumber(rules.bonus_divisor) ? rules.bonus_divisor : undefined;
  if (rules.points_per_bonus_part !== undefined && pointsPerPart === undefined) {
    problems.push('Points per bonus part must be a finite number.');
  }

  const requireBonusField = (value: number | undefined, label: string): number => {
    if (value === undefined) {
      problems.push(`These scoring rules use bonuses but do not specify ${label}.`);
      return 0;
    }
    if (!Number.isInteger(value) || value < 1) problems.push(`${label} must be a positive whole number.`);
    return value;
  };

  let resolvedMinimumParts = 1;
  let resolvedMaximumParts = 1;
  let resolvedMaximumBonusScore = 0;
  let resolvedBonusDivisor = 1;
  if (useBonuses) {
    resolvedMinimumParts = requireBonusField(minimumParts, 'the minimum bonus part count');
    resolvedMaximumParts = requireBonusField(maximumParts, 'the maximum bonus part count');
    if (maximumBonusScore === undefined) {
      problems.push('These scoring rules use bonuses but do not specify the maximum bonus score.');
    } else if (!Number.isInteger(maximumBonusScore) || maximumBonusScore < 0) {
      problems.push('The maximum bonus score must be a non-negative whole number.');
    } else {
      resolvedMaximumBonusScore = maximumBonusScore;
    }
    resolvedBonusDivisor = requireBonusField(bonusDivisor, 'the bonus divisor');
    if (pointsPerPart !== undefined && (!Number.isInteger(pointsPerPart) || pointsPerPart < 1)) {
      problems.push('Points per bonus part must be a positive whole number.');
    }
  }

  // Regular means every bonus has the same number of parts, each worth the same. That is exactly
  // what lets the scorer offer fixed buttons instead of a free-entry total.
  const regular = useBonuses && pointsPerPart !== undefined && resolvedMinimumParts === resolvedMaximumParts;

  // --- overtime -------------------------------------------------------------------------------
  const minimumOvertime = finiteNumber(rules.minimum_overtime_question_count)
    ? rules.minimum_overtime_question_count
    : undefined;
  if (minimumOvertime === undefined) {
    problems.push('These scoring rules do not say how many tossups the initial overtime has.');
  } else if (!Number.isInteger(minimumOvertime) || minimumOvertime < 1) {
    problems.push('This tournament has an overtime period with no tossups in it.');
  }
  const minimumQuestionCount = minimumOvertime ?? 1;

  // --- lightning ------------------------------------------------------------------------------
  const rawLightningCount = finiteNumber(rules.lightning_count_per_team)
    ? rules.lightning_count_per_team
    : undefined;
  const rawLightningDivisor = finiteNumber(rules.lightning_divisor) ? rules.lightning_divisor : undefined;
  if (rules.lightning_count_per_team !== undefined && rawLightningCount === undefined) {
    problems.push('The lightning count per team must be a finite number.');
  }
  if (rules.lightning_divisor !== undefined && rawLightningDivisor === undefined) {
    problems.push('The lightning divisor must be a finite number.');
  }
  if (rawLightningCount === undefined && rules.lightning_divisor !== undefined) {
    problems.push('These scoring rules specify a lightning divisor but no lightning count per team.');
  }
  if (rawLightningCount !== undefined && (!Number.isInteger(rawLightningCount) || rawLightningCount < 0)) {
    problems.push('The lightning count per team must be a non-negative whole number.');
  }
  if (rawLightningCount !== undefined && rawLightningCount > 0) {
    if (rawLightningDivisor === undefined) problems.push('Lightning rounds need a scoring divisor.');
    else if (!Number.isInteger(rawLightningDivisor) || rawLightningDivisor < 1) {
      problems.push('The lightning divisor must be a positive whole number.');
    }
  }
  const lightningCount = rawLightningCount ?? 0;
  const lightningDivisor = lightningCount > 0 ? (rawLightningDivisor ?? 0) : 10;

  // --- players --------------------------------------------------------------------------------
  const maximumPlayers = finiteNumber(rules.maximum_players_per_team)
    ? rules.maximum_players_per_team
    : undefined;
  if (maximumPlayers === undefined) {
    problems.push('These scoring rules do not say how many players may be active per team.');
  } else if (!Number.isInteger(maximumPlayers) || maximumPlayers < 1) {
    problems.push('The maximum active players per team must be a positive whole number.');
  }

  // --- divisor --------------------------------------------------------------------------------
  const statedTotalDivisor = finiteNumber(rules.total_divisor) ? rules.total_divisor : undefined;
  if (rules.total_divisor !== undefined && statedTotalDivisor === undefined) {
    problems.push('The total divisor must be a finite number.');
  }
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
      bounceBack: useBonuses && rules.bonuses_bounce_back === true,
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
    players: { maximumActive: maximumPlayers ?? 0 },
    totalDivisor: statedTotalDivisor ?? derivedDivisor,
  };

  // The format is structurally complete. Ask the shared judgement whether it describes a game
  // anybody could play, so a QBJ import and a `.qbg` import fail for the same reasons.
  const playability = scorekeeperFormatProblems(format);
  if (playability.length > 0) return { ok: false, problems: playability };

  if (statedTotalDivisor === undefined) {
    assumptions.push(
      `The total score divisor was derived from the stated scoring increments (${derivedDivisor}).`,
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
