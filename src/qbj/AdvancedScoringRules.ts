/**
 * A scoring format stated in full, rather than in the four questions most formats need.
 *
 * # Why this is not a second scoring engine
 *
 * `IScorekeeperFormat` was deliberately built to describe anything the reference implementation can
 * represent: an arbitrary list of answer types, irregular bonuses, arbitrary tossup values, lightning.
 * The scorer reads all of it. What could not *state* all of it was the entry form — one correct value,
 * one optional power, one optional neg, regular bonuses — so a tournament with two power tiers or a
 * bonus whose parts are worth 10/10/20 had to arrive as a QBJ document or not at all.
 *
 * This closes that gap the same way `BasicScoringRules` does, and for the same reason: it assembles a
 * standard `ScoringRules` object and hands it to `readQbjScoringRules`. It contains no judgement about
 * what a bonus is worth, no rule about which answer types earn one, and no playability check. Every
 * one of those already exists, once, in the path a file goes through.
 *
 * The alternative — building an `IScorekeeperFormat` field by field from the form — is why this file
 * reads the way it does. Two constructions of the same descriptor diverge the first time anybody
 * changes how a divisor is derived, and the typed-in one is the copy nobody notices is wrong until a
 * game has been scored under it.
 *
 * # Where it stops
 *
 * At the boundary of what QBJ `ScoringRules` can say. There is no field here that `readQbjScoringRules`
 * does not read, and nothing invented for the form's convenience: `awards_bonus` is per answer type
 * because QBJ puts it there, and the bonus shape is the QBJ bonus fields rather than a friendlier
 * abstraction over them.
 *
 * # Irregular bonuses
 *
 * A regular bonus is every bonus having the same number of parts, each worth the same — which is
 * exactly what lets the scorer offer fixed buttons instead of a typed total. An irregular one is stated
 * as what QBJ states: a maximum score, a divisor, and a range of part counts. `points_per_bonus_part`
 * is then deliberately absent, because a single per-part value is the thing that is not true.
 */
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { QbjObject } from './QbjSerialization';
import { IBasicScoringRulesInput, basicScoringRulesDefaults } from './BasicScoringRules';
import { QbjScoringRulesResult, readQbjScoringRules } from './QbjScoringRules';

/**
 * One row of the answer-type table.
 *
 * `value` is optional because a row somebody has just added and not yet filled in is a row, not an
 * answer type worth zero points. The distinction is the whole reason this is a separate shape from
 * `IScorekeeperAnswerType`.
 */
export interface IAdvancedAnswerTypeInput {
  /**
   * Row identity, for React keys and for reordering.
   *
   * Never the point value and never the index: keying on the value being edited remounts the row on
   * every keystroke and takes the caret with it, and keying on the index makes a reorder look like an
   * edit of two rows.
   */
  key: string;
  value?: number;
  label: string;
  shortLabel: string;
  /**
   * Whether converting this earns a bonus.
   *
   * Stated rather than derived, because QBJ states it. Left alone it follows the reference
   * implementation's own behavior — a buzz worth positive points earns a bonus — which is what
   * `readQbjScoringRules` falls back to when a document is silent.
   */
  awardsBonus: boolean;
}

/** How this tournament's bonuses are shaped. See the note on irregular bonuses above. */
export type AdvancedBonusStructure =
  /** Every bonus has the same number of parts, each worth the same. Fixed buttons in the scorer. */
  | 'regular'
  /** Parts vary in value or in number. The scorer takes a typed total. */
  | 'irregular';

export interface IAdvancedScoringRulesInput {
  /** In any order the form likes; `readQbjScoringRules` sorts descending by value as a file would be. */
  answerTypes: IAdvancedAnswerTypeInput[];

