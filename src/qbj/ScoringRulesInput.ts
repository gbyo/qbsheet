/**
 * The scoring rules a screen is holding, in whichever of the two forms it is being edited in.
 *
 * # Why a wrapper rather than a wider basic input
 *
 * Adding the advanced fields to `IBasicScoringRulesInput` would have been less code and would have
 * made every consumer responsible for knowing which fields are live. A format with `answerTypes`
 * *and* a `tossupValue` has two answers to "what is a correct tossup worth", and the one that gets
 * used is whichever function happened to be called — which is a bug that only shows up as a
 * mis-scored game.
 *
 * So the two are alternatives, and the discriminant is explicit. Everything downstream asks this
 * module for problems and for a format, and never has to know which branch it is on.
 *
 * # Both branches end up in the same place
 *
 * `basic` and `advanced` each assemble a standard QBJ `ScoringRules` object and read it back through
 * `readQbjScoringRules`. This module adds no third path — it dispatches, and that is all. See the
 * header of `BasicScoringRules` for why that arrangement exists.
 */
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import {
  IBasicScoringRulesInput,
  basicScorekeeperFormat,
  basicScoringRulesDefaults,
  basicScoringRulesProblems,
  basicScoringRulesToQbj,
} from './BasicScoringRules';
import {
  IAdvancedScoringRulesInput,
  advancedFromBasic,
  advancedScorekeeperFormat,
  advancedScoringRulesProblems,
  advancedScoringRulesToQbj,
  basicFromAdvanced,
} from './AdvancedScoringRules';
import { QbjObject } from './QbjSerialization';

export type ScoringRulesMode = 'basic' | 'advanced';

export interface IBasicRulesInput {
  mode: 'basic';
  basic: IBasicScoringRulesInput;
}

export interface IAdvancedRulesInput {
  mode: 'advanced';
  advanced: IAdvancedScoringRulesInput;
}

export type IScoringRulesInput = IBasicRulesInput | IAdvancedRulesInput;

// Each constructor returns its own branch rather than the union, so a caller that just built an
// advanced value can reach into it without re-narrowing something it already knows the shape of.
export function basicRulesInput(basic: IBasicScoringRulesInput = basicScoringRulesDefaults): IBasicRulesInput {
  return { mode: 'basic', basic: { ...basic } };
}

export function advancedRulesInput(advanced: IAdvancedScoringRulesInput): IAdvancedRulesInput {
  return { mode: 'advanced', advanced };
}

/** The rules as they open: the common shape, in the simpler form. */
export function scoringRulesInputDefaults(): IScoringRulesInput {
  return basicRulesInput();
}

/**
 * Move between the two forms without changing what a game is worth.
 *
 * Basic to advanced always works, because everything the basic form can say the advanced form can say.
 * The other direction only works for a format that fits, and returns the input untouched when it does
 * not: a screen offering to simplify a format with two power tiers in it would either have to discard
 * one or lie about having done so. `advancedFitsBasicForm` is what a caller asks before offering.
 */
export function scoringRulesInputAs(input: IScoringRulesInput, mode: ScoringRulesMode): IScoringRulesInput {
  if (input.mode === mode) return input;
  if (input.mode === 'basic') return advancedRulesInput(advancedFromBasic(input.basic));
  const basic = basicFromAdvanced(input.advanced);
  return basic ? basicRulesInput(basic) : input;
}

/** The rules as a standard `ScoringRules` object, whichever form they were entered in. */
export function scoringRulesInputToQbj(input: IScoringRulesInput): QbjObject {
  return input.mode === 'advanced'
    ? advancedScoringRulesToQbj(input.advanced)
    : basicScoringRulesToQbj(input.basic);
}

/** Everything wrong with these rules, in the words the form shows. */
export function scoringRulesInputProblems(input: IScoringRulesInput): string[] {
  return input.mode === 'advanced'
    ? advancedScoringRulesProblems(input.advanced)
    : basicScoringRulesProblems(input.basic);
}

/** The format, or null when the values do not describe a playable game. */
export function scoringRulesInputFormat(input: IScoringRulesInput): IScorekeeperFormat | null {
  return input.mode === 'advanced'
    ? advancedScorekeeperFormat(input.advanced)
    : basicScorekeeperFormat(input.basic);
}

/** Whether this round runs on a clock, which is the one field both forms carry outside QBJ. */
export function scoringRulesInputIsTimed(input: IScoringRulesInput): boolean {
  return (input.mode === 'advanced' ? input.advanced.timed : input.basic.timed) === true;
}

/** How many tossups regulation is, which the round-options validation needs to place a break. */
export function scoringRulesInputTossupCount(input: IScoringRulesInput): number {
  return input.mode === 'advanced' ? input.advanced.tossupCount ?? 0 : input.basic.tossupCount ?? 0;
}

/**
 * Read rules out of local storage or a saved preset.
 *
 * Tolerant of the shape that predates the advanced form: a stored object with no `mode` on it is a
 * bare `IBasicScoringRulesInput`, which is what every draft and preset already on a device contains.
 * Migrating on read rather than bumping the storage key keeps a coach's half-typed practice setup,
 * which is the only reason a draft exists.
 */
export function readScoringRulesInput(value: unknown): IScoringRulesInput | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as { mode?: unknown; basic?: unknown; advanced?: unknown };

  if (raw.mode === 'advanced') {
    if (typeof raw.advanced !== 'object' || raw.advanced === null) return null;
    const stored = raw.advanced as Partial<IAdvancedScoringRulesInput>;
    // Answer types are the one field with no sensible default: a format with none of them is not a
    // format, and inventing a 10-point tossup would be quietly substituting somebody else's rules.
    if (!Array.isArray(stored.answerTypes)) return null;
    return advancedRulesInput({ ...advancedFromBasic(basicScoringRulesDefaults), ...stored });
  }

  if (raw.mode === 'basic') {
    if (typeof raw.basic !== 'object' || raw.basic === null) return null;
    return basicRulesInput({ ...basicScoringRulesDefaults, ...(raw.basic as object) });
  }

  // The pre-advanced shape: the basic fields, stored bare.
  return basicRulesInput({ ...basicScoringRulesDefaults, ...(value as object) });
}
