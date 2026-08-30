/**
 * The two answers to "the room just did something the procedure does not allow".
 *
 * # Why one dialog and not two menu entries
 *
 * Because the room does not know which of them it needs until it is standing in front of the
 * problem, and the problem is always the same shape: *Central A has already used its timeout* and a
 * coach is asking for another. There are exactly two true explanations —
 *
 *   - the director allowed this one, and the procedure is otherwise right, or
 *   - the procedure was never right, and this room has been running on the wrong settings —
 *
 * and they lead to two completely different records. The first is a fact about this game that must
 * be visible on the result afterwards. The second is a configuration correction that changes what
 * the room may do for the rest of the round, and changes nothing about what already happened.
 *
 * Making the scorekeeper find the right one of two menu entries under time pressure is asking them
 * to know the difference before they have been shown it. So the question is asked here, in the
 * sentence they arrived on, with the common answer first.
 *
 * # Nothing here is on screen during an ordinary game
 *
 * There is no permanent control for any of this. Every route in lands from something that was
 * actually refused, or from Game details, which is where somebody looking at the game's own
 * configuration already is.
 */
import { useMemo, useState } from 'react';
import ScorerDialog from './ScorerDialog';
import { LeftOrRight } from '../scoring/types';
import { IDerivedGame } from '../scoring/deriveGame';
import { ProcedureAllowance, ProcedureAuthority, ScoreEvent } from '../scoring/ScoreEvents';
import {
  allowanceNeedsTeam,
  procedureAllowanceLabels,
  procedureAllowances,
} from '../scoring/ProcedureExceptions';
import {
  IRoomBreak,
  IRoomProcedure,
  defaultRoomProcedure,
  maximumTimeoutsPerTeam,
  roomBreaks,
} from '../scoring/RoomProcedure';
import correctProcedure from '../scoring/procedureCorrection';
import { ScoreEventEscape } from '../scoring/canApplyScoreEvent';

/**
 * Which configured rule the scorekeeper arrived here about.
 *
 * Comes straight from the refusal that sent them; see `ScoreEventEscape`. It decides which allowance
 * the exception form opens on and which part of the procedure form is worth reading first, and
 * nothing else.
 */
export type ProcedureTopic = ScoreEventEscape;

/** The exception that best matches the thing the room was just refused. */
const topicAllowance: Record<ProcedureTopic, ProcedureAllowance> = {
  'timeout-allowance': 'extra-timeout',
  'substitution-opportunity': 'substitution',
  'break-schedule': 'extra-break',
  'regulation-length': 'extra-tossup',
};

const topicHeading: Record<ProcedureTopic, string> = {
  'timeout-allowance': 'Timeouts',
  'substitution-opportunity': 'Lineup changes',
  'break-schedule': 'Breaks',
  'regulation-length': 'Regulation length',
};

const authorityOptions: { value: ProcedureAuthority; label: string }[] = [
  { value: 'tournament-director', label: 'The tournament director' },
  { value: 'moderator', label: 'The moderator' },
  { value: 'other', label: 'Somebody else' },
];

export interface IProcedureExceptionInput {
  allowance: ProcedureAllowance;
  authority: ProcedureAuthority;
  reason: string;
  team?: LeftOrRight;
}

/**
 * Record that somebody with the standing to do so allowed one departure from procedure.
 *
 * Four controls, three of which come pre-answered when the scorekeeper arrived from a refusal. The
 * one that never is, and never can be, is the reason: it is the whole value of the record.
 */
