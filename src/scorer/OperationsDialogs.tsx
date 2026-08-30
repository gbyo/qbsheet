import { useState } from 'react';
import {
  ControlRequestState,
  HelpClearResult,
  HelpRequestCategory,
  HelpRequestResult,
  helpRequestCategoryLabels,
} from '../app/HelpRequests';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IDerivedGame, IDerivedTeam } from '../scoring/deriveGame';
import { ScoreEvent } from '../scoring/ScoreEvents';
import { editableQuestionFromEvents, IEditableQuestion } from '../scoring/questionCorrection';
import { bonusScoreProblem, lightningTotalProblem } from './bonusOptions';
import QuestionEditor from './QuestionEditor';
import ScorerDialog from './ScorerDialog';
import PlayingBenchEditor from './PlayingBenchEditor';
import { orderedActivePlayers, playersAddedAfter } from './LineupEditing';
import { readScorerRecovery } from './ScorerRecovery';

/**
 * Everything a room needs somebody for, except a protest.
 *
 * A protest is not an issue that gets reported and closed — it has a team, a subject, and a decision
 * that may still be pending when the result is submitted, so it lives in the Protests dialog and
 * arrives at tournament control as a structured thing rather than a flagged note. Leaving it here as
 * well would give a scorekeeper two places to record one and control two things to reconcile.
 */
const issueCategories: HelpRequestCategory[] = [
  'question-packet',
  'roster-change',
  'equipment-technical',
  'rules-question',
  'scoring-problem',
  'other',
];

export function formatControlRequestTime(value: string, source: 'server' | 'device'): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    return source === 'device' ? 'requested on this device' : 'requested time unavailable';
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return source === 'device' ? `${time} · time from this device` : time;
}

export function ControlRequestControl(props: {
  controlRequest: ControlRequestState;
  checkboxId: string;
  checkboxLabel: string;
  unsupportedMessageNoun: string;
  disabled: boolean;
  requestControl: boolean;
  setRequestControl: (value: boolean) => void;
  onRetryControl?: () => Promise<HelpRequestResult | null>;
  onCancelControl?: () => Promise<HelpClearResult | null>;
}) {
  const {
    controlRequest,
    checkboxId,
    checkboxLabel,
    unsupportedMessageNoun,
    disabled,
    requestControl,
    setRequestControl,
    onRetryControl,
    onCancelControl,
  } = props;

  return (
    <div className="scorer-checkbox">
      {controlRequest.kind === 'idle' || controlRequest.kind === 'unavailable' ? (
        <label htmlFor={checkboxId}>
          <input
            id={checkboxId}
            type="checkbox"
            checked={requestControl}
            disabled={disabled}
            onChange={(e) => setRequestControl(e.target.checked)}
          />
          {checkboxLabel}
        </label>
      ) : controlRequest.kind === 'sending' ? (
        <span>Tournament control request is being sent…</span>
      ) : controlRequest.kind === 'outstanding' ? (
        <span>
          Tournament control has already been requested.
          <br />
          {helpRequestCategoryLabels[controlRequest.request.category]} ·{' '}
          {formatControlRequestTime(controlRequest.requestedAt, controlRequest.requestedAtSource)}
          {onCancelControl && controlRequest.request.id && controlRequest.canCancel !== false && (
            <>
              <br />
              <button type="button" className="scorer-text-action" onClick={() => void onCancelControl()}>
                Cancel request for control
              </button>
            </>
          )}
        </span>
      ) : controlRequest.kind === 'failed' ? (
        <span>
          Tournament control was not reached.
          {onRetryControl && controlRequest.retryable && (
            <>
              <br />
              <button type="button" className="scorer-text-action" onClick={() => void onRetryControl()}>
                Try request again
              </button>
            </>
          )}
        </span>
      ) : controlRequest.kind === 'refused' ? (
        <span>
          Tournament control refused this request.
          {onRetryControl && controlRequest.retryable && (
            <>
              <br />
              <button type="button" className="scorer-text-action" onClick={() => void onRetryControl()}>
                Try request again
              </button>
            </>
          )}
        </span>
      ) : (
        <span>
          This tournament connection does not support remote control requests; the {unsupportedMessageNoun}{' '}
          will still be saved on the scoresheet.
        </span>
      )}
    </div>
  );
}

