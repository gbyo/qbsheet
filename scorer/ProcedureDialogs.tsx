/**
 * The things a room does that are not scoring: protests, timeouts, replacing a spoiled question,
 * stopping a game short, and recording who was in the room.
 *
 * All of them interrupt play, none of them belongs near the buttons pressed twenty times a game, and
 * every one is rare enough that the cost of an extra press is nothing next to the cost of a stray
 * tap on it. They live behind the Game menu for the same reason forfeits do.
 */
import { useState } from 'react';
import { LeftOrRight } from '../../renderer/Utils/UtilTypes';
import { IDerivedGame, IDerivedProtest } from '../scoring/deriveGame';
import { ProtestStatus, ProtestSubject } from '../scoring/ScoreEvents';
import ScorerDialog from './ScorerDialog';

const protestSubjectLabels: Record<ProtestSubject, string> = {
  'tossup-answer': 'Tossup answer ruled wrong',
  'bonus-answer': 'Bonus answer ruled wrong',
  question: 'The question itself',
  procedure: 'Procedure or timing',
  other: 'Something else',
};

const protestStatusLabels: Record<ProtestStatus, string> = {
  open: 'Outstanding',
  upheld: 'Upheld',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

export { protestSubjectLabels, protestStatusLabels };

/**
 * Record a protest, or say what happened to one.
 *
 * The scorekeeper marks it and keeps playing — a room held up running a protest procedure is a round
 * held up for something that gets settled afterwards anyway. What this adds over a flagged note is
 * that the thing has a shape: control can see who protested what and whether anybody has decided it,
 * and an upheld one leads straight into the question editor rather than into a conversation.
 */
export function ProtestDialog(props: {
  game: IDerivedGame;
  questionNumber: number;
  onRecord: (team: LeftOrRight, subject: ProtestSubject, description: string, requestControl: boolean) => void;
  onResolve: (protest: IDerivedProtest, status: ProtestStatus, resolution: string) => void;
  /** Open the scoresheet review at this question, which is where an upheld protest is acted on. */
  onEditQuestion: (questionNumber: number) => void;
  /** False when this room has no way to reach tournament control right now. */
  controlAvailable: boolean;
  onClose: () => void;
}) {
  const { game, questionNumber, onRecord, onResolve, onEditQuestion, controlAvailable, onClose } = props;
  const [side, setSide] = useState<LeftOrRight>('left');
  const [subject, setSubject] = useState<ProtestSubject>('tossup-answer');
  const [description, setDescription] = useState('');
  const [requestControl, setRequestControl] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolution, setResolution] = useState('');

  return (
    <ScorerDialog title="Protests" onClose={onClose} wide>
      {game.protests.length > 0 && (
        <ul className="scorer-protest-list">
          {game.protests.map((protest) => (
            <li key={protest.eventId} className={protest.status === 'open' ? 'is-open' : ''}>
              <div className="scorer-protest-head">
                <span className="scorer-protest-q">Q{protest.questionNumber}</span>
                <span className="scorer-protest-team">{protest.teamName}</span>
                <span className="scorer-protest-status">{protestStatusLabels[protest.status]}</span>
              </div>
              <p className="scorer-protest-what">
                {protestSubjectLabels[protest.subject]} &mdash; {protest.description}
              </p>
              {protest.resolution && <p className="scorer-protest-resolution">{protest.resolution}</p>}
              {resolving === protest.eventId ? (
                <div className="scorer-note-form">
                  <label htmlFor={`protest-resolution-${protest.eventId}`}>
                    What was decided?
                    <input
                      id={`protest-resolution-${protest.eventId}`}
                      value={resolution}
                      maxLength={300}
                      onChange={(e) => setResolution(e.target.value)}
                    />
                  </label>
                  <div className="scorer-choices">
                    {(['upheld', 'declined', 'withdrawn'] as ProtestStatus[]).map((status) => (
                      <button
                        key={status}
                        type="button"
                        className="scorer-choice"
                        onClick={() => {
                          onResolve(protest, status, resolution.trim());
                          setResolving(null);
                          setResolution('');
                          // An upheld protest is a statement that the recorded events are wrong.
                          // Sending the scorekeeper to the question is the whole point of upholding
                          // it; recalculating from the corrected events is what the engine does next.
                          if (status === 'upheld') onEditQuestion(protest.questionNumber);
                        }}
                      >
                        {protestStatusLabels[status]}
                      </button>
                    ))}
                    <button type="button" className="scorer-action" onClick={() => setResolving(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="scorer-text-action"
                  onClick={() => {
                    setResolving(protest.eventId);
                    setResolution(protest.resolution ?? '');
                  }}
                >
                  {protest.status === 'open' ? 'Record a decision' : 'Change the decision'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        className="scorer-note-form"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          if (description.trim() === '') return;
          onRecord(side, subject, description.trim(), requestControl);
          setDescription('');
          setRequestControl(false);
        }}
      >
        <h3 className="scorer-dialog-subhead">New protest on question {questionNumber}</h3>
        <label htmlFor="scorer-protest-team">
          Protesting team
          <select id="scorer-protest-team" value={side} onChange={(e) => setSide(e.target.value as LeftOrRight)}>
            <option value="left">{game.left.name}</option>
            <option value="right">{game.right.name}</option>
          </select>
        </label>
        <label htmlFor="scorer-protest-subject">
          What is being protested
          <select
            id="scorer-protest-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value as ProtestSubject)}
          >
            {(Object.keys(protestSubjectLabels) as ProtestSubject[]).map((value) => (
              <option key={value} value={value}>
                {protestSubjectLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="scorer-protest-description">
          Details
          <textarea
            id="scorer-protest-description"
            rows={3}
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {/*
          Recording it and asking for somebody are separate decisions. Most protests are settled
          between games; a few need a director now, and holding up a round waiting for one that
          doesn't is the thing this is built to avoid.
        */}
        <label className="scorer-checkbox" htmlFor="scorer-protest-control">
          <input
            id="scorer-protest-control"
            type="checkbox"
            checked={requestControl}
            disabled={!controlAvailable}
            onChange={(e) => setRequestControl(e.target.checked)}
          />
          {controlAvailable ? 'Ask tournament control to come now' : 'Tournament control cannot be reached from here'}
        </label>
        <button type="submit" className="scorer-choice" disabled={description.trim() === ''}>
          Record protest and keep playing
        </button>
      </form>
    </ScorerDialog>
  );
}

/** A team's timeout. Unobtrusive by design: two presses, and the count shows on the team panel. */
export function TimeoutDialog(props: {
  game: IDerivedGame;
  timeoutsPerTeam: number;
  onRecord: (team: LeftOrRight) => void;
  onClose: () => void;
}) {
  const { game, timeoutsPerTeam, onRecord, onClose } = props;

  return (
    <ScorerDialog title="Timeout" onClose={onClose}>
      <p className="scorer-dialog-note">
        {timeoutsPerTeam === 1 ? 'Each team has one timeout.' : `Each team has ${timeoutsPerTeam} timeouts.`}{' '}
        Substitutions are allowed while the clock is stopped.
      </p>
      <div className="scorer-choices">
        {(['left', 'right'] as LeftOrRight[]).map((side) => {
          const used = game.timeouts[side];
          const exhausted = used >= timeoutsPerTeam;
          return (
            <button
              key={side}
              type="button"
              className="scorer-choice"
              disabled={exhausted}
              onClick={() => {
                onRecord(side);
                onClose();
              }}
            >
              {game[side].name}
              {used > 0 && <> ({used} used)</>}
            </button>
          );
        })}
      </div>
    </ScorerDialog>
  );
}

/**
 * The moderator spoiled a question and a replacement is being read.
 *
 * Everything already recorded on this cycle goes; the same cycle number is played again. That is the
 * part a scorekeeper cannot safely do by hand — deleting the events one by one is easy to get half
 * right, and getting it half right charges every player on the floor a tossup they never heard.
 *
 * A spoiled bonus does not un-answer the tossup that earned it, so it is a separate choice.
 */
export function ReplaceQuestionDialog(props: {
  questionNumber: number;
  /** False when there is no bonus on this question to replace on its own. */
  bonusReplaceable: boolean;
  onReplace: (scope: 'tossup' | 'bonus', reason: string) => void;
  onClose: () => void;
}) {
  const { questionNumber, bonusReplaceable, onReplace, onClose } = props;
  const [scope, setScope] = useState<'tossup' | 'bonus'>(bonusReplaceable ? 'bonus' : 'tossup');
  const [reason, setReason] = useState('');

  return (
    <ScorerDialog title={`Replace question ${questionNumber}`} onClose={onClose}>
      <p className="scorer-dialog-note">
        For a question that cannot stand &mdash; read from the wrong packet, spoiled, or already heard. What was
        recorded on it is removed and the same cycle is played again, so nobody is charged the tossup twice.
      </p>
      <div className="scorer-choices">
        <button
          type="button"
          aria-pressed={scope === 'tossup'}
          className={scope === 'tossup' ? 'scorer-choice is-selected' : 'scorer-choice'}
          onClick={() => setScope('tossup')}
        >
          Whole cycle
        </button>
        {bonusReplaceable && (
          <button
            type="button"
            aria-pressed={scope === 'bonus'}
            className={scope === 'bonus' ? 'scorer-choice is-selected' : 'scorer-choice'}
            onClick={() => setScope('bonus')}
          >
            Bonus only
          </button>
        )}
      </div>
      <form
        className="scorer-note-form"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          if (reason.trim() === '') return;
          onReplace(scope, reason.trim());
        }}
      >
        <label htmlFor="scorer-replace-reason">
          What went wrong?
          <input
            id="scorer-replace-reason"
            value={reason}
            maxLength={300}
            placeholder="Read from the wrong packet"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button type="submit" className="scorer-danger" disabled={reason.trim() === ''}>
          Replace {scope === 'bonus' ? 'the bonus' : `question ${questionNumber}`}
        </button>
      </form>
    </ScorerDialog>
  );
}

/**
 * The game is stopping short of its regulation length.
 *
 * YellowFruit already treats a game with fewer tossups than standard as a warning rather than an
 * error, which is the right judgement: rounds do get shortened, by directors and by packets running
 * out. The alternative the room had before this was inventing dead tossups until the count was
 * satisfied, which puts questions on the scoresheet that nobody read.
 */
export function EndGameEarlyDialog(props: {
  game: IDerivedGame;
  regulationTossupCount: number;
  onEnd: (reason: string, tossupsRead: number) => void;
  onClose: () => void;
}) {
  const { game, regulationTossupCount, onEnd, onClose } = props;
  const [reason, setReason] = useState('');
  const played = game.tossupsRead;

  return (
    <ScorerDialog title="End game early" onClose={onClose}>
      <p className="scorer-dialog-note">
        The game ends now with {played} tossup{played === 1 ? '' : 's'} heard, out of {regulationTossupCount} in a full
        round. The score stands as it is.
      </p>
      <p className="scorer-complete-score">
        <span>
          {game.left.name} <strong>{game.left.points}</strong>
        </span>
        <span>
          {game.right.name} <strong>{game.right.points}</strong>
        </span>
      </p>
      <form
        className="scorer-note-form"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          if (reason.trim() === '') return;
          onEnd(reason.trim(), played);
        }}
      >
        <label htmlFor="scorer-end-early-reason">
          Why is the game ending early?
          <input
            id="scorer-end-early-reason"
            value={reason}
            maxLength={300}
            placeholder="Tournament director stopped the round"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button type="submit" className="scorer-danger" disabled={reason.trim() === ''}>
          End the game now
        </button>
      </form>
    </ScorerDialog>
  );
}

/**
 * Who was in the room.
 *
 * `toQbjMatch` has carried `moderator` and `scorekeeper` all along and the room has never filled
 * them in. The scorekeeper is known already — it is whoever is signed in to the room browser — so it
 * is filled in for them. The reader is not known to anything, so it is asked for once, optionally,
 * and never again.
 */
export function GameDetailsDialog(props: {
  moderator: string;
  scorekeeper: string;
  onSave: (moderator: string) => void;
  onClose: () => void;
}) {
  const { moderator, scorekeeper, onSave, onClose } = props;
  const [name, setName] = useState(moderator);

  return (
    <ScorerDialog title="Game details" onClose={onClose}>
      <form
        className="scorer-note-form"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          onSave(name.trim());
          onClose();
        }}
      >
        <label htmlFor="scorer-moderator">
          Moderator / reader
          <input
            id="scorer-moderator"
            value={name}
            maxLength={120}
            placeholder="Optional"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <p className="scorer-dialog-note">
          Scorekeeper: {scorekeeper || 'not signed in on this device'}. Both are recorded on the result for later
          auditing and neither affects scoring.
        </p>
        <button type="submit" className="scorer-choice">
          Save
        </button>
      </form>
    </ScorerDialog>
  );
}
