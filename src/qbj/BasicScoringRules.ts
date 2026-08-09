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
 * # Deliberately small
 *
 * Four questions: what a tossup is worth, whether there are powers and negs, what a bonus is worth,
 * and how long a game is. That is enough to score the overwhelming majority of tournaments, and a
 * generic QBJ arriving with no rules at all is uncommon enough that a full rules editor would be a
 * large surface maintained for a rare case — and a second place for rule semantics to live, which
 * is the thing this migration is trying to stop.
 *
 * A tournament with an irregular bonus structure or lightning rounds is better served by its
 * director exporting rules in the QBJ, which is the supported path and the one this asks for.
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
      awards_bonus: true,
    });
  }
  answerTypes.push({
    type: 'AnswerType',
    id: `AnswerType_${input.tossupValue}`,
    value: input.tossupValue,
    label: 'Correct',
    short_label: 'C',
    awards_bonus: true,
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
    minimum_overtime_question_count: 1,
    overtime_includes_bonuses: false,
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

/** Whether these values describe a game anybody could play. */
export function basicScoringRulesProblems(input: IBasicScoringRulesInput): string[] {
  const result = readBasicScoringRules(input);
  return result.ok ? [] : result.problems;
}

/** The format, or null when the values do not describe a playable game. */
export function basicScorekeeperFormat(input: IBasicScoringRulesInput): IScorekeeperFormat | null {
  const result = readBasicScoringRules(input);
  return result.ok ? result.format : null;
}