export function IssueDialog(props: {
  questionNumber: number;
  controlRequest: ControlRequestState;
  onRetryControl?: () => Promise<HelpRequestResult | null>;
  onCancelControl?: () => Promise<HelpClearResult | null>;
  initialCategory?: HelpRequestCategory;
  onReport: (
    category: HelpRequestCategory,
    details: string,
    requestControl: boolean,
  ) => Promise<HelpRequestResult | undefined>;
  onClose: () => void;
}) {
  const {
    questionNumber,
    controlRequest,
    onRetryControl,
    onCancelControl,
    initialCategory = 'question-packet',
    onReport,
    onClose,
  } = props;
  const [category, setCategory] = useState<HelpRequestCategory>(initialCategory);
  /**
   * Whether the category chooser is on screen.
   *
   * Closed by default, because Flag has just asked this exact question and the answer arrived with
   * the dialog. A scorekeeper who pressed "Question / packet issue" and was then shown a list whose
   * first job is to ask which kind of issue this is reasonably concludes the first press did not
   * take — so they answer again, and the dialog has cost two presses to learn one thing.
   *
   * It opens and stays open, rather than collapsing on a selection: a `select` fires a change on
   * every arrow key, and a chooser that folded itself away mid-keyboard-navigation would be taking
   * the control out from under somebody still using it.
   */
  const [changingType, setChangingType] = useState(false);
  const [details, setDetails] = useState('');
  const [requestControl, setRequestControl] = useState(
    controlRequest.kind === 'idle' || controlRequest.kind === 'unavailable',
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  let submitLabel = 'Save issue';
  if (sending) submitLabel = 'Saving…';
  else if (requestControl) submitLabel = 'Save and request control';

  const submit = async () => {
    if (!details.trim()) return;
    setSending(true);
    setError('');
    try {
      await onReport(category, details.trim(), requestControl);
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'The issue could not be sent to tournament control.',
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <ScorerDialog title="Issue / tournament control" onClose={onClose}>
      <p className="scorer-dialog-note">
        Saved on this scoresheet at question {questionNumber}. Scoring can continue while control reviews it.
      </p>
      <div className="scorer-note-form">
        {changingType ? (
          <label htmlFor="scorer-issue-category">
            Issue
            <select
              id="scorer-issue-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as HelpRequestCategory)}
            >
              {issueCategories.map((value) => (
                <option key={value} value={value}>
                  {helpRequestCategoryLabels[value]}
                </option>
              ))}
            </select>
          </label>
        ) : (
          /*
            What is being reported, stated rather than asked. The escape hatch stays — a category
            chosen by a thumb on the wrong row of the Flag list has to be correctable, and nothing
            typed below is lost when it is used, because the details and the control request are
            their own state and changing the category does not touch either.
          */
          <p className="scorer-issue-type">
            <span className="scorer-issue-type-name">{helpRequestCategoryLabels[category]}</span>
            <button type="button" className="scorer-text-action" onClick={() => setChangingType(true)}>
              Change type
            </button>
          </p>
        )}
        {/*
          Focused on open. The category above is stated rather than asked in the ordinary case — it
          came from the Flag list that opened this — so the description is the first thing being
          asked for, and the dialog shell would otherwise start on the close button.
        */}
        <label htmlFor="scorer-issue-details">
          What happened?
          <textarea
            id="scorer-issue-details"
            data-dialog-autofocus
            rows={4}
            maxLength={500}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
          />
        </label>
        <ControlRequestControl
          controlRequest={controlRequest}
          checkboxId="scorer-request-control"
          checkboxLabel="Ask tournament control to come"
          unsupportedMessageNoun="issue"
          disabled={sending}
          requestControl={requestControl}
          setRequestControl={setRequestControl}
          onRetryControl={onRetryControl}
          onCancelControl={onCancelControl}
        />
        {error && <p className="scorer-problem">{error}</p>}
        <button
          type="button"
          className="scorer-choice"
          disabled={sending || !details.trim()}
          onClick={submit}
        >
          {submitLabel}
        </button>
      </div>
    </ScorerDialog>
  );
}

/** One compact entry point for the things a scorekeeper may need to flag during live play. */
export function FlagDialog(props: {
  onProtest: () => void;
  onIssue: (category: HelpRequestCategory) => void;
  onClose: () => void;
}) {
  const { onProtest, onIssue, onClose } = props;
  return (
    <ScorerDialog title="Flag" onClose={onClose}>
      <p className="scorer-dialog-note">
        Choose what needs attention. The game can keep going while control reviews it.
      </p>
      <div className="scorer-flag-options">
        <button type="button" className="scorer-choice" onClick={onProtest}>
          Protest / disputed ruling
        </button>
        {issueCategories.map((category) => (
          <button key={category} type="button" className="scorer-choice" onClick={() => onIssue(category)}>
            {helpRequestCategoryLabels[category]}
          </button>
        ))}
      </div>
    </ScorerDialog>
  );
}

/**
 * The file actions in one ordinary dialog.
 *
 * A live scoresheet should offer one clear way out rather than making somebody scan three nearly
 * identical download rows in the Game menu. Hosts omit forms they cannot produce; the backup is
 * always present because it is the local recovery escape hatch.
 */
export function ExportDialog(props: {
  onDownloadQbjBackup: () => void;
  onDownloadPartialQbj?: () => void;
  onDownloadLegacyQbj?: () => void;
  onClose: () => void;
}) {
  const { onDownloadQbjBackup, onDownloadPartialQbj, onDownloadLegacyQbj, onClose } = props;
  const choose = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <ScorerDialog title="Export / backup" onClose={onClose}>
      <p className="scorer-dialog-note">
        Save a portable copy of this game. Keep the QBJ backup until the result has been received and checked.
      </p>
      <div className="scorer-export-options">
        <button type="button" className="scorer-choice" onClick={() => choose(onDownloadQbjBackup)}>
          Download QBJ backup
        </button>
        {onDownloadPartialQbj && (
          <button type="button" className="scorer-choice" onClick={() => choose(onDownloadPartialQbj)}>
            Download current QBJ
          </button>
        )}
        {onDownloadLegacyQbj && (
          <button type="button" className="scorer-choice" onClick={() => choose(onDownloadLegacyQbj)}>
            Download legacy match-only QBJ
          </button>
        )}
      </div>
    </ScorerDialog>
  );
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

export function eventDescription(event: ScoreEvent, format: IScorekeeperFormat, game: IDerivedGame): string {
  if (event.type === 'tossup-buzz') {
    const value = format.answerTypes[event.answerTypeIndex]?.value;
    return `${event.playerName} ${value === undefined ? 'unknown ruling' : signed(value)}`;
  }
  if (event.type === 'tossup-no-penalty') return `${event.playerName ?? 'Answer'} wrong · 0 (no penalty)`;
  if (event.type === 'tossup-reading-resumed') return 'Tossup reading resumed';
  if (event.type === 'tossup-readout') return 'Tossup read out';
  if (event.type === 'tossup-dead') return 'No buzz';
  if (event.type === 'bonus')
    return `Bonus ${event.controlledPoints ?? 0}${
      event.bouncebackPoints ? ` / ${event.bouncebackPoints} bounceback` : ''
    }`;
  if (event.type === 'substitution')
    return `Before Tossup ${event.questionNumber}, lineup changed: ${event.activePlayers.join(', ')}`;
  if (event.type === 'roster-add') return `Added player: ${event.playerName}`;
  if (event.type === 'lightning') return `Lightning ${signed(event.points)}`;
  if (event.type === 'adjustment')
    return `Adjustment ${signed(event.points)}${event.reason ? ` — ${event.reason}` : ''}`;
  if (event.type === 'forfeit') return `Forfeit: ${event.teams.join(' and ')}`;
  if (event.type === 'end-regulation')
    return `End regulation${
      event.lastRegulationQuestion !== undefined ? ` after Tossup ${event.lastRegulationQuestion}` : ''
    }`;
  if (event.type === 'half-break') return `End of half after Tossup ${event.lastQuestion}`;
  if (event.type === 'half-resume') return 'Score confirmed at the break';
  if (event.type === 'begin-overtime') return 'Begin overtime';
  if (event.type === 'begin-sudden-death') return 'Begin sudden death';
  if (event.type === 'timeout') return `Timeout: ${game[event.team].name}`;
  if (event.type === 'timeout-start') return `Timeout started: ${game[event.team].name}`;
  if (event.type === 'timeout-resume') return 'Timeout ended · play resumed';
  if (event.type === 'protest')
    return `Protest (${event.team}, ${event.status}): ${event.description}${
      event.resolution ? ` — ${event.resolution}` : ''
    }`;
  if (event.type === 'question-void')
    return `${event.scope === 'bonus' ? 'Bonus' : 'Question'} replaced: ${event.reason}`;
  if (event.type === 'end-game-early')
    return `Game ended early after ${event.tossupsRead} tossups: ${event.reason}`;
  return `${event.flagged ? 'Flagged note' : 'Note'}: ${event.text}`;
}

/**
 * Who was playing from a boundary, corrected after the fact.
 *
 * The same Playing / Bench vocabulary the live editors use, and deliberately with none of their
 * furniture. There are no seat numbers here because a seat number is a fact about a Chromebook in a
 * room that has since been packed away, and printing one beside historical scoring data would invite
 * somebody to correct it. There are no arrows for the same reason.
 *
 * Playing and Bench rather than Start and Bench because this event may well take effect at tossup 8:
 * "start" would be a claim about the beginning of the game that the effective-tossup field directly
 * above it can contradict.
 *
 * # Why the boundary changes the bench
 *
 * A roster is a thing that grows during a game. Moving this event back to tossup 8 moves it before
 * every name added after tossup 8, and those people cannot be put on: they were not there. They are
 * withheld rather than refused, so a scorekeeper is not offered a choice that
 * `validateCorrectedHistory` will then reject from underneath them.
 *
 * A name already in the event that the roster had not reached yet is the other direction, and it is
 * shown rather than hidden — history that is already impossible is exactly what somebody opened this
 * editor to fix, and a row they cannot see is a row they cannot remove.
 */
function SubstitutionLineupFields(props: {
  event: Extract<ScoreEvent, { type: 'substitution' }>;
  team: IDerivedTeam;
  events: readonly ScoreEvent[];
  maximumActive: number;
  boundary: number;
  playing: ReadonlySet<string>;
  onChange: (playing: ReadonlySet<string>) => void;
}) {
  const { event, team, events, maximumActive, boundary, playing, onChange } = props;
  const rosterNames = team.players.map((player) => player.name);
  const addedLater = playersAddedAfter(events, event.team, boundary);
  // Roster order, minus anybody the roster had not reached — except where this event already names
  // them, in which case the row has to exist for the scorekeeper to take it off. A name on no
  // roster at all is the same problem one step further along, and is appended for the same reason.
  const order = rosterNames
    .filter((name) => !addedLater.has(name) || playing.has(name))
    .concat(Array.from(playing).filter((name) => !rosterNames.includes(name)));
  const addedAt = (name: string): number | undefined =>
    events.find(
      (candidate): candidate is Extract<ScoreEvent, { type: 'roster-add' }> =>
        candidate.type === 'roster-add' && candidate.team === event.team && candidate.playerName === name,
    )?.questionNumber;

  return (
    <PlayingBenchEditor
      idPrefix={`event-lineup-${event.id}`}
      order={order}
      playing={playing}
      maximumActive={maximumActive}
      noteFor={(name) => {
        if (!rosterNames.includes(name)) return 'not on this roster';
        if (!addedLater.has(name)) return undefined;
        const at = addedAt(name);
        return at === undefined ? 'not on the roster at this tossup' : `not on the roster until Tossup ${at}`;
      }}
      onBench={(name) => {
        const next = new Set(playing);
        next.delete(name);
        onChange(next);
      }}
      onPutIn={(name) => {
        if (playing.size >= maximumActive) return;
        const next = new Set(playing);
        next.add(name);
        onChange(next);
      }}
    />
  );
}

/** The events one press produces that are all part of scoring a cycle. */
const cycleEventTypes = new Set([
  'tossup-buzz',
  'tossup-no-penalty',
  'tossup-reading-resumed',
  'tossup-readout',
  'tossup-dead',
  'bonus',
]);

/**
 * One line for what an undo or redo just changed.
 *
 * # Why a frame is not a list
 *
 * Undo works on actions, not events, and some actions are several events: confirming the starting
 * lineups writes one per team, replacing a question writes a void and the note explaining it. A
 * scorekeeper pressing undo took back one thing they did, and reading them an array of the machinery
 * behind it would be answering a question they did not ask — the useful answer is the name of the
 * action, and for a single event that is just what the event is.
 *
 * Returned without a verb so the same sentence serves both directions; the caller says Undid or
 * Redid.
 */
export function frameDescription(
  frame: readonly ScoreEvent[],
  format: IScorekeeperFormat,
  game: IDerivedGame,
): string {
  if (frame.length === 0) return '';
  if (frame.length === 1) {
    const [only] = frame;
    return `Q${only.questionNumber} · ${eventDescription(only, format, game)}`;
  }

  const questions = new Set(frame.map((event) => event.questionNumber));
  const everySubstitution = frame.every((event) => event.type === 'substitution');
  // Both teams' opening lineups, which is the one multi-event action a scorekeeper has a name for.
  if (everySubstitution && questions.size === 1 && questions.has(1)) return 'starting lineups';
  if (questions.size !== 1) return `${frame.length} changes`;

  const [questionNumber] = questions;
  if (everySubstitution) return `Q${questionNumber} · lineup changes`;
  if (frame.every((event) => cycleEventTypes.has(event.type)))
    return `Q${questionNumber} · ${frame.length} scoring records`;
  return `Q${questionNumber} · ${frame.length} changes`;
}

/**
 * The one question a frame is about, or nothing when it spans more than one.
 *
 * Used to point at a line in Recent, which only makes sense when there is exactly one line to point
 * at. A frame covering three questions has no single row to emphasise, and picking one of them would
 * be pointing at the wrong two-thirds of what changed.
 */
export function frameQuestion(frame: readonly ScoreEvent[]): number | undefined {
  if (frame.length === 0) return undefined;
  const [first] = frame;
  return frame.every((event) => event.questionNumber === first.questionNumber)
    ? first.questionNumber
    : undefined;
}

function EditableEvent(props: {
  event: ScoreEvent;
  format: IScorekeeperFormat;
  game: IDerivedGame;
  /** The whole scoresheet, so a lineup correction can tell when each name reached the roster. */
  events: readonly ScoreEvent[];
  onSave: (event: ScoreEvent) => void;
  onCancel: () => void;
}) {
  const { event, format, game, events, onSave, onCancel } = props;
  const [playerName, setPlayerName] = useState(event.type === 'tossup-buzz' ? event.playerName : '');
  const [answerTypeIndex, setAnswerTypeIndex] = useState(
    event.type === 'tossup-buzz' ? String(event.answerTypeIndex) : '0',
  );
  const initialPoints = () => {
    if (event.type === 'bonus') return String(event.controlledPoints ?? 0);
    if (event.type === 'adjustment' || event.type === 'lightning') return String(event.points);
    return '';
  };
  const initialText = () => {
    if (event.type === 'note') return event.text;
    if (event.type === 'adjustment') return event.reason ?? '';
    return '';
  };
  const [points, setPoints] = useState(initialPoints);
  const [bounceback, setBounceback] = useState(
    event.type === 'bonus' ? String(event.bouncebackPoints ?? 0) : '0',
  );
  const [text, setText] = useState(initialText);
  const [flagged, setFlagged] = useState(event.type === 'note' && event.flagged === true);
  const [problem, setProblem] = useState('');
  const [effectiveQuestion, setEffectiveQuestion] = useState(String(event.questionNumber));
  /**
   * Who is playing, as membership.
   *
   * The array the event stores is derived from this at save (see `orderedActivePlayers`) rather than
   * accumulated as rows are pressed, so taking somebody off and putting them back leaves the
   * recorded lineup in the order it was already in.
   */
  const [playing, setPlaying] = useState<ReadonlySet<string>>(
    () => new Set(event.type === 'substitution' ? event.activePlayers : []),
  );

  const eventTeam =
    event.type === 'tossup-buzz' || event.type === 'substitution' ? game[event.team] : undefined;
  const parsedBoundary = Number(effectiveQuestion);
  /** What the bench is computed against while the field is mid-edit. */
  const boundary =
    Number.isInteger(parsedBoundary) && parsedBoundary >= 1 ? parsedBoundary : event.questionNumber;
  const question = game.questions.find((candidate) => candidate.questionNumber === event.questionNumber);
  const activeBuzzPlayers = event.type === 'tossup-buzz' ? (question?.activePlayers[event.team] ?? []) : [];

  const save = () => {
    setProblem('');
    if (event.type === 'tossup-buzz') {
      if (!activeBuzzPlayers.includes(playerName)) {
        setProblem('That player was not active for this tossup. Correct the lineup first.');
        return;
      }
      const ruling = Number(answerTypeIndex);
      if (!format.answerTypes.some((answerType) => answerType.index === ruling)) {
        setProblem('Choose a valid ruling.');
        return;
      }
      onSave({ ...event, playerName: playerName.trim(), answerTypeIndex: Number(answerTypeIndex) });
      return;
    }
    if (event.type === 'substitution') {
      const chosen = Number(effectiveQuestion);
      if (!Number.isInteger(chosen) || chosen < 1) {
        setProblem('Choose a valid tossup boundary.');
        return;
      }
      if (playing.size < 1 || playing.size > format.players.maximumActive) {
        setProblem(`Choose between 1 and ${format.players.maximumActive} active players.`);
        return;
      }
      /*
       * The boundary and the membership are two fields that can each be edited after the other, so
       * withholding a not-yet-rostered player from the bench is not on its own enough: moving the
       * boundary forward, putting them on, and moving it back again reaches the same impossible
       * lineup by a different route. Checked once here, against the boundary actually being saved.
       *
       * It refuses rather than dropping the name, because a player silently removed on save is a
       * correction nobody asked for. The row stays on screen with its reason on it, and both ways
       * out — take them off, or move the boundary past their arrival — are one press away.
       */
      const tooEarly = playersAddedAfter(events, event.team, chosen);
      const impossible = Array.from(playing).find((name) => tooEarly.has(name));
      if (impossible !== undefined) {
        setProblem(
          `${impossible} was not on the roster at Tossup ${chosen}. Take them off, or move the tossup later.`,
        );
        return;
      }
      const activePlayers = orderedActivePlayers(
        event.activePlayers,
        (game[event.team].players ?? []).map((player) => player.name),
        playing,
      );
      onSave({ ...event, questionNumber: chosen, activePlayers });
      return;
    }
    if (event.type === 'bonus') {
      if (points.trim() === '' || bounceback.trim() === '') {
        setProblem('Enter both bonus totals.');
        return;
      }
      const controlled = Number(points);
      const bounced = Number(bounceback);
      const reason = bonusScoreProblem(format.bonus, controlled, bounced);
      if (reason) {
        setProblem(reason);
        return;
      }
      if (!format.bonus.bounceBack && bounced !== 0) {
        setProblem('This format does not allow bounceback points.');
        return;
      }
      if (bounced > format.bonus.maximumScore - controlled) {
        setProblem(
          `The bounceback cannot exceed ${Math.max(0, format.bonus.maximumScore - controlled)} points.`,
        );
        return;
      }
      onSave({ ...event, parts: undefined, controlledPoints: controlled, bouncebackPoints: bounced });
      return;
    }
    if (event.type === 'adjustment' && Number.isInteger(Number(points)) && Number(points) !== 0) {
      onSave({ ...event, points: Number(points), reason: text.trim() });
      return;
    }
    if (event.type === 'adjustment') {
      setProblem('Enter a non-zero whole number of points.');
      return;
    }
    if (event.type === 'lightning') {
      const reason =
        points.trim() === ''
          ? 'Enter a lightning total.'
          : lightningTotalProblem(format.lightning.divisor, Number(points));
      if (reason) {
        setProblem(reason);
        return;
      }
      onSave({ ...event, points: Number(points) });
      return;
    }
    if (event.type === 'note' && text.trim()) {
      onSave({ ...event, text: text.trim(), flagged });
      return;
    }
    if (event.type === 'note') setProblem('Enter a note.');
  };

  return (
    <div className="scorer-event-edit">
      {event.type === 'tossup-buzz' && (
        <>
          <label htmlFor={`event-player-${event.id}`}>
            Player
            <select
              id={`event-player-${event.id}`}
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
            >
              {!activeBuzzPlayers.includes(playerName) && (
                <option value={playerName}>{playerName} — not active</option>
              )}
              {activeBuzzPlayers.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`event-ruling-${event.id}`}>
            Ruling
            <select
              id={`event-ruling-${event.id}`}
              value={answerTypeIndex}
              onChange={(e) => setAnswerTypeIndex(e.target.value)}
            >
              {format.answerTypes.map((answerType) => (
                <option key={answerType.index} value={answerType.index}>
                  {signed(answerType.value)}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {event.type === 'substitution' && eventTeam && (
        <>
          <label htmlFor={`event-boundary-${event.id}`}>
            Effective tossup
            <input
              id={`event-boundary-${event.id}`}
              type="number"
              min={1}
              value={effectiveQuestion}
              onChange={(e) => setEffectiveQuestion(e.target.value)}
            />
          </label>
          <SubstitutionLineupFields
            event={event}
            team={eventTeam}
            events={events}
            maximumActive={format.players.maximumActive}
            boundary={boundary}
            playing={playing}
            onChange={setPlaying}
          />
        </>
      )}
      {(event.type === 'bonus' || event.type === 'adjustment' || event.type === 'lightning') && (
        <label htmlFor={`event-points-${event.id}`}>
          Points
          <input
            id={`event-points-${event.id}`}
            type="number"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
          />
        </label>
      )}
      {event.type === 'bonus' && (
        <label htmlFor={`event-bounceback-${event.id}`}>
          Bounceback
          <input
            id={`event-bounceback-${event.id}`}
            type="number"
            value={bounceback}
            onChange={(e) => setBounceback(e.target.value)}
          />
        </label>
      )}
      {(event.type === 'note' || event.type === 'adjustment') && (
        <label htmlFor={`event-text-${event.id}`}>
          {event.type === 'note' ? 'Note' : 'Reason'}
          <input id={`event-text-${event.id}`} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      )}
      {event.type === 'note' && (
        <label className="scorer-checkbox" htmlFor={`event-flag-${event.id}`}>
          <input
            id={`event-flag-${event.id}`}
            type="checkbox"
            checked={flagged}
            onChange={(e) => setFlagged(e.target.checked)}
          />
          Flag for control
        </label>
      )}
      {problem && <p className="scorer-problem">{problem}</p>}
      <div className="scorer-event-edit-actions">
        <button type="button" className="scorer-choice" onClick={save}>
          Save correction
        </button>
        <button type="button" className="scorer-action" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ScoresheetReviewDialog(props: {
  game: IDerivedGame;
  events: ScoreEvent[];
  format: IScorekeeperFormat;
  onReplace: (id: string, event: ScoreEvent) => void;
  onRemove: (id: string) => void;
  onReplaceQuestion: (questionNumber: number, question: IEditableQuestion) => boolean;
  /** Scroll to and highlight this question. What the rail and an upheld protest both open. */
  focusQuestion?: number;
  /** Open the focused question directly in the atomic editor, as Recent does. */
  editQuestion?: number;
  /** Open the existing replacement workflow for the focused question. */
  onOpenReplacement?: (questionNumber: number) => void;
  onClose: () => void;
}) {
  const {
    game,
    events,
    format,
    onReplace,
    onRemove,
    onReplaceQuestion,
    focusQuestion,
    editQuestion,
    onOpenReplacement,
    onClose,
  } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const [editingQuestion, setEditingQuestion] = useState<number | null>(editQuestion ?? null);
  /**
   * Whether leaving the editor should land on the review list or back on the scoresheet.
   *
   * Recent opens one question directly, and a scorekeeper who came that way never asked to see the
   * event list: sending them to it on Cancel is why leaving the editor felt like there was no way
   * out. Somebody who chose Edit question *from* the list is going back to the list.
   */
  const [cameFromList, setCameFromList] = useState(editQuestion === undefined);
  const questionNumbers = Array.from(new Set(events.map((event) => event.questionNumber))).sort(
    (a, b) => a - b,
  );
  const leaveEditor = () => {
    if (cameFromList) setEditingQuestion(null);
    else onClose();
  };
  return (
    <ScorerDialog
      title={editingQuestion === null ? 'Full scoresheet review' : `Edit Question ${editingQuestion}`}
      onClose={onClose}
      wide
    >
      {editingQuestion !== null ? (
        <QuestionEditor
          game={game}
          format={format}
          initial={editableQuestionFromEvents(events, editingQuestion)}
          onSave={(question) => onReplaceQuestion(editingQuestion, question)}
          onCancel={leaveEditor}
          onOpenReplacement={onOpenReplacement ? () => onOpenReplacement(editingQuestion) : undefined}
        />
      ) : (
        <>
          <p className="scorer-dialog-note">
            {game.left.name} {game.left.points} · {game.right.name} {game.right.points}. Corrections
            recalculate every total and player stat.
          </p>
          {game.personnelProblems.map((problem) => (
            <p key={problem.eventId} className="scorer-problem">
              {problem.message}
            </p>
          ))}
          {game.integrityProblems.map((problem) => (
            <p key={problem.eventId} className="scorer-problem">
              {problem.message}
            </p>
          ))}
          {!questionNumbers.length ? (
            <p className="scorer-rail-empty">Nothing has been recorded yet.</p>
          ) : (
            <ol className="scorer-review-list">
              {questionNumbers.map((questionNumber) => (
                <li
                  key={questionNumber}
                  className={questionNumber === focusQuestion ? 'is-focused' : undefined}
                  ref={
                    questionNumber === focusQuestion
                      ? (element) => {
                          // Guarded because scrolling is a nicety and not every environment has it;
                          // the outline is what actually finds the question.
                          if (typeof element?.scrollIntoView === 'function')
                            element.scrollIntoView({ block: 'nearest' });
                        }
                      : undefined
                  }
                >
                  <ul>
                    {events
                      .filter((event) => event.questionNumber === questionNumber)
                      .map((event, eventIndex) => {
                        const cycleEvent = cycleEventTypes.has(event.type);
                        return (
                          <li key={event.id} className="scorer-review-event">
                            {eventIndex === 0 ? (
                              <strong className="scorer-review-question-number">Q{questionNumber}</strong>
                            ) : (
                              <span className="scorer-review-question-gutter" aria-hidden="true" />
                            )}
                            <span className="scorer-review-event-description">
                              {eventDescription(event, format, game)}
                            </span>
                            <span className="scorer-review-actions">
                              {eventIndex === 0 && (
                                <button
                                  type="button"
                                  className="scorer-text-action scorer-review-question-action"
                                  onClick={() => {
                                    setCameFromList(true);
                                    setEditingQuestion(questionNumber);
                                  }}
                                >
                                  Edit question
                                </button>
                              )}
                              {['substitution', 'adjustment', 'lightning', 'note'].includes(event.type) && (
                                <button
                                  type="button"
                                  className="scorer-text-action"
                                  onClick={() => setEditing(event.id)}
                                >
                                  Edit
                                </button>
                              )}
                              {!cycleEvent && (
                                <button
                                  type="button"
                                  className="scorer-text-action is-destructive"
                                  onClick={() => {
                                    if (window.confirm('Remove this event from the scoresheet?'))
                                      onRemove(event.id);
                                  }}
                                >
                                  Remove
                                </button>
                              )}
                            </span>
                            {editing === event.id && (
                              <EditableEvent
                                event={event}
                                format={format}
                                game={game}
                                events={events}
                                onSave={(next) => {
                                  onReplace(event.id, next);
                                  setEditing(null);
                                }}
                                onCancel={() => setEditing(null)}
                              />
                            )}
                          </li>
                        );
                      })}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </ScorerDialog>
  );
}

export function RecoveryDialog(props: {
  expectedTeams: { left: { name: string }; right: { name: string } };
  onRestore: (events: ScoreEvent[]) => void;
  onClose: () => void;
}) {
  const { expectedTeams, onRestore, onClose } = props;
  const [error, setError] = useState('');
  return (
    <ScorerDialog title="Recover from QBJ" onClose={onClose}>
      <p className="scorer-dialog-note">
        Choose a QBJ backup downloaded by this scorer for {expectedTeams.left.name} vs{' '}
        {expectedTeams.right.name}. This replaces the events currently on screen.
      </p>
      <label className="scorer-file-field" htmlFor="scorer-recovery-file">
        QBJ backup
        <input
          id="scorer-recovery-file"
          type="file"
          accept=".qbj,application/json"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
              const recovery = readScorerRecovery(JSON.parse(await file.text()), expectedTeams);
              if (!recovery) throw new Error('This file has no compatible recovery data for this matchup.');
              onRestore(recovery.events);
              onClose();
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : 'This QBJ file could not be read.');
            }
          }}
        />
      </label>
      {error && <p className="scorer-problem">{error}</p>}
    </ScorerDialog>
  );
}
