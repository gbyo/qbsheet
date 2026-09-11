/**
 * YellowFruit's scoring rules, completed into the QBJ a scorer can start a game from.
 *
 * # Why this exists as its own step
 *
 * `readYellowFruitTournament` hoists YellowFruit's `scoring_rules` block into a canonical
 * `ScoringRules` object, and for statistics that is enough: everything the reports need is a
 * literal field in the file. An assignment handed to a scorekeeper is a stricter customer. It has
 * to answer questions the `.yft` never writes down, because YellowFruit answers them from code
 * rather than from storage:
 *
 * | Question | Where YellowFruit keeps the answer |
 * | --- | --- |
 * | Does a positive tossup earn a bonus? | `AnswerType.awardsBonus` is never serialized; `FileParsing` refuses a non-positive value that claims one, and the application awards one for every positive answer when bonuses are on. |
 * | Are bonuses used at all? | `useBonuses` is not a field. `ScoringRules.toFileObject` omits the whole bonus block when it is false, and `FileParsing` reads `useBonuses = maximumBonusScore !== undefined`. |
 * | How many tossups are in regulation? | `regulationTossupCount` is a getter written only to QBJ exports, never to a `.yft`: a timed round reports YellowFruit's fixed default, an untimed one reports the maximum. |
 * | What is this answer type called? | `label` and `shortLabel` are written only when overridden; otherwise they default to the point value. |
 * | Is the round timed? | Not QBJ at all. It lives in the file extension at `scoring_rules.YfData.timed`. |
 *
 * A consumer that serialized the stored block verbatim would hand a room a `ScoringRules` with no
 * `regulation_tossup_count` and no `awards_bonus`, and QBSheet's reader would correctly refuse to
 * start — which is the right refusal for a wrong document. This module produces the truthful QBJ
 * equivalent of the YellowFruit format instead, deriving each answer the way YellowFruit itself
 * derives it and saying so in `notes`.
 *
 * # Structure, never the name
 *
 * `ScoringRules.name` is carried through as a display label and nothing here reads it. A file whose
 * rule set is called `NaqtUntimed` but whose answer types have been edited is that edited format.
 */

import type { JsonObject, JsonValue } from './types';
import { asBoolean, asFiniteNumber, asJsonObject, asString } from './util';

/** YellowFruit's own default when a `.yft` omits the field (`ScoringRules.maximumPlayersPerTeam`). */
const defaultMaximumPlayersPerTeam = 4;
/** `ScoringRules.defaultRegulationTossupCount`, the count a timed round reports. */
const defaultRegulationTossupCount = 20;
/** `ScoringRules.maximumRegulationTossupCount`'s initializer. */
const defaultMaximumRegulationTossupCount = 20;
/** `ScoringRules.minimumOvertimeQuestionCount`'s initializer. */
const defaultMinimumOvertimeQuestionCount = 1;
/** `ScoringRules.bonusDivisor` / `lightningDivisor` initializers. */
const defaultDivisor = 10;
const defaultPartsPerBonus = 3;

export interface YellowFruitScoringRules {
  /**
   * A complete QBJ `ScoringRules` object, ready to be an assignment's rules.
   *
   * Every field a scorer needs is present and structural. No field is invented: each one is either
   * read from the file or derived the way YellowFruit derives it, and every derivation appears in
   * `notes`.
   */
  rules: JsonObject;
  /**
   * YellowFruit's timed flag, from `scoring_rules.YfData.timed`.
   *
   * `null` when the file did not state it. QBJ has no field for this, so a producer carries it in
   * the `_qbtcp` extension; a consumer that receives neither must ask rather than assume. There is
   * no timed-round *duration* anywhere in a `.yft`, and none is invented here.
   */
  timed: boolean | null;
  /** Whether the format uses bonuses, derived as YellowFruit's reader derives it. */
  usesBonuses: boolean;
  /** What was derived rather than read, in words an operator can act on. */
  notes: string[];
}

export type YellowFruitScoringRulesResult =
  { ok: true; value: YellowFruitScoringRules } | { ok: false; error: string };

