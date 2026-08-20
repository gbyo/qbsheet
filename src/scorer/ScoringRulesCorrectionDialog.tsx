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
import { IScoringRulesInput, advancedRulesInput, scoringRulesInputFormat } from '../qbj/ScoringRulesInput';
import { advancedFromFormat } from '../qbj/AdvancedScoringRules';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { ScoreEvent } from '../scoring/ScoreEvents';
import correctFormat, { IFormatChange } from '../scoring/formatCorrection';

export interface IScoringRulesCorrection {
  format: IScorekeeperFormat;
  events: ScoreEvent[];
  changes: IFormatChange[];
}

export default function ScoringRulesCorrectionDialog(props: {
  format: IScorekeeperFormat;
  events: ScoreEvent[];
  /** Persist the corrected rules and the re-pointed history together, or neither. */
  onCorrect: (correction: IScoringRulesCorrection) => void | Promise<void>;
  onClose: () => void;
  /** True while a submission is in flight, when nothing about the game may change. */
  disabled?: boolean;
}) {
  const { format, events, onCorrect, onClose, disabled = false } = props;
  const [input, setInput] = useState<IScoringRulesInput>(() => advancedRulesInput(advancedFromFormat(format)));
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  /*
   * Recomputed as the form changes rather than on submit, so the consequences are on screen while
   * the scorekeeper is still deciding. A correction that is going to be refused should say so before
   * somebody has finished typing it, not after.
   */
  const proposed = useMemo(() => scoringRulesInputFormat(input), [input]);
  const correction = useMemo(
    () => (proposed ? correctFormat(format, proposed, events) : null),
    [format, proposed, events],
  );

  const blocked = correction === null || !correction.ok;
  const problems = correction && !correction.ok ? correction.problems : [];
  const changes = correction?.ok ? correction.changes : [];
  const repricing = changes.some((change) => change.affectsRecordedScoring);

  const apply = async () => {
    if (!correction?.ok || saving || disabled) return;
    setSaving(true);
    await onCorrect({ format: correction.format, events: correction.events, changes: correction.changes });
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
          {changes.map((change) => (
            <div key={`${change.subject}-${change.detail}`} className="rules-correction-change">
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
          Every question stays exactly as the scorekeeper recorded it. Only what those answers are
          worth changes, and the scoresheet is recalculated from the start of the game.
        </p>

        <div className="rules-correction-actions">
          <button type="button" className="scorer-action" onClick={() => setConfirming(false)} disabled={saving}>
            Back
          </button>
          <button type="button" className="scorer-choice" onClick={() => void apply()} disabled={saving || disabled}>
            {saving ? 'Applying…' : 'Apply corrected rules'}
          </button>
        </div>
      </ScorerDialog>
    );
  }

  return (
    <ScorerDialog title="Correct the scoring rules" onClose={onClose} wide>
      <p className="scorer-dialog-note">
        For a tournament that has corrected its own rules mid-round. The questions already scored are
        kept and recalculated; nothing is re-entered.
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