  useBonuses: boolean;
  bonusStructure: AdvancedBonusStructure;
  /** Regular bonuses only: what one part is worth. */
  pointsPerBonusPart?: number;
  /** Regular bonuses only: how many parts every bonus has. */
  partsPerBonus?: number;
  /** Irregular bonuses: the most a bonus can be worth. */
  maximumBonusScore?: number;
  /** Irregular bonuses: the increment a bonus total moves in. */
  bonusDivisor?: number;
  /** Irregular bonuses: the fewest parts a bonus has. */
  minimumPartsPerBonus?: number;
  /** Irregular bonuses: the most parts a bonus has. */
  maximumPartsPerBonus?: number;
  bonusesBounceBack: boolean;

  tossupCount: number;
  /** The longest a regulation can run, where that differs from the planned length. */
  maximumTossupCount?: number;
  maximumPlayersPerTeam: number;

  overtimeQuestionCount?: number;
  overtimeIncludesBonuses?: boolean;

  useLightning?: boolean;
  lightningCountPerTeam?: number;
  lightningDivisor?: number;

  /** Whether the round runs on a clock. QBJ cannot express this; see `QbtcpExtension`. */
  timed?: boolean;
  name?: string;
}

/** Row keys are unique within a page. Sequenced so two rows added in one millisecond still differ. */
let answerTypeSequence = 0;
export function newAdvancedAnswerType(
  seed: Partial<Omit<IAdvancedAnswerTypeInput, 'key'>> = {},
): IAdvancedAnswerTypeInput {
  answerTypeSequence += 1;
  return {
    key: `answer-type-${Date.now().toString(36)}-${answerTypeSequence.toString(36)}`,
    label: '',
    shortLabel: '',
    awardsBonus: true,
    ...seed,
  };
}

/**
 * What a basic format looks like once it is spelled out.
 *
 * Switching a form from basic to advanced must not lose what was typed, and must not change what the
 * game is worth. So the conversion is mechanical: the power, correct and neg values become three rows
 * in the order the reference implementation would sort them, and every other field carries across.
 *
 * `awardsBonus` follows `useBonuses` rather than being true for every positive row, which is what
 * `basicScoringRulesToQbj` writes for the same format. A bonus-free format whose rows still claim a
 * bonus is not the same rule set read back: `bonusesAreUsed` takes one `awards_bonus: true` as
 * evidence that bonuses are in play, so the advanced form would open on a format that cannot start a
 * game, complaining about bonus fields for bonuses the scorekeeper turned off.
 */
export function advancedFromBasic(basic: IBasicScoringRulesInput): IAdvancedScoringRulesInput {
  const answerTypes: IAdvancedAnswerTypeInput[] = [];
  if (basic.powerValue !== undefined) {
    answerTypes.push(
      newAdvancedAnswerType({
        value: basic.powerValue,
        label: 'Power',
        shortLabel: 'P',
        awardsBonus: basic.useBonuses,
      }),
    );
  }
  answerTypes.push(
    newAdvancedAnswerType({
      value: basic.tossupValue,
      label: 'Correct',
      shortLabel: 'C',
      awardsBonus: basic.useBonuses,
    }),
  );
  if (basic.negValue !== undefined) {
    answerTypes.push(
      newAdvancedAnswerType({ value: basic.negValue, label: 'Neg', shortLabel: 'N', awardsBonus: false }),
    );
  }

  return {
    answerTypes,
    useBonuses: basic.useBonuses,
    bonusStructure: 'regular',
    pointsPerBonusPart: basic.pointsPerBonusPart,
    partsPerBonus: basic.partsPerBonus,
    bonusesBounceBack: basic.bonusesBounceBack === true,
    tossupCount: basic.tossupCount,
    maximumPlayersPerTeam: basic.maximumPlayersPerTeam,
    overtimeQuestionCount: basic.overtimeQuestionCount,
    overtimeIncludesBonuses: basic.overtimeIncludesBonuses,
    useLightning: basic.useLightning,
    lightningCountPerTeam: basic.lightningCountPerTeam,
    lightningDivisor: basic.lightningDivisor,
    timed: basic.timed,
    name: basic.name,
  };
}