export function ProcedureExceptionForm(props: {
  game: IDerivedGame;
  /** Preselected from whatever was refused. */
  topic?: ProcedureTopic;
  /** Preselected when the refusal was about one team. */
  team?: LeftOrRight;
  /** Allowances that cannot be granted right now, with the engine's reason. */
  refusalFor: (input: IProcedureExceptionInput) => string | undefined;
  onRecord: (input: IProcedureExceptionInput) => void;
  disabled?: boolean;
}) {
  const { game, topic, team, refusalFor, onRecord, disabled = false } = props;
  const [allowance, setAllowance] = useState<ProcedureAllowance>(
    topic ? topicAllowance[topic] : 'extra-timeout',
  );
  const [side, setSide] = useState<LeftOrRight>(team ?? 'left');
  const [authority, setAuthority] = useState<ProcedureAuthority>('tournament-director');
  const [reason, setReason] = useState('');

  const needsTeam = allowanceNeedsTeam(allowance);
  const input: IProcedureExceptionInput = {
    allowance,
    authority,
    reason: reason.trim(),
    ...(needsTeam ? { team: side } : {}),
  };
  // Asked of the engine rather than restated here, so the form can never offer a grant the guard
  // would then refuse — the defect `expectsBonus` was extracted to prevent, one dialog along.
  const refusal = refusalFor({ ...input, reason: reason.trim() || 'placeholder' });

  return (
    <form
      className="scorer-note-form"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        if (reason.trim() === '' || refusal !== undefined || disabled) return;
        onRecord(input);
      }}
    >
      <label htmlFor="scorer-exception-allowance">
        What was allowed
        <select
          id="scorer-exception-allowance"
          value={allowance}
          onChange={(changeEvent) => setAllowance(changeEvent.target.value as ProcedureAllowance)}
        >
          {procedureAllowances.map((value) => (
            <option key={value} value={value}>
              {procedureAllowanceLabels[value]}
            </option>
          ))}
        </select>
      </label>
      {needsTeam && (
        <label htmlFor="scorer-exception-team">
          For which team
          <select
            id="scorer-exception-team"
            value={side}
            onChange={(changeEvent) => setSide(changeEvent.target.value as LeftOrRight)}
          >
            <option value="left">{game.left.name}</option>
            <option value="right">{game.right.name}</option>
          </select>
        </label>
      )}
      <label htmlFor="scorer-exception-authority">
        Who allowed it
        <select
          id="scorer-exception-authority"
          value={authority}
          onChange={(changeEvent) => setAuthority(changeEvent.target.value as ProcedureAuthority)}
        >
          {authorityOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor="scorer-exception-reason">
        Why
        <input
          id="scorer-exception-reason"
          data-dialog-autofocus
          value={reason}
          maxLength={300}
          placeholder="Director ruled the first timeout did not count"
          onChange={(changeEvent) => setReason(changeEvent.target.value)}
        />
      </label>
      <p className="scorer-dialog-note">
        Required. It is recorded on the result beside the thing it allowed, so the round can be explained
        afterwards.
      </p>
      {refusal !== undefined && (
        <p className="scorer-problem" role="alert">
          {refusal}
        </p>
      )}
      <button
        type="submit"
        className="scorer-choice"
        disabled={disabled || reason.trim() === '' || refusal !== undefined}
      >
        Record this ruling
      </button>
    </form>
  );
}

/** `5, 10, 15` — the breaks as an editable field, because a list of tossup numbers is what they are. */
function breaksField(procedure: IRoomProcedure): string {
  return roomBreaks(procedure)
    .map((entry) => String(entry.afterTossup))
    .join(', ');
}

/**
 * Read a typed break schedule.
 *
 * Anything that is not a whole positive number is dropped rather than guessed at, exactly as
 * `readRoomProcedure` does — there is no defensible reading of "after tossup 4.5".
 */
function readBreaksField(value: string, existing: IRoomBreak[]): IRoomBreak[] | undefined {
  const labels = new Map(existing.map((entry) => [entry.afterTossup, entry.label]));
  const numbers = value
    .split(/[\s,]+/)
    .filter((part) => part !== '')
    .map((part) => Number(part))
    .filter((number) => Number.isInteger(number) && number >= 1);
  const unique = Array.from(new Set(numbers)).sort((first, second) => first - second);
  if (unique.length === 0) return undefined;
  return unique.map((afterTossup) => {
    const label = labels.get(afterTossup);
    return { afterTossup, ...(label !== undefined ? { label } : {}) };
  });
}

