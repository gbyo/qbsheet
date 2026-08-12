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
import { RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { IGameDefinition } from '../game/GameDefinition';
import {
  IManualGameInput,
  IManualRoundOptions,
  IManualTeamInput,
  ManualGameSection,
  defaultManualGameLabel,
  defineManualGame,
  manualRoundOptionDefaults,
} from '../game/ManualGame';
import { readRosterLines } from '../game/Roster';
import { IBasicScoringRulesInput, basicScoringRulesDefaults } from '../qbj/BasicScoringRules';
import { SubstitutionPolicy } from '../scoring/RoomProcedure';
import BasicScoringRulesEditor, { numberValue } from './BasicScoringRulesEditor';

/** The form as it opens: common rules, no round options, nothing typed. */
function emptyInput(): IManualGameInput {
  return {
    gameLabel: '',
    left: { name: '', players: '' },
    right: { name: '', players: '' },
    rules: { ...basicScoringRulesDefaults },
    options: { ...manualRoundOptionDefaults },
  };
}

export default function ManualGameSetup(props: {
  onStart: (definition: IGameDefinition) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { onStart, onCancel } = props;
  const [input, setInput] = useState<IManualGameInput>(emptyInput);
  /**
   * How many times Start game has been pressed.
   *
   * A counter rather than a flag, because it is also what tells the focus effect that a *new*
   * submission failed. A second press with the same problems still has to move focus back to them,
   * and a boolean that is already true says nothing happened.
   */
  const [submissions, setSubmissions] = useState(0);

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
  const problems = result.ok ? [] : result.problems;
  const problemsIn = (section: ManualGameSection) =>
    problems.filter((problem) => problem.section === section).map((problem) => problem.message);

  const errorRefs = {
    teams: useRef<HTMLDivElement>(null),
    rules: useRef<HTMLDivElement>(null),
    options: useRef<HTMLDivElement>(null),
  };

  // After a refused submission, put the cursor on the first group that has something wrong with it.
  // A form that scrolls is a form where the complaint can be off screen, and an alert nobody sees is
  // indistinguishable from a button that did nothing.
  useEffect(() => {
    if (submissions === 0 || problems.length === 0) return;
    const first = (['teams', 'rules', 'options'] as const).find(
      (section) => problems.some((problem) => problem.section === section),
    );
    if (first) errorRefs[first].current?.focus();
    // Only on a submission. Re-running as somebody types would drag focus out of the field they are
    // fixing the problem in, which is the opposite of helping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissions]);

  const submit = () => {
    setSubmissions((count) => count + 1);
    const defined = defineManualGame(input);
    if (defined.ok) void onStart(defined.definition);
  };

  const showErrors = submissions > 0;

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
        <SectionErrors problems={problemsIn('teams')} show={showErrors} anchor={errorRefs.teams} />
      </section>

      <section className="shell-section" aria-labelledby="manual-rules-heading">
        <h2 id="manual-rules-heading" className="shell-heading">
          Scoring rules
        </h2>
        <BasicScoringRulesEditor
          idPrefix="manual-rules"
          variant="full"
          value={input.rules}
          onChange={(rules: IBasicScoringRulesInput) => set({ rules })}
          timedHint="A timed round ends when the moderator calls time rather than after a fixed count. QBSheet can show a half clock if halves are configured below; otherwise the moderator keeps time."
        />
        <SectionErrors problems={problemsIn('rules')} show={showErrors} anchor={errorRefs.rules} />
      </section>

      <section className="shell-section" aria-labelledby="manual-options-heading">
        <h2 id="manual-options-heading" className="shell-heading">
          Round options
        </h2>
        <p className="shell-hint manual-options-intro">
          How the room runs the game. None of this changes what anything is worth.
        </p>

        <label className="rules-setup-check" htmlFor="manual-halves">
          <input
            id="manual-halves"
            type="checkbox"
            checked={input.options.halves}
            onChange={(event) => setOptions({ halves: event.target.checked })}
          />
          Play in halves
        </label>

        {input.options.halves && (
          <div className="manual-field manual-field-inset">
            <label className="shell-label" htmlFor="manual-half-length">
              Half length in minutes
            </label>
            <input
              id="manual-half-length"
              className="shell-input manual-number"
              type="number"
              value={input.options.halfLengthMinutes === undefined ? '' : String(input.options.halfLengthMinutes)}
              onChange={(event) => setOptions({ halfLengthMinutes: numberValue(event.target.value) })}
            />
            <p className="shell-hint">Blank means QBSheet does not run the clock.</p>
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

        <fieldset className="manual-fieldset">
          <legend className="shell-label">Substitutions</legend>
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
        </fieldset>

        <SectionErrors problems={problemsIn('options')} show={showErrors} anchor={errorRefs.options} />
      </section>

      <div className="shell-actions">
        <button type="button" className="shell-button is-primary" onClick={submit}>
          Start game
        </button>
        <button type="button" className="shell-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </main>
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