/** The advanced form as it opens, when nothing was typed in the basic one. */
export function advancedScoringRulesDefaults(): IAdvancedScoringRulesInput {
  return advancedFromBasic(basicScoringRulesDefaults);
}

/**
 * Whether an advanced format says only things the basic form could also say.
 *
 * Asked before offering to go back, because going back has to either preserve the format or refuse.
 * Silently discarding a second power tier on the way to a simpler screen would be the worst of the
 * three options: the form would then be showing a format nobody entered.
 */
export function advancedFitsBasicForm(input: IAdvancedScoringRulesInput): boolean {
  if (input.bonusStructure !== 'regular') return false;
  const values = input.answerTypes.map((type) => type.value).filter((value): value is number => value !== undefined);
  if (values.length !== input.answerTypes.length) return false;

  const positives = values.filter((value) => value > 0);
  const negatives = values.filter((value) => value < 0);
  // Zero-point answer types are a real thing the advanced form can state and the basic one cannot.
  if (values.some((value) => value === 0)) return false;
  if (negatives.length > 1) return false;
  // One ordinary value and at most one power above it is the whole of what the basic grid holds.
  if (positives.length < 1 || positives.length > 2) return false;
  // The basic form's `awardsBonus` is derived rather than stated: with bonuses on, a positive value
  // earns one and a neg does not; with bonuses off, nothing does. So a row that disagrees is a rule
  // the basic fields cannot state, and going back would change what a game is worth.
  return input.answerTypes.every((type) => type.awardsBonus === (input.useBonuses && (type.value ?? 0) > 0));
}

/**
 * The advanced format as basic fields, for a form going back to the simpler screen.
 *
 * Only meaningful when `advancedFitsBasicForm` is true, and returns null otherwise rather than
 * producing a lossy approximation the caller might use anyway.
 */
export function basicFromAdvanced(input: IAdvancedScoringRulesInput): IBasicScoringRulesInput | null {
  if (!advancedFitsBasicForm(input)) return null;
  const values = input.answerTypes
    .map((type) => type.value as number)
    .slice()
    .sort((a, b) => b - a);
  const positives = values.filter((value) => value > 0);
  const negative = values.find((value) => value < 0);

  return {
    ...basicScoringRulesDefaults,
    // Descending, so with two positives the larger is the power and the smaller is the ordinary value.
    tossupValue: positives[positives.length - 1],
    powerValue: positives.length === 2 ? positives[0] : undefined,
    negValue: negative,
    useBonuses: input.useBonuses,
    pointsPerBonusPart: input.pointsPerBonusPart,
    partsPerBonus: input.partsPerBonus,
    bonusesBounceBack: input.bonusesBounceBack,
    tossupCount: input.tossupCount,
    maximumPlayersPerTeam: input.maximumPlayersPerTeam,
    overtimeQuestionCount: input.overtimeQuestionCount,
    overtimeIncludesBonuses: input.overtimeIncludesBonuses,
    useLightning: input.useLightning,
    lightningCountPerTeam: input.lightningCountPerTeam,
    lightningDivisor: input.lightningDivisor,
    timed: input.timed,
    name: input.name,
  };
}

/**
 * An answer type's QBJ id.
 *
 * Keyed on the point value, which is what `basicScoringRulesToQbj` does — one convention for
 * hand-entered formats, not two — and which is the only one that is actually unique here. The
 * reference implementation derives its id from the label, and two answer types sharing a label
 * therefore share an id; this form makes that easy to do by accident, since a label is free text and a
 * row is allowed to have none. `fieldProblems` refuses two rows worth the same, so a value-keyed id
 * cannot collide.
 *
 * Nothing downstream keys on it regardless — the scorer uses `index`; see
 * `IScorekeeperAnswerType.index` — and it exists for QBJ ref pointers on export.
 */
function answerTypeId(type: IAdvancedAnswerTypeInput): string {
  return `AnswerType_${String(type.value ?? 0)}`;
}