/**
 * Correct what this room's procedure says.
 *
 * The consequences are computed as the form changes rather than on submit, so a room can see what
 * correcting the break schedule would say about the break it already took while it is still
 * deciding. See `procedureCorrection` for why none of it rewrites history.
 */
export function ProcedureCorrectionForm(props: {
  procedure: IRoomProcedure | undefined;
  events: readonly ScoreEvent[];
  game: IDerivedGame;
  topic?: ProcedureTopic;
  onCorrect: (procedure: IRoomProcedure, summary: string) => void | Promise<void>;
  onCancel: () => void;
  disabled?: boolean;
}) {
  const { procedure, events, game, topic, onCorrect, onCancel, disabled = false } = props;
  const current = procedure ?? defaultRoomProcedure();
  const [timeouts, setTimeouts] = useState(String(current.timeoutsPerTeam));
  const [halves, setHalves] = useState(current.halves);
  const [breaks, setBreaks] = useState(() => breaksField(current));
  const [restrictive, setRestrictive] = useState(current.substitutionPolicy === 'breaks-timeouts-overtime');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');

  const proposed = useMemo<IRoomProcedure>(() => {
    const schedule = readBreaksField(breaks, roomBreaks(current));
    const next: IRoomProcedure = {
      ...current,
      halves: halves || schedule !== undefined,
      timeoutsPerTeam: Number.isInteger(Number(timeouts)) ? Number(timeouts) : current.timeoutsPerTeam,
      substitutionPolicy: restrictive ? 'breaks-timeouts-overtime' : 'any-boundary',
    };
    if (schedule === undefined) delete next.breaks;
    else next.breaks = schedule;
    if (!next.halves) delete next.halfLengthMinutes;
    return next;
  }, [breaks, current, halves, restrictive, timeouts]);

  const correction = useMemo(
    () => correctProcedure(procedure, proposed, events, game),
    [events, game, procedure, proposed],
  );
  const problems = correction.ok ? [] : correction.problems;
  const changes = correction.ok ? correction.changes : [];
  const consequences = correction.ok ? correction.consequences : [];

  const apply = async () => {
    if (!correction.ok || correction.unchanged || saving || disabled) return;
    setSaving(true);
    setFailure('');
    try {
      await onCorrect(correction.procedure, correction.summary);
    } catch {
      // Nothing was written. Staying open is the point: the proposed procedure is still in the form,
      // so pressing the button again is the retry.
      setSaving(false);
      setFailure('That procedure could not be saved on this device. Nothing has changed; try again.');
    }
  };

  return (
    <>
      <p className="scorer-dialog-note">
        For a room that was set up wrong. Everything already recorded stays exactly as it is; this changes
        what the room may do.
      </p>
      <div className="scorer-note-form">
        <label htmlFor="scorer-procedure-timeouts">
          Timeouts each team gets
          <input
            id="scorer-procedure-timeouts"
            type="number"
            inputMode="numeric"
            min={0}
            max={maximumTimeoutsPerTeam}
            data-dialog-autofocus={topic === 'timeout-allowance' ? true : undefined}
            value={timeouts}
            onChange={(changeEvent) => setTimeouts(changeEvent.target.value)}
          />
        </label>
        <label className="scorer-checkbox" htmlFor="scorer-procedure-halves">
          <input
            id="scorer-procedure-halves"
            type="checkbox"
            checked={halves}
            onChange={(changeEvent) => setHalves(changeEvent.target.checked)}
          />
          This room stops for a break
        </label>
        {halves && (
          <label htmlFor="scorer-procedure-breaks">
            Breaks after tossups
            <input
              id="scorer-procedure-breaks"
              value={breaks}
              placeholder="Leave empty for one break, wherever the moderator says"
              data-dialog-autofocus={topic === 'break-schedule' ? true : undefined}
              onChange={(changeEvent) => setBreaks(changeEvent.target.value)}
            />
          </label>
        )}
        <label className="scorer-checkbox" htmlFor="scorer-procedure-substitutions">
          <input
            id="scorer-procedure-substitutions"
            type="checkbox"
            checked={restrictive}
            onChange={(changeEvent) => setRestrictive(changeEvent.target.checked)}
          />
          Lineups change only at breaks, timeouts and checkpoints
        </label>
      </div>

      {problems.length > 0 && (
        <div className="scorer-question-errors" role="alert">
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      {changes.length > 0 && (
        <dl className="rules-correction-changes">
          {changes.map((change, position) => (
            <div key={`${position}-${change.subject}`} className="rules-correction-change">
              <dt>{change.subject}</dt>
              <dd>{change.detail}</dd>
            </div>
          ))}
        </dl>
      )}
      {consequences.map((consequence) => (
        <p key={consequence} className="scorer-dialog-note" role="status">
          {consequence}
        </p>
      ))}

      {failure !== '' && (
        <p className="scorer-problem" role="alert">
          {failure}
        </p>
      )}

      <div className="rules-correction-actions">
        <button type="button" className="scorer-action" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className="scorer-choice"
          disabled={disabled || saving || !correction.ok || correction.unchanged}
          onClick={() => void apply()}
        >
          {saving ? 'Applying…' : 'Apply corrected procedure'}
        </button>
      </div>
    </>
  );
}

/**
 * The dialog a refused action opens, and the one Game details opens for the room procedure.
 *
 * Opens on the question when it arrived from a refusal, and straight into the procedure form when it
 * arrived from Game details — where the scorekeeper has already said which of the two they want by
 * pressing Change beside the procedure.
 */
export default function ProcedureCorrectionDialog(props: {
  game: IDerivedGame;
  events: readonly ScoreEvent[];
  procedure: IRoomProcedure | undefined;
  /** The rule the refusal was about. Absent when this was opened from Game details. */
  topic?: ProcedureTopic;
  /** The team the refusal was about, when it was about one. */
  team?: LeftOrRight;
  refusalFor: (input: IProcedureExceptionInput) => string | undefined;
  onRecordException: (input: IProcedureExceptionInput) => void;
  onCorrect: (procedure: IRoomProcedure, summary: string) => void | Promise<void>;
  onClose: () => void;
  disabled?: boolean;
}) {
  const {
    game,
    events,
    procedure,
    topic,
    team,
    refusalFor,
    onRecordException,
    onCorrect,
    onClose,
    disabled = false,
  } = props;
  type Step = 'ask' | 'exception' | 'procedure';
  const [step, setStep] = useState<Step>(topic === undefined ? 'procedure' : 'ask');

  if (step === 'ask' && topic !== undefined) {
    return (
      <ScorerDialog key="ask" title={topicHeading[topic]} onClose={onClose}>
        <p className="scorer-dialog-note">Which of these happened?</p>
        <div className="scorer-choices">
          {/*
            The one-off first, because it is far and away the commoner of the two: a director allows
            something in one room, once. A room whose settings were wrong from the start usually
            discovers it the same way, but only once.
          */}
          <button
            type="button"
            className="scorer-choice"
            data-dialog-autofocus
            onClick={() => setStep('exception')}
          >
            We were told we could, this once
          </button>
          <button type="button" className="scorer-choice" onClick={() => setStep('procedure')}>
            This room was set up wrong
          </button>
        </div>
      </ScorerDialog>
    );
  }

  if (step === 'exception') {
    return (
      <ScorerDialog key="exception" title="Record what the room was told" onClose={onClose}>
        <ProcedureExceptionForm
          game={game}
          topic={topic}
          team={team}
          refusalFor={refusalFor}
          disabled={disabled}
          onRecord={(input) => {
            onRecordException(input);
            onClose();
          }}
        />
      </ScorerDialog>
    );
  }

  return (
    <ScorerDialog key="procedure" title="Room procedure" onClose={onClose}>
      <ProcedureCorrectionForm
        procedure={procedure}
        events={events}
        game={game}
        topic={topic}
        disabled={disabled}
        onCorrect={async (next, summary) => {
          await onCorrect(next, summary);
          onClose();
        }}
        onCancel={onClose}
      />
    </ScorerDialog>
  );
}
