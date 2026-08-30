/**
 * Describing a game nobody scheduled.
 *
 * # One screen, not a wizard
 *
 * Everything this asks for is on one page: two teams, two rosters, the scoring rules, and the few
 * operational settings a room might want. It scrolls, which is fine — this is the five minutes
 * before a practice, not the 1366×768 scoresheet under time pressure — and it means a coach who
 * mistyped a team name can see it while typing the rules rather than pressing Back through three
 * modal steps to find out.
 *
 * There is no stepper and no "Step 1 of 3", because there are no steps: nothing here depends on
 * anything else here.
 *
 * # This screen creates nothing
 *
 * Opening it writes no record. The game exists when Start game validates, and not before — which is
 * also why `updatesAllowedOn` leaves this screen out. A half-typed pair of rosters is unsaved work,
 * and a service worker swapping the application out from under it would lose the lot.
 *
 * # Rosters, not lineups
 *
 * It asks who is *on the team*. Who starts is a different question, asked a minute before the game
 * by the existing Starting / Bench screen — and only when it needs to be, which is when a roster is
 * bigger than the number of players the format puts on the floor. A team of exactly four never sees
 * it, here or from a file. Nothing about that behaviour is special-cased for a manual game.
 *
 * # Validation happens when it is asked for
 *
 * Start game is always pressable. A disabled primary button with no explanation is a screen that
 * knows what is wrong and will not say, and the fix — enumerate the problems next to the fields
 * that caused them, and move focus to the first group — is both more useful and less work.
 */
import { FormEvent, RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { IGameDefinition } from '../game/GameDefinition';
import {
  IManualBreakInput,
  IManualGameInput,
  IManualRoundOptions,
  IManualTeamInput,
  ManualGameSection,
  defaultManualGameLabel,
  defineManualGame,
  manualRoomProcedure,
  manualRoundOptionDefaults,
  newManualBreak,
} from '../game/ManualGame';
import { readRosterLines } from '../game/Roster';
import {
  IScoringRulesInput,
  readScoringRulesInput,
  scoringRulesInputDefaults,
} from '../qbj/ScoringRulesInput';
import {
  SubstitutionPolicy,
  maximumRoomBreakLabelLength,
  maximumRoomBreakTossup,
  maximumRoomBreaks,
  maximumHalfLengthMinutes,
  maximumTimeoutDurationSeconds,
  maximumTimeoutsPerTeam,
  substitutionOpportunityPhrase,
} from '../scoring/RoomProcedure';
import { numberValue } from './BasicScoringRulesEditor';
import ScoringRulesEditor from './ScoringRulesEditor';
import useLeaveWarning from './useLeaveWarning';
import HelpTooltip from './HelpTooltip';

type DraftSaveState = 'not-saved' | 'saved' | 'failed';

/** The form as it opens: common rules, no round options, nothing typed. */
function emptyInput(): IManualGameInput {
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

function manualDraftStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
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
export function readManualGameDraft(): IManualGameInput | null {
  const storage = manualDraftStorage();
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(manualDraftStorageKey) ?? 'null') as Partial<IManualGameInput> | null;
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

export function clearManualGameDraft(): void {
  try {
    manualDraftStorage()?.removeItem(manualDraftStorageKey);
  } catch {
    // Storage may disappear between render and cancel; the leave warning remains the fallback.
  }
}

function hasManualInput(input: IManualGameInput): boolean {
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
function hasMeaningfulAdvancedOptions(options: IManualRoundOptions): boolean {
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
function cloneRules(rules: IScoringRulesInput): IScoringRulesInput {
  return rules.mode === 'advanced'
    ? { mode: 'advanced', advanced: { ...rules.advanced, answerTypes: rules.advanced.answerTypes.map((row) => ({ ...row })) } }
    : { mode: 'basic', basic: { ...rules.basic } };
}

/** Read recent team/rule presets defensively; local storage is a convenience, never a dependency. */
export function readManualGamePresets(): IManualGamePreset[] {
  const storage = manualDraftStorage();
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(manualPresetStorageKey) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): IManualGamePreset[] => {
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
    }).slice(0, 8);
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
        JSON.stringify({ left: existing.left, right: existing.right, rules: existing.rules, options: existing.options }) !==
        signature,
    ),
  ].slice(0, 8);
  try {
    manualDraftStorage()?.setItem(manualPresetStorageKey, JSON.stringify(next));
  } catch {
    // The current setup still starts; presets are only a convenience.
  }
  return next;
}

