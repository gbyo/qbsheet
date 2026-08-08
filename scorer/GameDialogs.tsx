/**
 * The infrequent actions: lightning totals, notes, score adjustments, forfeits.
 *
 * All four interrupt scoring, none of them belongs next to the buttons a scorekeeper presses twenty
 * times a game, and all four are small enough that a file each would be filing for its own sake.
 */
import { useState } from 'react';
import { LeftOrRight } from '../../renderer/Utils/UtilTypes';
import { IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import { IDerivedGame } from '../scoring/deriveGame';
import { lightningTotalProblem } from './bonusOptions';
import ScorerDialog from './ScorerDialog';

/**
 * Lightning / worksheet points.
 *
 * One number per team for the whole game, because that is exactly what YellowFruit stores. The match
 * editor treats it the same way — a single field stepped by the configured divisor — so inventing a
 * question-by-question lightning model here would produce detail nothing downstream can hold.
 */
export function LightningDialog(props: {
  format: IScorekeeperFormat;
  game: IDerivedGame;
  onRecord: (team: LeftOrRight, points: number) => void;
  onClose: () => void;
}) {
  const { format, game, onRecord, onClose } = props;
  const [values, setValues] = useState<Record<LeftOrRight, string>>({
    left: String(game.left.lightningPoints || ''),
    right: String(game.right.lightningPoints || ''),
  });

  const problemFor = (side: LeftOrRight) =>
    values[side] === '' ? null : lightningTotalProblem(format.lightning.divisor, Number(values[side]));

  const record = (side: LeftOrRight) => {
    if (values[side] === '' || problemFor(side)) return;
    onRecord(side, Number(values[side]));
  };

  return (
    <ScorerDialog title="Lightning / worksheet" onClose={onClose}>
      {(['left', 'right'] as LeftOrRight[]).map((side) => {
        const problem = problemFor(side);
        return (
          <div key={side} className="scorer-inline-form">
            <label htmlFor={`scorer-lightning-${side}`}>
              {game[side].name}
              <input
                id={`scorer-lightning-${side}`}
                type="number"
                inputMode="numeric"
                min={0}
                step={format.lightning.divisor || 1}
                value={values[side]}
                onChange={(changeEvent) => setValues({ ...values, [side]: changeEvent.target.value })}
              />
            </label>
            <button
              type="button"
              className="scorer-choice"
              disabled={values[side] === '' || problem !== null}
              onClick={() => record(side)}
            >
              Record
            </button>
            {problem && <p className="scorer-problem">{problem}</p>}
          </div>
        );
      })}
    </ScorerDialog>
  );
}

/**
 * A note on the game, or a question flagged for tournament control.
 *
 * Flagging is deliberately not a workflow. A protest gets written down and the game carries on;
 * sorting it out is control's job, and stopping a room to run a protest procedure would hold up a
 * round for something that can be settled afterwards.
 */
export function NotesDialog(props: {
  questionNumber: number;
  existing: IDerivedGame['notes'];
  onRecord: (text: string, flagged: boolean) => void;
  onClose: () => void;
}) {
  const { questionNumber, existing, onRecord, onClose } = props;
  const [text, setText] = useState('');
  const [flagged, setFlagged] = useState(false);

  return (
    <ScorerDialog title="Notes" onClose={onClose}>
      {existing.length > 0 && (
        <ul className="scorer-note-list">
          {existing.map((note) => (
            <li key={`${note.questionNumber}-${note.text}`}>
              <span className="scorer-note-q">Q{note.questionNumber}</span>
              {note.flagged && <span className="scorer-note-flag">Flagged</span>}
              <span>{note.text}</span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="scorer-note-form"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          if (text.trim() === '') return;
          onRecord(text.trim(), flagged);
        }}
      >
        <label htmlFor="scorer-note-text">
          Note on question {questionNumber}
          <textarea
            id="scorer-note-text"
            rows={3}
            value={text}
            onChange={(changeEvent) => setText(changeEvent.target.value)}
          />
        </label>
        <label className="scorer-checkbox" htmlFor="scorer-note-flag">
          <input
            id="scorer-note-flag"
            type="checkbox"
            checked={flagged}
            onChange={(changeEvent) => setFlagged(changeEvent.target.checked)}
          />
          Flag this for tournament control
        </label>
        <button type="submit" className="scorer-choice" disabled={text.trim() === ''}>
          Save note
        </button>
      </form>
    </ScorerDialog>
  );
}

/**
 * A manual correction to a team's total.
 *
 * Kept well away from ordinary scoring, and recorded as an adjustment rather than folded into the
 * score, so that a game whose total was nudged says so. A derived score that quietly disagrees with
 * its own events is worse than one that is visibly wrong.
 */
export function AdjustDialog(props: {
  game: IDerivedGame;
  onAdjust: (team: LeftOrRight, points: number, reason: string) => void;
  onClose: () => void;
}) {
  const { game, onAdjust, onClose } = props;
  const [side, setSide] = useState<LeftOrRight>('left');
  const [points, setPoints] = useState('');
  const [reason, setReason] = useState('');

  const valid = points !== '' && Number.isInteger(Number(points)) && Number(points) !== 0;

  return (
    <ScorerDialog title="Adjust score" onClose={onClose}>
      <p className="scorer-dialog-note">
        For matching a total tournament control has already accepted. Ordinary corrections are better made by editing
        the question that was wrong.
      </p>
      <form
        className="scorer-note-form"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          if (!valid) return;
          onAdjust(side, Number(points), reason.trim());
        }}
      >
        <label htmlFor="scorer-adjust-team">
          Team
          <select
            id="scorer-adjust-team"
            value={side}
            onChange={(changeEvent) => setSide(changeEvent.target.value as LeftOrRight)}
          >
            <option value="left">{game.left.name}</option>
            <option value="right">{game.right.name}</option>
          </select>
        </label>
        <label htmlFor="scorer-adjust-points">
          Points (may be negative)
          <input
            id="scorer-adjust-points"
            type="number"
            inputMode="numeric"
            value={points}
            onChange={(changeEvent) => setPoints(changeEvent.target.value)}
          />
        </label>
        <label htmlFor="scorer-adjust-reason">
          Reason
          <input
            id="scorer-adjust-reason"
            type="text"
            value={reason}
            onChange={(changeEvent) => setReason(changeEvent.target.value)}
          />
        </label>
        <button type="submit" className="scorer-choice" disabled={!valid}>
          Record adjustment
        </button>
      </form>
    </ScorerDialog>
  );
}

/**
 * A forfeit.
 *
 * Confirmed rather than one-click, because it ends the game and discards the idea that the questions
 * scored so far decide it. A double forfeit is a real outcome and gets its own option rather than
 * being reached by doing this twice.
 */
export function ForfeitDialog(props: {
  game: IDerivedGame;
  onForfeit: (teams: LeftOrRight[]) => void;
  onClose: () => void;
}) {
  const { game, onForfeit, onClose } = props;
  const [choice, setChoice] = useState<'left' | 'right' | 'both' | ''>('');

  const confirm = () => {
    if (choice === '') return;
    const teams: LeftOrRight[] = choice === 'both' ? ['left', 'right'] : [choice];
    onForfeit(teams);
  };

  return (
    <ScorerDialog title="Record a forfeit" onClose={onClose}>
      <p className="scorer-dialog-note">
        This ends the game. The questions scored so far are kept on the result but no longer decide it.
      </p>
      <div className="scorer-choices">
        <button
          type="button"
          className={choice === 'left' ? 'scorer-choice is-selected' : 'scorer-choice'}
          onClick={() => setChoice('left')}
        >
          {game.left.name} forfeits
        </button>
        <button
          type="button"
          className={choice === 'right' ? 'scorer-choice is-selected' : 'scorer-choice'}
          onClick={() => setChoice('right')}
        >
          {game.right.name} forfeits
        </button>
        <button
          type="button"
          className={choice === 'both' ? 'scorer-choice is-selected' : 'scorer-choice'}
          onClick={() => setChoice('both')}
        >
          Double forfeit
        </button>
      </div>
      <button type="button" className="scorer-danger" disabled={choice === ''} onClick={confirm}>
        Record forfeit
      </button>
    </ScorerDialog>
  );
}
