import { useState } from 'react';
import { HelpRequestCategory, helpRequestCategoryLabels } from '../../main/server/ServerTypes';
import { IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import { IDerivedGame } from '../scoring/deriveGame';
import { ScoreEvent } from '../scoring/ScoreEvents';
import { editableQuestionFromEvents, IEditableQuestion } from '../scoring/questionCorrection';
import { bonusScoreProblem, lightningTotalProblem } from './bonusOptions';
import QuestionEditor from './QuestionEditor';
import ScorerDialog from './ScorerDialog';
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

export function IssueDialog(props: {
  questionNumber: number;
  controlAvailable: boolean;
  requestPending: boolean;
  // eslint-disable-next-line react/require-default-props
  initialCategory?: HelpRequestCategory;
  onReport: (category: HelpRequestCategory, details: string, requestControl: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const {
    questionNumber,
    controlAvailable,
    requestPending,
    initialCategory = 'question-packet',
    onReport,
    onClose,
  } = props;
  const [category, setCategory] = useState<HelpRequestCategory>(initialCategory);
  const [details, setDetails] = useState('');
  const [requestControl, setRequestControl] = useState(controlAvailable && !requestPending);
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
      setError(reason instanceof Error ? reason.message : 'The issue could not be sent to tournament control.');
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
        <label htmlFor="scorer-issue-details">
          What happened?
          <textarea
            id="scorer-issue-details"
            rows={4}
            maxLength={500}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
          />
        </label>
        <label className="scorer-checkbox" htmlFor="scorer-request-control">
          <input
            id="scorer-request-control"
            type="checkbox"
            checked={requestControl}
            disabled={!controlAvailable || requestPending}
            onChange={(e) => setRequestControl(e.target.checked)}
          />
          {requestPending ? 'A tournament-control request is already open' : 'Request tournament control now'}
        </label>
        {error && <p className="scorer-problem">{error}</p>}
        <button type="button" className="scorer-choice" disabled={sending || !details.trim()} onClick={submit}>
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

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

export function eventDescription(event: ScoreEvent, format: IScorekeeperFormat, game: IDerivedGame): string {
  if (event.type === 'tossup-buzz') {
    const value = format.answerTypes[event.answerTypeIndex]?.value;
    return `${event.playerName} ${value === undefined ? 'unknown ruling' : signed(value)}`;
  }
  if (event.type === 'tossup-no-penalty') return `${event.playerName ?? 'Answer'} wrong · 0 (no penalty)`;
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
  if (event.type === 'end-game-early') return `Game ended early after ${event.tossupsRead} tossups: ${event.reason}`;
  return `${event.flagged ? 'Flagged note' : 'Note'}: ${event.text}`;
}

function EditableEvent(props: {
  event: ScoreEvent;
  format: IScorekeeperFormat;
  game: IDerivedGame;
  onSave: (event: ScoreEvent) => void;
  onCancel: () => void;
}) {
  const { event, format, game, onSave, onCancel } = props;
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
  const [bounceback, setBounceback] = useState(event.type === 'bonus' ? String(event.bouncebackPoints ?? 0) : '0');
  const [text, setText] = useState(initialText);
  const [flagged, setFlagged] = useState(event.type === 'note' && event.flagged === true);
  const [problem, setProblem] = useState('');
  const [effectiveQuestion, setEffectiveQuestion] = useState(String(event.questionNumber));
  const [activePlayers, setActivePlayers] = useState(event.type === 'substitution' ? event.activePlayers : []);

  const eventTeam = event.type === 'tossup-buzz' || event.type === 'substitution' ? game[event.team] : undefined;
  const question = game.questions.find((candidate) => candidate.questionNumber === event.questionNumber);
  const activeBuzzPlayers = event.type === 'tossup-buzz' ? question?.activePlayers[event.team] ?? [] : [];

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
      const boundary = Number(effectiveQuestion);
      if (!Number.isInteger(boundary) || boundary < 1) {
        setProblem('Choose a valid tossup boundary.');
        return;
      }
      if (activePlayers.length < 1 || activePlayers.length > format.players.maximumActive) {
        setProblem(`Choose between 1 and ${format.players.maximumActive} active players.`);
        return;
      }
      onSave({ ...event, questionNumber: boundary, activePlayers });
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
        setProblem(`The bounceback cannot exceed ${Math.max(0, format.bonus.maximumScore - controlled)} points.`);
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
            <select id={`event-player-${event.id}`} value={playerName} onChange={(e) => setPlayerName(e.target.value)}>
              {!activeBuzzPlayers.includes(playerName) && <option value={playerName}>{playerName} — not active</option>}
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
          <fieldset>
            <legend>Active players</legend>
            {eventTeam.players.map((player, index) => {
              const checked = activePlayers.includes(player.name);
              const id = `event-lineup-${event.id}-${index}`;
              return (
                <label key={player.name} className="scorer-checkbox" htmlFor={id}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && activePlayers.length >= format.players.maximumActive}
                    onChange={() =>
                      setActivePlayers((current) =>
                        current.includes(player.name)
                          ? current.filter((name) => name !== player.name)
                          : current.concat(player.name),
                      )
                    }
                  />
                  {player.name}
                </label>
              );
            })}
          </fieldset>
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
  // eslint-disable-next-line react/require-default-props
  focusQuestion?: number;
  /** Open the focused question directly in the atomic editor, as Recent does. */
  // eslint-disable-next-line react/require-default-props
  editQuestion?: number;
  /** Open the existing replacement workflow for the focused question. */
  // eslint-disable-next-line react/require-default-props
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
  const questionNumbers = Array.from(new Set(events.map((event) => event.questionNumber))).sort((a, b) => a - b);
  return (
    <ScorerDialog
      title={editingQuestion === null ? 'Full scoresheet review' : `Question ${editingQuestion} editor`}
      onClose={onClose}
      wide
    >
      {editingQuestion !== null ? (
        <QuestionEditor
          game={game}
          format={format}
          initial={editableQuestionFromEvents(events, editingQuestion)}
          onSave={(question) => onReplaceQuestion(editingQuestion, question)}
          onCancel={() => setEditingQuestion(null)}
          onOpenReplacement={onOpenReplacement ? () => onOpenReplacement(editingQuestion) : undefined}
        />
      ) : (
        <>
          <p className="scorer-dialog-note">
            {game.left.name} {game.left.points} · {game.right.name} {game.right.points}. Corrections recalculate every
            total and player stat.
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
                  <div className="scorer-review-question-head">
                    <strong>Q{questionNumber}</strong>
                    <button type="button" className="scorer-choice" onClick={() => setEditingQuestion(questionNumber)}>
                      Edit question
                    </button>
                  </div>
                  <ul>
                    {events
                      .filter((event) => event.questionNumber === questionNumber)
                      .map((event) => {
                        const cycleEvent = ['tossup-buzz', 'tossup-no-penalty', 'tossup-dead', 'bonus'].includes(
                          event.type,
                        );
                        return (
                          <li key={event.id} className="scorer-review-event">
                            <span>{eventDescription(event, format, game)}</span>
                            <span className="scorer-review-actions">
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
                                    // eslint-disable-next-line no-alert
                                    if (window.confirm('Remove this event from the scoresheet?')) onRemove(event.id);
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
        Choose a QBJ backup downloaded by this scorer for {expectedTeams.left.name} vs {expectedTeams.right.name}. This
        replaces the events currently on screen.
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
