/**
 * Scoring rules a scorekeeper types in, when the document did not carry any.
 *
 * # Why this builds QBJ rather than a format
 *
 * The obvious implementation assembles an `IScorekeeperFormat` directly from the form fields. This
 * one assembles a standard `ScoringRules` object and hands it to `readQbjScoringRules` instead, so
 * a format entered by hand and a format read from a file go through exactly the same mapping,
 * validation and playability check.
 *
 * The difference shows up the first time somebody changes how bonuses are read: with one path there
 * is nothing to keep in step. With two, the typed-in format quietly diverges from the imported one
 * and only one of them gets fixed.
 *
 * # Deliberately small, and where the boundary now is
 *
 * This began as four questions for the rare generic QBJ that carried no rules at all. Creating a
 * game by hand is a rule-entry surface rather than a fallback, so the input models a little more:
 * how many players are on the floor, how long an overtime period is, whether it has bonuses in it,
 * and the one lightning shape `IScorekeeperFormat` already represents.
 *
 * It stops there. Multiple power tiers, multiple negs, irregular bonuses and anything else unusual
 * still arrive as a QBJ, which the scorer reads in full. Growing this into a complete rules
 * administration UI would be a second place for rule semantics to live, which is the thing this
 * whole arrangement exists to prevent.
 */
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { QbjObject } from './QbjSerialization';
import { QbjScoringRulesResult, readQbjScoringRules } from './QbjScoringRules';

export interface IBasicScoringRulesInput {
  /** What an ordinary correct tossup is worth. */
  tossupValue: number;
  /** The power value, when the tournament uses powers. */
  powerValue?: number;
  /** The neg value, as a negative number, when the tournament uses negs. */
  negValue?: number;
  /** Whether bonuses are used at all. */
  useBonuses: boolean;
  /** Points per bonus part, when bonuses are used and every part is worth the same. */
  pointsPerBonusPart?: number;
  /** Parts per bonus. */
  partsPerBonus?: number;
  /** Whether missed parts bounce back to the other team. */
  bonusesBounceBack?: boolean;
  tossupCount: number;
  maximumPlayersPerTeam: number;
  /**
   * Tossups in the first overtime period. 1 is sudden death under the existing engine.
   *
   * Modelled here rather than hard-coded because a form somebody uses to *state* the rules has to be
   * able to state this one; a fallback for a QBJ that forgot its rules did not.
   */
  overtimeQuestionCount?: number;
  /** Whether an overtime tossup earns a bonus. */
  overtimeIncludesBonuses?: boolean;
  /** Whether the game has lightning rounds at all. */
  useLightning?: boolean;
  /** Lightning rounds each team gets, when lightning is used. */
  lightningCountPerTeam?: number;
  /** The increment a lightning total moves in. See `IScorekeeperLightning`. */
  lightningDivisor?: number;
  /** Whether the round runs on a clock. QBJ cannot express this; see `QbtcpExtension`. */
  timed?: boolean;
  name?: string;
}

/** Sensible starting values for the form. Not a rule set, and never applied without being shown. */
export const basicScoringRulesDefaults: IBasicScoringRulesInput = {
  tossupValue: 10,
  powerValue: undefined,
  negValue: -5,
  useBonuses: true,
  pointsPerBonusPart: 10,
  partsPerBonus: 3,
  bonusesBounceBack: false,
  tossupCount: 20,
  maximumPlayersPerTeam: 4,
  overtimeQuestionCount: 1,
  overtimeIncludesBonuses: false,
  useLightning: false,
  lightningCountPerTeam: 1,
  lightningDivisor: 10,
  timed: false,
};

