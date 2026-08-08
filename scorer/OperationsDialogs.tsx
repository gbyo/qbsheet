import { useState } from 'react';
import { HelpRequestCategory, helpRequestCategoryLabels } from '../../main/server/ServerTypes';
import { IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import { IDerivedGame } from '../scoring/deriveGame';
import { ScoreEvent } from '../scoring/ScoreEvents';
import ScorerDialog from './ScorerDialog';
import { readScorerRecovery } from './ScorerRecovery';

const issueCategories: HelpRequestCategory[] = [
  'protest',
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
  onReport: (category: HelpRequestCategory, details: string, requestControl: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const { questionNumber, controlAvailable, requestPending, onReport, onClose } = props;
  const [category, setCategory] = useState<HelpRequestCategory>('protest');
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

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function eventDescription(event: ScoreEvent, format: IScorekeeperFormat): string {
  if (event.type === 'tossup-buzz') {
    const value = format.answerTypes[event.answerTypeIndex]?.value;
    return `${event.playerName} ${value === undefined ? 'unknown ruling' : signed(value)}`;
  }
  if (event.type === 'tossup-dead') return 'No buzz';
  if (event.type === 'bonus')
    return `Bonus ${event.controlledPoints ?? 0}${
      event.bouncebackPoints ? ` / ${event.bouncebackPoints} bounceback` : ''
    }`;
  if (event.type === 'substitution') return `Lineup: ${event.activePlayers.join(', ')}`;
  if (event.type === 'roster-add') return `Added player: ${event.playerName}`;
  if (event.type === 'lightning') return `Lightning ${signed(event.points)}`;
  if (event.type === 'adjustment')
    return `Adjustment ${signed(event.points)}${event.reason ? ` — ${event.reason}` : ''}`;
  if (event.type === 'forfeit') return `Forfeit: ${event.teams.join(' and ')}`;
  if (event.type === 'end-regulation') return 'End regulation';
  return `${event.flagged ? 'Flagged note' : 'Note'}: ${event.text}`;
}

function EditableEvent(props: {
  event: ScoreEvent;
  format: IScorekeeperFormat;
  onSave: (event: ScoreEvent) => void;
  onCancel: () => void;
}) {
  const { event, format, onSave, onCancel } = props;
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

  const save = () => {
    if (event.type === 'tossup-buzz' && playerName.trim())
      onSave({ ...event, playerName: playerName.trim(), answerTypeIndex: Number(answerTypeIndex) });
    else if (event.type === 'bonus')
      onSave({ ...event, parts: undefined, controlledPoints: Number(points), bouncebackPoints: Number(bounceback) });
    else if (event.type === 'adjustment' && Number.isInteger(Number(points)) && Number(points) !== 0)
      onSave({ ...event, points: Number(points), reason: text.trim() });
    else if (event.type === 'lightning' && Number.isFinite(Number(points)))
      onSave({ ...event, points: Number(points) });
    else if (event.type === 'note' && text.trim()) onSave({ ...event, text: text.trim(), flagged });
  };

  return (
    <div className="scorer-event-edit">
      {event.type === 'tossup-buzz' && (
        <>
          <label htmlFor={`event-player-${event.id}`}>
            Player
            <input id={`event-player-${event.id}`} value={playerName} onChange={(e) => setPlayerName(e.target.value)} />
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
  onClose: () => void;
}) {
  const { game, events, format, onReplace, onRemove, onClose } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const questionNumbers = Array.from(new Set(events.map((event) => event.questionNumber))).sort((a, b) => a - b);
  return (
    <ScorerDialog title="Full scoresheet review" onClose={onClose} wide>
      <p className="scorer-dialog-note">
        {game.left.name} {game.left.points} · {game.right.name} {game.right.points}. Corrections recalculate every total
        and player stat.
      </p>
      {!questionNumbers.length ? (
        <p className="scorer-rail-empty">Nothing has been recorded yet.</p>
      ) : (
        <ol className="scorer-review-list">
          {questionNumbers.map((questionNumber) => (
            <li key={questionNumber}>
              <strong>Q{questionNumber}</strong>
              <ul>
                {events
                  .filter((event) => event.questionNumber === questionNumber)
                  .map((event) => (
                    <li key={event.id} className="scorer-review-event">
                      <span>{eventDescription(event, format)}</span>
                      <span className="scorer-review-actions">
                        {['tossup-buzz', 'bonus', 'adjustment', 'lightning', 'note'].includes(event.type) && (
                          <button type="button" className="scorer-text-action" onClick={() => setEditing(event.id)}>
                            Edit
                          </button>
                        )}
                        <button
                          type="button"
                          className="scorer-text-action is-destructive"
                          onClick={() => onRemove(event.id)}
                        >
                          Remove
                        </button>
                      </span>
                      {editing === event.id && (
                        <EditableEvent
                          event={event}
                          format={format}
                          onSave={(next) => {
                            onReplace(event.id, next);
                            setEditing(null);
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      )}
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ol>
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