/** YellowFruit's `totalDivisor` getter, for a file that predates the field being written. */
function derivedTotalDivisor(
  answerValues: number[],
  bonusDivisor: number | undefined,
  lightningDivisor: number | undefined,
): number {
  let divisor = 10;
  const consider = (value: number): boolean => {
    if (value % 5) return false;
    if (value % 10) divisor = 5;
    return true;
  };
  for (const value of answerValues) if (!consider(value)) return 1;
  if (bonusDivisor !== undefined && !consider(bonusDivisor)) return 1;
  if (lightningDivisor !== undefined && !consider(lightningDivisor)) return 1;
  return divisor;
}

/**
 * Complete a YellowFruit `ScoringRules` block into assignment-grade QBJ.
 *
 * @param stored the `ScoringRules` object a YellowFruit import produced, or the raw `.yft`
 * `scoring_rules` block; both have the same snake_case shape.
 * @param options.id the id the returned object should carry, so a caller can reference it.
 */
export function yellowFruitScoringRules(
  stored: JsonObject | null | undefined,
  options: { id?: string } = {},
): YellowFruitScoringRulesResult {
  if (!stored) {
    return { ok: false, error: 'This YellowFruit file has no scoring rules.' };
  }
  const notes: string[] = [];

  const answerSource = Array.isArray(stored.answer_types) ? stored.answer_types : [];
  if (answerSource.length === 0) {
    return { ok: false, error: 'These YellowFruit scoring rules say no way to answer a tossup.' };
  }

  // YellowFruit's reader: bonuses are in play exactly when the file wrote a maximum bonus score.
  // `toFileObject` omits the entire bonus block when `useBonuses` is false, so the presence of
  // that one field is the flag, and reconstructing it from anything else would disagree with the
  // application the file came from.
  const maximumBonusScore = asFiniteNumber(stored.maximum_bonus_score);
  const usesBonuses = maximumBonusScore !== undefined;

  const answerTypes: JsonObject[] = [];
  const answerValues: number[] = [];
  for (const [index, entry] of answerSource.entries()) {
    const answer = asJsonObject(entry);
    const value = answer ? asFiniteNumber(answer.value) : undefined;
    if (!answer || value === undefined || !Number.isInteger(value)) {
      return { ok: false, error: `Answer type ${index + 1} has no whole-number point value.` };
    }
    // YellowFruit's `AnswerType` getters: an unset label is the point value, and an unset short
    // label is the label. The file omits both unless the operator overrode them.
    const label = asString(answer.label) ?? String(value);
    const shortLabel = asString(answer.short_label) ?? asString(answer.shortLabel) ?? label;
    // `awardsBonus` is never written to a `.yft`. YellowFruit's behaviour is that a positive
    // tossup answer earns a bonus whenever the format has bonuses, and its reader rejects a
    // non-positive answer type that claims one. State that explicitly, because QBJ's consumer
    // cannot re-derive it and a missing flag is a game the scorer refuses to start.
    const awardsBonus = usesBonuses && value > 0;
    answerTypes.push({
      type: 'AnswerType',
      // `AnswerType.id` in YellowFruit is `AnswerType_${label}`. Preserve a stored id so a result
      // that references one resolves; synthesize the same shape when the file had none.
      id: asString(answer.id) ?? `AnswerType_${label}`,
      value,
      label,
      short_label: shortLabel,
      awards_bonus: awardsBonus,
    });
    answerValues.push(value);
  }
  if (!answerValues.some((value) => value > 0)) {
    return { ok: false, error: 'These YellowFruit scoring rules have no way to score a tossup.' };
  }
  notes.push(
    usesBonuses
      ? 'Bonus conversion: every positive tossup answer earns a bonus, as YellowFruit scores it.'
      : 'This format has no bonuses; no answer type earns one.',
  );

  const timed = asBoolean(asJsonObject(stored.YfData)?.timed) ?? null;
  if (timed === null) {
    notes.push('The file did not say whether rounds are timed; the assignment cannot state it.');
  }

  const maximumRegulation =
    asFiniteNumber(stored.maximum_regulation_tossup_count) ?? defaultMaximumRegulationTossupCount;
  // `regulationTossupCount` is a getter, not a stored field: YellowFruit writes it to a QBJ export
  // and never to a `.yft`. A timed round reports the application's fixed default (a timed game
  // ends on the clock, so the count is nominal); an untimed one reports its maximum.
  const regulationTossupCount = timed === true ? defaultRegulationTossupCount : maximumRegulation;
  notes.push(
    timed === true
      ? `Timed rounds: regulation is YellowFruit's nominal ${regulationTossupCount} tossups, and the moderator calls time.`
      : `Untimed rounds: regulation is the file's maximum of ${regulationTossupCount} tossups.`,
  );

  const maximumPlayers = asFiniteNumber(stored.maximum_players_per_team) ?? defaultMaximumPlayersPerTeam;
  const minimumOvertime =
    asFiniteNumber(stored.minimum_overtime_question_count) ?? defaultMinimumOvertimeQuestionCount;
  const lightningCount = asFiniteNumber(stored.lightning_count_per_team) ?? 0;
  const lightningDivisor = asFiniteNumber(stored.lightning_divisor) ?? defaultDivisor;
  const bonusDivisor = asFiniteNumber(stored.bonus_divisor) ?? defaultDivisor;

  const rules: JsonObject = {
    type: 'ScoringRules',
    id: options.id ?? asString(stored.id) ?? 'ScoringRules_YellowFruit',
    // A label. Nothing branches on it here or downstream.
    name: asString(stored.name) ?? 'YellowFruit scoring rules',
    // YellowFruit supports two-team matches only (`ScoringRules.teamsPerMatch` is a constant it
    // does not serialize).
    teams_per_match: 2,
    maximum_players_per_team: maximumPlayers,
    regulation_tossup_count: regulationTossupCount,
    maximum_regulation_tossup_count: maximumRegulation,
    minimum_overtime_question_count: minimumOvertime,
    // Written by YellowFruit whether or not bonuses are used; defaulted to its own initializer
    // when a hand-edited file omits it, because an absent boolean changes a score.
    overtime_includes_bonuses: usesBonuses && (asBoolean(stored.overtime_includes_bonuses) ?? false),
    total_divisor:
      asFiniteNumber(stored.total_divisor) ??
      derivedTotalDivisor(
        answerValues,
        usesBonuses ? bonusDivisor : undefined,
        lightningCount > 0 ? lightningDivisor : undefined,
      ),
    answer_types: answerTypes as unknown as JsonValue,
    lightning_count_per_team: lightningCount,
  };

  if (usesBonuses) {
    rules.maximum_bonus_score = maximumBonusScore;
    rules.bonus_divisor = bonusDivisor;
    rules.minimum_parts_per_bonus = asFiniteNumber(stored.minimum_parts_per_bonus) ?? defaultPartsPerBonus;
    rules.maximum_parts_per_bonus = asFiniteNumber(stored.maximum_parts_per_bonus) ?? defaultPartsPerBonus;
    rules.bonuses_bounce_back = asBoolean(stored.bonuses_bounce_back) ?? false;
    // Only regular bonuses have one per-part value. YellowFruit omits the field for an irregular
    // shape, and passing that omission through is what tells a scorer to take a typed total
    // rather than offering fixed buttons.
    const pointsPerBonusPart = asFiniteNumber(stored.points_per_bonus_part);
    if (pointsPerBonusPart !== undefined) rules.points_per_bonus_part = pointsPerBonusPart;
    else notes.push('Bonuses are irregular; the scorer will take a bonus total rather than parts.');
  }
  if (lightningCount > 0) {
    rules.lightning_divisor = lightningDivisor;
    notes.push(`Lightning rounds: ${lightningCount} per team, divisor ${lightningDivisor}.`);
  }

  return { ok: true, value: { rules, timed, usesBonuses, notes } };
}