export default function ManualGameSetup(props: {
  onStart: (definition: IGameDefinition) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { onStart, onCancel } = props;
  const [input, setInput] = useState<IManualGameInput>(() => readManualGameDraft() ?? emptyInput());
  /**
   * How many times Start game has been pressed.
   *
   * A counter rather than a flag, because it is also what tells the focus effect that a *new*
   * submission failed. A second press with the same problems still has to move focus back to them,
   * and a boolean that is already true says nothing happened.
   */
  const [submissions, setSubmissions] = useState(0);
  const [startError, setStartError] = useState('');
  const [starting, setStarting] = useState(false);
  const startInFlight = useRef(false);
  const [draftSaveState, setDraftSaveState] = useState<DraftSaveState>('not-saved');
  const [presets, setPresets] = useState<IManualGamePreset[]>(() => readManualGamePresets());
  const [rosterPresetId, setRosterPresetId] = useState('');
  const [rulePresetId, setRulePresetId] = useState('defaults');
  const [advancedSetupOpen, setAdvancedSetupOpen] = useState(() => hasMeaningfulAdvancedOptions(input.options));

  const set = (patch: Partial<IManualGameInput>) => setInput((current) => ({ ...current, ...patch }));
  const setOptions = (patch: Partial<IManualRoundOptions>) =>
    setInput((current) => ({ ...current, options: { ...current.options, ...patch } }));
  const setTeam = (side: 'left' | 'right', patch: Partial<IManualTeamInput>) =>
    setInput((current) =>
      side === 'left'
        ? { ...current, left: { ...current.left, ...patch } }
        : { ...current, right: { ...current.right, ...patch } },
    );

  const result = useMemo(() => defineManualGame(input), [input]);
  const problems = useMemo(() => (result.ok ? [] : result.problems), [result]);
  const rulePresets = useMemo(
    () => [
      {
        id: 'defaults',
        label: 'QBSheet defaults',
        rules: scoringRulesInputDefaults(),
        options: { ...manualRoundOptionDefaults },
      },
      ...presets.map((preset) => ({
        id: preset.id,
        label: preset.label,
        rules: cloneRules(preset.rules),
        options: { ...preset.options },
      })),
    ],
    [presets],
  );
  const dirty = hasManualInput(input);
  const problemsIn = (section: ManualGameSection) =>
    problems.filter((problem) => problem.section === section).map((problem) => problem.message);

  useLeaveWarning({
    gameInProgress: false,
    localSaveFailed: draftSaveState === 'failed',
    handoffOutstanding: false,
    setupDirty: dirty,
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const storage = manualDraftStorage();
      if (!storage) {
        setDraftSaveState(dirty ? 'failed' : 'not-saved');
        return;
      }
      try {
        if (dirty) {
          storage.setItem(manualDraftStorageKey, JSON.stringify(input));
          setDraftSaveState('saved');
        } else {
          storage.removeItem(manualDraftStorageKey);
          setDraftSaveState('not-saved');
        }
      } catch {
        // The before-unload warning still protects a draft when local storage is unavailable, and
        // the visible status below keeps this form from claiming a write it did not make.
        setDraftSaveState('failed');
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [dirty, input]);

  // One ref each rather than an object of them, so handing one to a section is handing over the ref
  // itself. The section-to-ref lookup belongs in the effect below, which is the only thing that
  // reads through it.
  const teamsErrors = useRef<HTMLDivElement>(null);
  const rulesErrors = useRef<HTMLDivElement>(null);
  const optionsErrors = useRef<HTMLDivElement>(null);

  // After a refused submission, put the cursor on the first group that has something wrong with it.
  // A form that scrolls is a form where the complaint can be off screen, and an alert nobody sees is
  // indistinguishable from a button that did nothing.
  useEffect(() => {
    if (submissions === 0 || problems.length === 0) return;
    const errorRefs = { teams: teamsErrors, rules: rulesErrors, options: optionsErrors };
    const first = (['teams', 'rules', 'options'] as const).find(
      (section) => problems.some((problem) => problem.section === section),
    );
    if (first) errorRefs[first].current?.focus();
    // Only on a submission. Re-running as somebody types would drag focus out of the field they are
    // fixing the problem in, which is the opposite of helping.
  }, [submissions, problems]);

  const submit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (startInFlight.current) return;
    setSubmissions((count) => count + 1);
    setStartError('');
    const defined = defineManualGame(input);
    if (!defined.ok) {
      // An invalid option can be hidden inside the closed advanced disclosure. Open it in the
      // submission handler so the following focus effect lands on an error the operator can see.
      if (defined.problems.some((problem) => problem.section === 'options')) setAdvancedSetupOpen(true);
      return;
    }
    startInFlight.current = true;
    setStarting(true);
    try {
      await onStart(defined.definition);
      setPresets(rememberManualGamePreset(input));
      clearManualGameDraft();
    } catch {
      setStartError(
        'This game could not be saved locally. Your setup is still here; try again after storage is repaired.',
      );
    } finally {
      startInFlight.current = false;
      setStarting(false);
    }
  };

  const cancel = () => {
    if (dirty && !window.confirm('Discard this game setup?')) return;
    clearManualGameDraft();
    onCancel();
  };

  const showErrors = submissions > 0;

  const loadRosters = () => {
    const preset = presets.find((candidate) => candidate.id === rosterPresetId);
    if (!preset) return;
    const hasRosterDraft =
      input.left.name.trim() !== '' ||
      input.left.players.trim() !== '' ||
      input.right.name.trim() !== '' ||
      input.right.players.trim() !== '';
    if (hasRosterDraft && !window.confirm('Replace the teams and rosters in this draft?')) return;
    setInput((current) => ({ ...current, left: { ...preset.left }, right: { ...preset.right } }));
  };

  const loadRules = () => {
    const preset = rulePresets.find((candidate) => candidate.id === rulePresetId);
    if (!preset) return;
    const defaults = emptyInput();
    const hasRuleDraft =
      JSON.stringify(input.rules) !== JSON.stringify(defaults.rules) ||
      JSON.stringify(input.options) !== JSON.stringify(defaults.options);
    if (hasRuleDraft && !window.confirm('Replace the scoring rules and round options in this draft?')) return;
    setInput((current) => ({ ...current, rules: cloneRules(preset.rules), options: { ...preset.options } }));
    if (hasMeaningfulAdvancedOptions(preset.options)) setAdvancedSetupOpen(true);
  };

  const teamSide = (side: 'left' | 'right') => {
    const team = input[side];
    const named = team.name.trim();
    const position = side === 'left' ? 'Left team' : 'Right team';
    // The accessible name of a roster box has to say whose roster it is, and the team may not have
    // been named yet — so it falls back to the column rather than to nothing.
    const rosterLabel = named === '' ? `${position} players` : `${named} players`;
    return (
      <div key={side} className="manual-team">
        <label className="shell-label" htmlFor={`manual-team-${side}`}>
          {position} name
        </label>
        <input
          id={`manual-team-${side}`}
          className="shell-input"
          type="text"
          autoComplete="off"
          value={team.name}
          onChange={(event) => setTeam(side, { name: event.target.value })}
        />

        <label className="shell-label manual-roster-label" htmlFor={`manual-players-${side}`}>
          Players
        </label>
        <p className="shell-hint manual-roster-hint" id={`manual-players-${side}-hint`}>
          One player per line.
        </p>
        <textarea
          id={`manual-players-${side}`}
          className="manual-roster"
          aria-label={rosterLabel}
          aria-describedby={`manual-players-${side}-hint`}
          rows={7}
          spellCheck={false}
          value={team.players}
          onChange={(event) => setTeam(side, { players: event.target.value })}
        />
        <span className="manual-roster-count">{readRosterLines(team.players).length} players</span>
      </div>
    );
  };

  return (
    <main className="shell manual-shell">
      <header className="shell-header">
        <h1 className="shell-title">Create a game</h1>
        <p className="shell-subtitle">
          For a practice, scrimmage, tryout or pickup game. Once it starts it is an ordinary QBSheet
          game, saved on this device like any other.
        </p>
      </header>

      <section className="shell-section manual-presets" aria-labelledby="manual-presets-heading">
        <details>
          <summary id="manual-presets-heading" className="shell-heading">
            Use recent setup
          </summary>
          <p className="shell-hint">
            Successful setups stay on this device as a convenience. Loading one changes this draft; it
            does not start a game.
          </p>
          <div className="manual-preset-row">
            <div className="manual-preset-field">
              <label className="shell-label" htmlFor="manual-roster-preset">
                Recent teams &amp; rosters
              </label>
              <select
                id="manual-roster-preset"
                className="shell-input"
                value={rosterPresetId}
                onChange={(event) => setRosterPresetId(event.target.value)}
                disabled={presets.length === 0}
              >
                <option value="">Choose a recent setup…</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
              <button type="button" className="shell-button" disabled={!rosterPresetId} onClick={loadRosters}>
                Load rosters
              </button>
            </div>
            <div className="manual-preset-field">
              <label className="shell-label" htmlFor="manual-rule-preset">
                Rules and round options preset
              </label>
              <select
                id="manual-rule-preset"
                className="shell-input"
                value={rulePresetId}
                onChange={(event) => setRulePresetId(event.target.value)}
              >
                {rulePresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
              <button type="button" className="shell-button" onClick={loadRules}>
                Load rules and round options
              </button>
            </div>
          </div>
          {presets.length === 0 && <p className="shell-hint">Your first successful setup will appear here.</p>}
        </details>
      </section>

      <form aria-label="Create a game" noValidate onSubmit={submit}>
      <section className="shell-section">
        <h2 className="shell-heading">This game</h2>
        <div className="manual-field">
          <label className="shell-label" htmlFor="manual-label">
            Game label
          </label>
          <input
            id="manual-label"
            className="shell-input"
            type="text"
            autoComplete="off"
            placeholder={defaultManualGameLabel}
            value={input.gameLabel}
            onChange={(event) => set({ gameLabel: event.target.value })}
          />
          <p className="shell-hint">
            What this game is called in headers, in Recent Games, and in an exported copy. Blank means
            “{defaultManualGameLabel}”.
          </p>
        </div>
      </section>

      <section className="shell-section" aria-labelledby="manual-teams-heading">
        <h2 id="manual-teams-heading" className="shell-heading">
          Teams &amp; players
        </h2>
        <div className="manual-teams">{teamSide('left')}{teamSide('right')}</div>
        <p className="shell-hint">
          The teams do not have to be the same size, and substitutes can be added during the game.
        </p>
        <SectionErrors problems={problemsIn('teams')} show={showErrors} anchor={teamsErrors} />
      </section>

      <section className="shell-section" aria-labelledby="manual-rules-heading">
        <h2 id="manual-rules-heading" className="shell-heading">
          Scoring rules
        </h2>
        <ScoringRulesEditor
          idPrefix="manual-rules"
          basicVariant="full"
          value={input.rules}
          onChange={(rules: IScoringRulesInput) => set({ rules })}
          timedHint="A timed round ends when the moderator calls time rather than after a fixed count. QBSheet can show a clock for each play segment if breaks are configured below; otherwise the moderator keeps time."
        />
        <SectionErrors problems={problemsIn('rules')} show={showErrors} anchor={rulesErrors} />
      </section>

      <section className="shell-section manual-advanced-section" aria-labelledby="manual-options-heading">
        <details
          className="manual-advanced-setup"
          open={advancedSetupOpen}
          onToggle={(event) => setAdvancedSetupOpen(event.currentTarget.open)}
        >
          <summary id="manual-options-heading" className="shell-heading manual-advanced-summary">
            Advanced round setup
          </summary>
          <div className="manual-advanced-content">
            <p className="shell-hint manual-options-intro">
              Breaks, clocks, timeouts, substitutions, and other room-procedure options. None of this
              changes what a tossup or bonus is worth.
            </p>

        <label className="rules-setup-check" htmlFor="manual-halves">
          <input
            id="manual-halves"
            type="checkbox"
            checked={input.options.halves}
            onChange={(event) =>
              // Turning breaks off takes the settings that only exist because they were on with it.
              // A hidden break list would otherwise reach the procedure from a screen that had stopped
              // showing it, which is the one way a room gets a rule nobody can see they configured.
              setOptions(
                event.target.checked
                  ? { halves: true }
                  : { halves: false, halfLengthMinutes: undefined, breaks: undefined },
              )
            }
          />
          The round has breaks
        </label>

        {input.options.halves && (
          <div className="manual-field-inset">
            <div className="manual-field">
              <label className="shell-label" htmlFor="manual-half-length">
                Minutes of play between breaks
              </label>
              <input
                id="manual-half-length"
                className="shell-input manual-number"
                type="number"
                min={1}
                max={maximumHalfLengthMinutes}
                step={1}
                value={input.options.halfLengthMinutes === undefined ? '' : String(input.options.halfLengthMinutes)}
                onChange={(event) => setOptions({ halfLengthMinutes: numberValue(event.target.value) })}
              />
              <p className="shell-hint">Blank means QBSheet does not run the clock.</p>
            </div>

            <ManualBreaksEditor
              breaks={input.options.breaks ?? []}
              substitutionPolicy={input.options.substitutionPolicy}
              onChange={(breaks) => setOptions({ breaks })}
            />
          </div>
        )}

        <div className="manual-field">
          <label className="shell-label" htmlFor="manual-timeouts">
            Timeouts per team
          </label>
          <input
            id="manual-timeouts"
            className="shell-input manual-number"
            type="number"
            min={0}
            max={maximumTimeoutsPerTeam}
            step={1}
            value={String(input.options.timeoutsPerTeam)}
            onChange={(event) => setOptions({ timeoutsPerTeam: numberValue(event.target.value) ?? 0 })}
          />
        </div>

        {input.options.timeoutsPerTeam > 0 && (
          <div className="manual-field manual-field-inset">
            <label className="shell-label" htmlFor="manual-timeout-length">
              Timeout length in seconds
            </label>
            <input
              id="manual-timeout-length"
              className="shell-input manual-number"
              type="number"
              min={1}
              max={maximumTimeoutDurationSeconds}
              step={1}
              value={
                input.options.timeoutDurationSeconds === undefined
                  ? ''
                  : String(input.options.timeoutDurationSeconds)
              }
              onChange={(event) => setOptions({ timeoutDurationSeconds: numberValue(event.target.value) })}
            />
            <p className="shell-hint">Blank means QBSheet records the timeout but does not count it down.</p>
          </div>
        )}

        <fieldset className="manual-fieldset" aria-labelledby="manual-substitutions-legend">
          <legend className="shell-label">
            <span className="label-with-help">
              <span id="manual-substitutions-legend">Substitutions</span>
              <HelpTooltip label="About substitution timing">
                A phase checkpoint is a format-defined pause, such as halftime or the end of regulation. The
                stricter option only offers lineup changes at those pauses, configured breaks, and timeouts.
              </HelpTooltip>
            </span>
          </legend>
          {(
            [
              ['any-boundary', 'Between any tossups'],
              ['breaks-timeouts-overtime', 'Only at breaks, timeouts, or phase checkpoints'],
            ] as [SubstitutionPolicy, string][]
          ).map(([policy, label]) => (
            <label key={policy} className="rules-setup-check" htmlFor={`manual-subs-${policy}`}>
              <input
                id={`manual-subs-${policy}`}
                type="radio"
                name="manual-subs"
                value={policy}
                checked={input.options.substitutionPolicy === policy}
                onChange={() => setOptions({ substitutionPolicy: policy })}
              />
              {label}
            </label>
          ))}
          {/* The restrictive policy is only as precise as the breaks above it, so it says which ones
              it means rather than leaving the director to work out whether "breaks" covers theirs. */}
          {input.options.substitutionPolicy === 'breaks-timeouts-overtime' && (
            <p className="shell-hint manual-subs-hint">
              {`Lineup changes will be available ${substitutionOpportunityPhrase(manualRoomProcedure(input.options))}.`}
              {!input.options.halves && ' This round has no breaks configured, so only timeouts and checkpoints qualify.'}
            </p>
          )}
        </fieldset>

            <SectionErrors problems={problemsIn('options')} show={showErrors} anchor={optionsErrors} />
          </div>
        </details>
      </section>

      {startError !== '' && <p className="shell-warning" role="alert">{startError}</p>}
      {draftSaveState === 'saved' && <p className="shell-hint">Draft saved on this device while you type.</p>}
      {draftSaveState === 'failed' && (
        <p className="shell-warning" role="status">
          This browser could not save the draft while you type. Keep this tab open or repair storage before leaving.
        </p>
      )}
      <div className="shell-actions manual-actions">
        <button type="submit" className="shell-button is-primary" disabled={starting}>
          {starting ? 'Starting…' : 'Start game'}
        </button>
        <button type="button" className="shell-button" onClick={cancel}>
          Cancel
        </button>
      </div>
      </form>
    </main>
  );
}

/**
 * The points a round stops at.
 *
 * # Rows, not a comma-separated box
 *
 * "5, 10, 15" is faster to type and worse to live with: it cannot carry the name the tournament uses
 * for each break, and a typo in it is a parse error rather than a field with something wrong in it.
 * The scorer shows these names — a room at "End of set 1" is being told where it is, a room told
 * "Halftime" after tossup 5 of 24 is being told something false — so the name is worth a field.
 *
 * # Empty is a meaningful state
 *
 * No rows means the room takes one break wherever the moderator calls it, which is what every
 * procedure written before scheduled breaks existed says. So the list opens empty and says so, rather
 * than starting with a row that would quietly commit a practice game to a break after tossup 10.
 */
function ManualBreaksEditor(props: {
  breaks: IManualBreakInput[];
  substitutionPolicy: SubstitutionPolicy;
  onChange: (breaks: IManualBreakInput[] | undefined) => void;
}) {
  const { breaks, substitutionPolicy: policy, onChange } = props;

  const replace = (position: number, patch: Partial<IManualBreakInput>) =>
    onChange(breaks.map((row, index) => (index === position ? { ...row, ...patch } : row)));
  // Undefined rather than an empty array when the last row goes, so a procedure with no scheduled
  // breaks is indistinguishable from one that never had the field. See `manualRoomProcedure`.
  const remove = (position: number) => {
    const next = breaks.filter((_, index) => index !== position);
    onChange(next.length === 0 ? undefined : next);
  };

  return (
    <fieldset className="manual-fieldset manual-breaks" aria-labelledby="manual-breaks-legend">
      <legend className="shell-label">
        <span className="label-with-help">
          <span id="manual-breaks-legend">Scheduled breaks</span>
          <HelpTooltip label="Explain automatic break timing">
            Add the exact tossup numbers where QBSheet should pause automatically. Leave the list empty when the
            moderator decides when to call the break.
          </HelpTooltip>
        </span>
      </legend>
      <p className="shell-hint manual-breaks-hint">
        The tossups this round stops after. Leave this empty for a single break the moderator calls.
        {policy === 'breaks-timeouts-overtime' && ' These are the points the lineup may change at.'}
      </p>

      {breaks.length === 0 && <p className="shell-hint">No scheduled breaks.</p>}

      {breaks.map((row, position) => (
        <div key={row.key} className="manual-break-row">
          <div className="manual-break-field">
            <label className="shell-label" htmlFor={`manual-break-after-${row.key}`}>
              After tossup
            </label>
            <input
              id={`manual-break-after-${row.key}`}
              className="shell-input manual-number"
              type="number"
              inputMode="numeric"
              min={1}
              max={maximumRoomBreakTossup}
              step={1}
              value={row.afterTossup === undefined ? '' : String(row.afterTossup)}
              onChange={(event) => replace(position, { afterTossup: numberValue(event.target.value) })}
            />
          </div>
          <div className="manual-break-field manual-break-field-grow">
            <label className="shell-label" htmlFor={`manual-break-label-${row.key}`}>
              Name (optional)
            </label>
            <input
              id={`manual-break-label-${row.key}`}
              className="shell-input"
              type="text"
              autoComplete="off"
              maxLength={maximumRoomBreakLabelLength}
              placeholder={`Break ${position + 1}`}
              value={row.label}
              onChange={(event) => replace(position, { label: event.target.value })}
            />
          </div>
          <button
            type="button"
            className="shell-button manual-break-remove"
            // The row is identified by what it says, not by its position: "Remove break 2" is the same
            // words on every row after one is deleted, and a screen reader user would be pressing a
            // button whose name no longer describes what it removes.
            aria-label={`Remove the break after tossup ${row.afterTossup ?? position + 1}`}
            onClick={() => remove(position)}
          >
            Remove
          </button>
        </div>
      ))}

      {breaks.length < maximumRoomBreaks && (
        <button
          type="button"
          className="shell-button manual-break-add"
          onClick={() => onChange([...breaks, newManualBreak()])}
        >
          Add a break
        </button>
      )}
    </fieldset>
  );
}

/**
 * One group's complaints, under the fields that produced them.
 *
 * Focusable so a refused submission can land on it, and `role="alert"` so a screen reader is told
 * without having to be moved. Not rendered at all until something has been submitted, because a
 * form that complains about a team name before anybody has typed one is shouting at the empty room.
 */
function SectionErrors(props: { problems: string[]; show: boolean; anchor: RefObject<HTMLDivElement> }) {
  const { problems, show, anchor } = props;
  if (!show || problems.length === 0) return null;
  return (
    <div className="shell-errors" role="alert" tabIndex={-1} ref={anchor}>
      <ul>
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </div>
  );
}