/** The typed-in values as a standard `ScoringRules` object. */
export function advancedScoringRulesToQbj(input: IAdvancedScoringRulesInput): QbjObject {
  const answerTypes: QbjObject[] = input.answerTypes
    .filter((type) => type.value !== undefined)
    .map((type) => {
      const label = type.label.trim();
      const shortLabel = type.shortLabel.trim();
      return {
        type: 'AnswerType',
        id: answerTypeId(type),
        value: type.value as number,
        // Absent rather than blank, so the reader's own fallback decides — which keeps a label-less
        // row here identical to a label-less answer type in an imported document.
        ...(label !== '' ? { label } : {}),
        ...(shortLabel !== '' ? { short_label: shortLabel } : {}),
        awards_bonus: type.awardsBonus,
      };
    });

  const regular = input.bonusStructure === 'regular';
  const perPart = input.pointsPerBonusPart;
  const parts = input.partsPerBonus;

  const bonusFields: QbjObject = regular
    ? {
        maximum_bonus_score: (perPart ?? 0) * (parts ?? 0),
        bonus_divisor: perPart ?? 0,
        minimum_parts_per_bonus: parts ?? 0,
        maximum_parts_per_bonus: parts ?? 0,
        points_per_bonus_part: perPart ?? 0,
        bonuses_bounce_back: input.bonusesBounceBack,
      }
    : {
        maximum_bonus_score: input.maximumBonusScore ?? 0,
        bonus_divisor: input.bonusDivisor ?? 0,
        minimum_parts_per_bonus: input.minimumPartsPerBonus ?? 0,
        maximum_parts_per_bonus: input.maximumPartsPerBonus ?? 0,
        // No `points_per_bonus_part`. A single per-part value is precisely what an irregular bonus does
        // not have, and stating one would make the reader call this format regular.
        bonuses_bounce_back: input.bonusesBounceBack,
      };

  return {
    type: 'ScoringRules',
    id: 'ScoringRules_Entered',
    name: input.name ?? 'Scoring rules entered in the room',
    teams_per_match: 2,
    maximum_players_per_team: input.maximumPlayersPerTeam,
    regulation_tossup_count: input.tossupCount,
    maximum_regulation_tossup_count: input.maximumTossupCount ?? input.tossupCount,
    minimum_overtime_question_count: input.overtimeQuestionCount ?? 1,
    overtime_includes_bonuses: input.overtimeIncludesBonuses === true,
    answer_types: answerTypes,
    ...(input.useBonuses ? bonusFields : {}),
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

/** Read the typed-in values as a scorer format, through the path an imported document takes. */
export function readAdvancedScoringRules(input: IAdvancedScoringRulesInput): QbjScoringRulesResult {
  return readQbjScoringRules(advancedScoringRulesToQbj(input), input.timed === true);
}

/**
 * Counts and values that have to be filled in before the QBJ object is worth building.
 *
 * `ScoringRules` cannot express "that box is empty" or "you typed two answer types worth 10", so those
 * are checked here. Everything about what a game is *worth* is still decided by `readQbjScoringRules`
 * and `scorekeeperFormatProblems`.
 */
function fieldProblems(input: IAdvancedScoringRulesInput): string[] {
  const problems: string[] = [];
  const wholeAtLeastOne = (value: number | undefined, complaint: string) => {
    if (value === undefined || !Number.isInteger(value) || value < 1) problems.push(complaint);
  };

  // --- answer types ---------------------------------------------------------------------------
  if (input.answerTypes.length === 0) {
    problems.push('Add at least one way to answer a tossup.');
  }
  const named = (type: IAdvancedAnswerTypeInput, position: number) =>
    type.label.trim() !== '' ? `"${type.label.trim()}"` : `Answer type ${position + 1}`;
  const seenValues = new Set<number>();
  input.answerTypes.forEach((type, position) => {
    const which = named(type, position);
    if (type.value === undefined) {
      problems.push(`${which} needs a point value.`);
      return;
    }
    if (!Number.isInteger(type.value)) {
      problems.push(`${which} must be worth a whole number of points.`);
      return;
    }
    // Two answer types worth the same is not a rule set; it is a row somebody meant to edit. The
    // scorer would show two identical buttons and no way to tell which one it recorded.
    if (seenValues.has(type.value)) {
      problems.push(`Two answer types are worth ${type.value} points.`);
      return;
    }
    seenValues.add(type.value);
  });

  wholeAtLeastOne(input.maximumPlayersPerTeam, 'Players playing at once must be at least 1.');

  if (input.maximumTossupCount !== undefined && input.maximumTossupCount < input.tossupCount) {
    problems.push('The maximum tossup count cannot be below the regulation tossup count.');
  }

  // --- bonuses --------------------------------------------------------------------------------
  if (input.useBonuses) {
    if (input.bonusStructure === 'regular') {
      wholeAtLeastOne(input.partsPerBonus, 'Parts per bonus must be at least 1.');
      wholeAtLeastOne(input.pointsPerBonusPart, 'Points per bonus part must be at least 1.');
    } else {
      wholeAtLeastOne(input.maximumBonusScore, 'The maximum bonus score must be at least 1.');
      wholeAtLeastOne(input.bonusDivisor, 'The bonus score increment must be at least 1.');
      wholeAtLeastOne(input.minimumPartsPerBonus, 'The fewest parts per bonus must be at least 1.');
      wholeAtLeastOne(input.maximumPartsPerBonus, 'The most parts per bonus must be at least 1.');
      const fewest = input.minimumPartsPerBonus;
      const most = input.maximumPartsPerBonus;
      if (fewest !== undefined && most !== undefined && fewest > most) {
        problems.push('The fewest parts per bonus cannot exceed the most parts per bonus.');
      }
      if (
        input.maximumBonusScore !== undefined &&
        input.bonusDivisor !== undefined &&
        input.bonusDivisor > 0 &&
        input.maximumBonusScore % input.bonusDivisor !== 0
      ) {
        problems.push('The maximum bonus score must be a multiple of the bonus score increment.');
      }
    }
    if (!input.answerTypes.some((type) => type.awardsBonus)) {
      problems.push('This format uses bonuses but no answer type earns one.');
    }
  } else {
    // The other direction, which is the one a scorekeeper hits by accident: the bonus checkbox on a
    // row is still there when bonuses are off. `advancedScoringRulesToQbj` writes no bonus fields but
    // does write the flag, and `bonusesAreUsed` reads that flag as bonuses being in play — so without
    // this the screen complains about missing bonus structure for bonuses nobody asked for, naming
    // none of the rows that caused it.
    input.answerTypes.forEach((type, position) => {
      if (type.awardsBonus) {
        problems.push(`${named(type, position)} earns a bonus, but this format does not use bonuses.`);
      }
    });
  }

  if (input.useLightning) {
    wholeAtLeastOne(input.lightningCountPerTeam, 'Lightning rounds per team must be at least 1.');
    wholeAtLeastOne(input.lightningDivisor, 'Lightning score increment must be at least 1.');
  }

  return problems;
}

/** Whether these values describe a game anybody could play. */
export function advancedScoringRulesProblems(input: IAdvancedScoringRulesInput): string[] {
  const fields = fieldProblems(input);
  const result = readAdvancedScoringRules(input);
  return [...fields, ...(result.ok ? [] : result.problems)];
}

/**
 * The format, or null when the values do not describe a playable game.
 *
 * Gated on the same list the form shows, so a value the screen is complaining about cannot also be the
 * value it silently accepts.
 */
export function advancedScorekeeperFormat(input: IAdvancedScoringRulesInput): IScorekeeperFormat | null {
  if (advancedScoringRulesProblems(input).length > 0) return null;
  const result = readAdvancedScoringRules(input);
  return result.ok ? result.format : null;
}
