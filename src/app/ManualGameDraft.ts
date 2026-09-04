import {
  IManualGameInput,
  IManualRoundOptions,
  IManualTeamInput,
  defineManualGame,
  manualRoundOptionDefaults,
} from '../game/ManualGame';
import {
  IScoringRulesInput,
  readScoringRulesInput,
  scoringRulesInputDefaults,
} from '../qbj/ScoringRulesInput';

export type DraftSaveState = 'not-saved' | 'saved' | 'failed';

/** The form as it opens: common rules, no round options, nothing typed. */
export function emptyInput(): IManualGameInput {
  return {
    gameLabel: '',
    left: { name: '', players: '' },
    right: { name: '', players: '' },
    rules: scoringRulesInputDefaults(),
    options: { ...manualRoundOptionDefaults },
  };
}

/** The in-progress setup, separate from game records because it is not a game yet. */
export const manualDraftStorageKey = 'qbsheet.manual-game-draft.v1';
export const manualPresetStorageKey = 'qbsheet.manual-game-presets.v1';

export function manualDraftStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isDraftTeam(value: unknown): value is IManualTeamInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { players?: unknown }).players === 'string'
  );
}

/** Read a draft defensively; a malformed local value should never stop the welcome screen opening. */
export function readManualGameDraft(storageKey = manualDraftStorageKey): IManualGameInput | null {
  const storage = manualDraftStorage();
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) ?? 'null') as Partial<IManualGameInput> | null;
    if (
      !parsed ||
      typeof parsed.gameLabel !== 'string' ||
      !isDraftTeam(parsed.left) ||
      !isDraftTeam(parsed.right) ||
      typeof parsed.options !== 'object' ||
      parsed.options === null
    ) {
      return null;
    }
    // Migrated on read rather than behind a new storage key, because the point of a draft is that a
    // half-typed practice setup survives — including across the release that added advanced rules.
    const rules = readScoringRulesInput(parsed.rules);
    if (!rules) return null;
    return {
      gameLabel: parsed.gameLabel,
      left: parsed.left,
      right: parsed.right,
      rules,
      options: { ...manualRoundOptionDefaults, ...(parsed.options as object) },
    };
  } catch {
    return null;
  }
}

export function clearManualGameDraft(storageKey = manualDraftStorageKey): void {
  try {
    manualDraftStorage()?.removeItem(storageKey);
  } catch {
    // Storage may disappear between render and cancel; the leave warning remains the fallback.
  }
}

export function hasManualInput(input: IManualGameInput): boolean {
  return JSON.stringify(input) !== JSON.stringify(emptyInput());
}

/**
 * Whether a saved setup has anything beyond the ordinary, uncomplicated round procedure.
 *
 * The advanced disclosure starts closed for a fresh setup, but a restored draft or preset that
 * deliberately configures timing, breaks, timeouts, or substitution checkpoints should open back to
 * the controls that explain that choice. This is presentation state only; the options remain the
 * same object that is persisted and passed to `defineManualGame`.
 */
export function hasMeaningfulAdvancedOptions(options: IManualRoundOptions): boolean {
  return (
    options.halves ||
    options.halfLengthMinutes !== undefined ||
    options.timeoutsPerTeam > 0 ||
    options.timeoutDurationSeconds !== undefined ||
    options.substitutionPolicy !== manualRoundOptionDefaults.substitutionPolicy ||
    (options.breaks?.length ?? 0) > 0
  );
}

export interface IManualGamePreset {
  id: string;
  label: string;
  left: IManualTeamInput;
  right: IManualTeamInput;
  rules: IScoringRulesInput;
  options: IManualRoundOptions;
  savedAt: string;
}

function presetStorageValue(value: IManualGamePreset): IManualGamePreset {
  return {
    ...value,
    left: { ...value.left },
    right: { ...value.right },
    rules: cloneRules(value.rules),
    options: { ...value.options },
  };
}

/**
 * A copy of the rules that shares nothing with the original.
 *
 * A shallow spread would leave the advanced form's answer-type rows shared between the preset and the
 * live draft, and editing one would silently edit the other.
 */
export function cloneRules(rules: IScoringRulesInput): IScoringRulesInput {
  return rules.mode === 'advanced'
    ? {
        mode: 'advanced',
        advanced: { ...rules.advanced, answerTypes: rules.advanced.answerTypes.map((row) => ({ ...row })) },
      }
    : { mode: 'basic', basic: { ...rules.basic } };
}

/** Read recent team/rule presets defensively; local storage is a convenience, never a dependency. */
export function readManualGamePresets(): IManualGamePreset[] {
  const storage = manualDraftStorage();
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(manualPresetStorageKey) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((value): IManualGamePreset[] => {
        if (typeof value !== 'object' || value === null) return [];
        const candidate = value as Partial<IManualGamePreset>;
        if (
          typeof candidate.id !== 'string' ||
          typeof candidate.label !== 'string' ||
          typeof candidate.savedAt !== 'string' ||
          !isDraftTeam(candidate.left) ||
          !isDraftTeam(candidate.right) ||
          typeof candidate.options !== 'object' ||
          candidate.options === null
        ) {
          return [];
        }
        const rules = readScoringRulesInput(candidate.rules);
        if (!rules) return [];
        const input: IManualGameInput = {
          gameLabel: candidate.label,
          left: candidate.left,
          right: candidate.right,
          rules,
          options: { ...manualRoundOptionDefaults, ...(candidate.options as object) },
        };
        if (!defineManualGame(input).ok) return [];
        return [
          presetStorageValue({
            id: candidate.id,
            label: candidate.label,
            left: input.left,
            right: input.right,
            rules: input.rules,
            options: input.options,
            savedAt: candidate.savedAt,
          }),
        ];
      })
      .slice(0, 8);
  } catch {
    return [];
  }
}

/** Remember one successful setup, newest first, with a small bounded history. */
export function rememberManualGamePreset(input: IManualGameInput): IManualGamePreset[] {
  const preset: IManualGamePreset = {
    id: `manual-preset-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    label: input.gameLabel.trim() || `${input.left.name.trim()} vs ${input.right.name.trim()}`,
    left: { ...input.left },
    right: { ...input.right },
    rules: { ...input.rules },
    options: { ...input.options },
    savedAt: new Date().toISOString(),
  };
  const signature = JSON.stringify({
    left: preset.left,
    right: preset.right,
    rules: preset.rules,
    options: preset.options,
  });
  const next = [
    preset,
    ...readManualGamePresets().filter(
      (existing) =>
        JSON.stringify({
          left: existing.left,
          right: existing.right,
          rules: existing.rules,
          options: existing.options,
        }) !== signature,
    ),
  ].slice(0, 8);
  try {
    manualDraftStorage()?.setItem(manualPresetStorageKey, JSON.stringify(next));
  } catch {
    // The current setup still starts; presets are only a convenience.
  }
  return next;
}
