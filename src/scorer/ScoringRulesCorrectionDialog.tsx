/**
 * Correcting the scoring rules of the game on screen.
 *
 * # Two steps, because the second one is the whole point
 *
 * The form is the same one that created the rules in the first place — a scorekeeper who typed them
 * in should not meet a second, different editor when correcting them. What is new is the step after
 * it: `correctFormat` says exactly what the change would do to the questions already scored, and
 * that list is shown and confirmed before anything is written. See `formatCorrection` for why some
 * corrections are refused outright rather than warned about.
 *
 * A confirmation that said "this will change the scoring rules" would be worthless. "Power: 15
 * points → 20 points, and 4 answers already recorded are affected" is something a scorekeeper can
 * take to a tournament director.
 *
 * # Why it opens on the advanced form
 *
 * `advancedFromFormat` is total; the reverse into the simple form is not, and a game whose rules
 * arrived in a QBJ frequently says something the three-field form cannot hold. Opening on the form
 * that can express whatever this game actually uses means the scorekeeper never sees their
 * tournament's rules silently simplified on the way in. The editor still offers `Simple rules` when
 * the format fits it, which is the same rule every other rules screen follows.
 */
import { useMemo, useState } from 'react';
import ScorerDialog from './ScorerDialog';
import ScoringRulesEditor from '../app/ScoringRulesEditor';
import {
  IScoringRulesInput,
  advancedRulesInput,
  scoringRulesInputFormat,
  scoringRulesInputProblems,
} from '../qbj/ScoringRulesInput';
import { advancedFromFormat } from '../qbj/AdvancedScoringRules';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IGameSetup } from '../scoring/deriveGame';
import { ScoreEvent } from '../scoring/ScoreEvents';
import correctFormat, { IFormatChange } from '../scoring/formatCorrection';

/**
 * A refusal whose message the room is meant to read.
 *
 * The host's write can fail in two materially different ways — nothing was written, or nothing could
 * be put back — and only the host can tell them apart, so only the host can supply the sentence. But
 * "show whatever was thrown" is not the way to let it: an exception out of IndexedDB carries an
 * internal message, and this application redacts error text everywhere else it displays any (see
 * `ErrorLog` and `redact`). So the permission is explicit, and anything else falls back to the
 * dialog's own wording.
 */
export class ScoringRulesCorrectionRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoringRulesCorrectionRefusal';
  }
}

export interface IScoringRulesCorrection {
  format: IScorekeeperFormat;
  events: ScoreEvent[];
  /**
   * The history as it stood before the correction, so a refused write can be undone.
   *
   * The two halves of a correction — the re-pointed history and the corrected format — go to two
   * different storages, and the second can be refused after the first has been accepted. What is
   * left then is a journal whose buzzes point at positions only the format that was refused has,
   * which is a game that reads as though it were scored wrong on purpose. Nothing about the
   * re-pointed array says where it came from, so the way back has to travel with it.
   *
   * Carried on the correction rather than re-read by the host because this is the array the host's
   * journal actually holds at this moment: the scoresheet behind this dialog is inert while it is
   * open, so nothing can have been scored since `events` was read.
   */
  previousEvents: ScoreEvent[];
  changes: IFormatChange[];
}