/** The typed-in values as a standard `ScoringRules` object. */
export function basicScoringRulesToQbj(input: IBasicScoringRulesInput): QbjObject {
  const answerTypes: QbjObject[] = [];
  if (input.powerValue !== undefined) {
    answerTypes.push({
      type: 'AnswerType',
      id: `AnswerType_${input.powerValue}`,
      value: input.powerValue,
      label: 'Power',
      short_label: 'P',
      awards_bonus: input.useBonuses,
    });
  }
  answerTypes.push({
    type: 'AnswerType',
    id: `AnswerType_${input.tossupValue}`,
    value: input.tossupValue,
    label: 'Correct',
    short_label: 'C',
    awards_bonus: input.useBonuses,
  });
  if (input.negValue !== undefined) {
    answerTypes.push({
      type: 'AnswerType',
      id: `AnswerType_${input.negValue}`,
      value: input.negValue,
      label: 'Neg',
      short_label: 'N',
      awards_bonus: false,
    });
  }

  const parts = input.partsPerBonus ?? 3;
  const perPart = input.pointsPerBonusPart ?? 10;

  return {
    type: 'ScoringRules',
    id: 'ScoringRules_Entered',
    name: input.name ?? 'Scoring rules entered in the room',
    teams_per_match: 2,
    maximum_players_per_team: input.maximumPlayersPerTeam,
    regulation_tossup_count: input.tossupCount,
    maximum_regulation_tossup_count: input.tossupCount,
    minimum_overtime_question_count: input.overtimeQuestionCount ?? 1,
    overtime_includes_bonuses: input.overtimeIncludesBonuses === true,
    answer_types: answerTypes,
    ...(input.useBonuses
      ? {
          maximum_bonus_score: perPart * parts,
          bonus_divisor: perPart,
          minimum_parts_per_bonus: parts,
          maximum_parts_per_bonus: parts,
          points_per_bonus_part: perPart,
          bonuses_bounce_back: input.bonusesBounceBack === true,
        }
      : {}),
    // Absent rather than zero when lightning is off, because `lightning_count_per_team: 0` and no
    // lightning fields at all are the same rule set and the reader already treats absence as off.
    ...(input.useLightning
      ? {
          lightning_count_per_team: input.lightningCountPerTeam ?? 1,
          lightning_divisor: input.lightningDivisor ?? 10,
        }
      : {}),
  };
}

/**
 * Read the typed-in values as a scorer format.
 *
 * Fails exactly where an imported format would fail — no positive answer type, no tossups — because
 * it is the same function doing the checking.
 */
export function readBasicScoringRules(input: IBasicScoringRulesInput): QbjScoringRulesResult {
  return readQbjScoringRules(basicScoringRulesToQbj(input), input.timed === true);
}

/**
 * Counts that have to be whole and positive before the QBJ object is worth building.
 *
 * `ScoringRules` cannot express "the number you typed is not a number", so these are checked here
 * rather than in the reader. They are field complaints, not rule semantics: everything about what a
 * game is *worth* is still decided by `readQbjScoringRules` and `scorekeeperFormatProblems` below.
 */
function fieldProblems(input: IBasicScoringRulesInput): string[] {
  const problems: string[] = [];
  const wholeAtLeastOne = (value: number | undefined, complaint: string) => {
    if (value === undefined || !Number.isInteger(value) || value < 1) problems.push(complaint);
  };

  wholeAtLeastOne(input.maximumPlayersPerTeam, 'Players playing at once must be at least 1.');
  if (input.useBonuses) {
    wholeAtLeastOne(input.partsPerBonus, 'Parts per bonus must be at least 1.');
    wholeAtLeastOne(input.pointsPerBonusPart, 'Points per bonus part must be at least 1.');
  }
  if (input.useLightning) {
    wholeAtLeastOne(input.lightningCountPerTeam, 'Lightning rounds per team must be at least 1.');
    wholeAtLeastOne(input.lightningDivisor, 'Lightning score increment must be at least 1.');
  }
  return problems;
}

/** Whether these values describe a game anybody could play. */
export function basicScoringRulesProblems(input: IBasicScoringRulesInput): string[] {
  const fields = fieldProblems(input);
  const result = readBasicScoringRules(input);
  return [...fields, ...(result.ok ? [] : result.problems)];
}

/**
 * The format, or null when the values do not describe a playable game.
 *
 * Gated on the same list the form shows, so a value the screen is complaining about cannot also be
 * the value it silently accepts.
 */
export function basicScorekeeperFormat(input: IBasicScoringRulesInput): IScorekeeperFormat | null {
  if (basicScoringRulesProblems(input).length > 0) return null;
  const result = readBasicScoringRules(input);
  return result.ok ? result.format : null;
}