export default function ScoringRulesCorrectionDialog(props: {
  format: IScorekeeperFormat;
  events: ScoreEvent[];
  /** The rosters, so a lower players cap is checked against the opening lineup too. */
  setup: IGameSetup;
  /**
   * Persist the corrected rules and the re-pointed history together, or neither.
   *
   * Rejecting means nothing was written. The dialog stays open and says so, rather than closing over
   * a correction that did not happen.
   */
  onCorrect: (correction: IScoringRulesCorrection) => void | Promise<void>;
  onClose: () => void;
  /** True while a submission is in flight, when nothing about the game may change. */
  disabled?: boolean;
}) {
  const { format, events, setup, onCorrect, onClose, disabled = false } = props;
  const [input, setInput] = useState<IScoringRulesInput>(() =>
    advancedRulesInput(advancedFromFormat(format)),
  );
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');

  /*
   * Recomputed as the form changes rather than on submit, so the consequences are on screen while
   * the scorekeeper is still deciding. A correction that is going to be refused should say so before
   * somebody has finished typing it, not after.
   */
  const proposed = useMemo(() => scoringRulesInputFormat(input), [input]);
  const correction = useMemo(
    () => (proposed ? correctFormat(format, proposed, events, setup) : null),
    [format, proposed, events, setup],
  );

  /*
   * What the form itself is complaining about, which has to be shown here for the same reason it is
   * shown on the two setup screens that ask for scoring rules.
   *
   * `scoringRulesInputFormat` returns null for any form the rules screens would refuse — a cleared
   * regulation count, a part value nobody has typed yet — and `correctFormat` cannot run without a
   * format to compare against. So this screen had a state, reachable by clearing one field, in which
   * `problems` was empty, no explanation appeared anywhere, and `Review changes` was disabled: a
   * scorekeeper mid-correction with a greyed button and nothing to read. The messages existed all
   * along; `ScoringRulesSetup` and `ManualGame` were both already showing them.
   *
   * Mutually exclusive with the correction's own problems by construction — a non-null `proposed`
   * means this list is empty — so the order below is a statement about which layer answers first
   * rather than a choice between two things to say.
   */
  const fieldProblems = useMemo(() => scoringRulesInputProblems(input), [input]);

  const blocked = correction === null || !correction.ok;
  const correctionProblems = correction && !correction.ok ? correction.problems : [];
  const problems = fieldProblems.length > 0 ? fieldProblems : correctionProblems;
  const changes = correction?.ok ? correction.changes : [];
  const repricing = changes.some((change) => change.affectsRecordedScoring);

  const apply = async () => {
    if (!correction?.ok || saving || disabled) return;
    setSaving(true);
    setFailure('');
    try {
      await onCorrect({
        format: correction.format,
        events: correction.events,
        previousEvents: events,
        changes: correction.changes,
      });
    } catch (thrown) {
      /*
       * Nothing was written. Staying open is the whole point: the scorekeeper's proposed rules are
       * still in the form behind this screen, so pressing the button again is the retry, and closing
       * would leave a room believing a correction had been applied when the device refused it.
       *
       * The host's own sentence wins when it marked one for the room, because "nothing has changed"
       * is a claim only the host can make. It is true when the writes were refused or undone, and
       * there is one narrow case — a device that refused to put the history back either — where it
       * is the opposite of true and the room has to be told something else entirely.
       */
      setSaving(false);
      setFailure(
        thrown instanceof ScoringRulesCorrectionRefusal && thrown.message.trim() !== ''
          ? thrown.message
          : 'Those rules could not be saved on this device. Nothing has changed; try again.',
      );
      return;
    }
    onClose();
  };

  if (confirming && correction?.ok) {
    return (
      <ScorerDialog title="Apply these scoring rules?" onClose={onClose}>
        <p className="scorer-dialog-note">
          {repricing
            ? 'This changes what questions already on the scoresheet are worth. The scores will move.'
            : 'Nothing already on the scoresheet changes value.'}
        </p>

        <dl className="rules-correction-changes">
          {/* Indexed, because two changes can legitimately read the same -- two answer types both
              gaining a bonus produce identical subject and detail. */}
          {changes.map((change, position) => (
            <div key={`${position}-${change.subject}-${change.detail}`} className="rules-correction-change">
              <dt>{change.subject}</dt>
              <dd>
                {change.detail}
                {change.affectsRecordedScoring && (
                  <span className="rules-correction-affected"> · already recorded in this game</span>
                )}
              </dd>
            </div>
          ))}
        </dl>

        <p className="scorer-dialog-note">
          Every question stays exactly as the scorekeeper recorded it. Only what those answers are worth
          changes, and the scoresheet is recalculated from the start of the game.
        </p>

        {failure !== '' && (
          <p className="scorer-problem" role="alert">
            {failure}
          </p>
        )}

        <div className="rules-correction-actions">
          <button
            type="button"
            className="scorer-action"
            onClick={() => setConfirming(false)}
            disabled={saving}
          >
            Back
          </button>
          <button
            type="button"
            className="scorer-choice"
            onClick={() => void apply()}
            disabled={saving || disabled}
          >
            {saving ? 'Applying…' : 'Apply corrected rules'}
          </button>
        </div>
      </ScorerDialog>
    );
  }

  return (
    <ScorerDialog title="Correct the scoring rules" onClose={onClose} wide>
      <p className="scorer-dialog-note">
        For a tournament that has corrected its own rules mid-round. The questions already scored are kept and
        recalculated; nothing is re-entered.
      </p>

      <ScoringRulesEditor value={input} onChange={setInput} idPrefix="rules-correction" />

      {problems.length > 0 && (
        <div className="scorer-question-errors" role="alert">
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      {correction?.ok && correction.unchanged && (
        <p className="scorer-dialog-note" role="status">
          These are the rules this game is already being scored under.
        </p>
      )}

      <div className="rules-correction-actions">
        <button type="button" className="scorer-action" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="scorer-choice"
          disabled={blocked || disabled || (correction?.ok ? correction.unchanged : true)}
          onClick={() => setConfirming(true)}
        >
          Review changes
        </button>
      </div>
    </ScorerDialog>
  );
}
