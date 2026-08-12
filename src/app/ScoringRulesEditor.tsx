/**
 * The scoring rules, in whichever form the scorekeeper is working in, plus the switch between them.
 *
 * # Why the switch lives here and not in each screen
 *
 * Both screens that ask for scoring rules — a QBJ that carried none, and a game being created from
 * nothing — need the same two modes and the same rule about moving between them. Putting the toggle in
 * each of them would be two places to get "going back would discard a power tier" wrong, and only one
 * of them would get fixed.
 *
 * # The switch is a fact, not a preference
 *
 * Basic to advanced is always offered: the advanced form can state everything the basic one can.
 * Advanced to basic is offered only when the format fits — `advancedFitsBasicForm` — and the control
 * says why when it does not, rather than being disabled with no explanation or, worse, silently
 * dropping the second power tier on the way. A form that shows a format nobody entered is the failure
 * mode worth spending a sentence on.
 */
import { advancedFitsBasicForm } from '../qbj/AdvancedScoringRules';
import { IScoringRulesInput, scoringRulesInputAs } from '../qbj/ScoringRulesInput';
import AdvancedScoringRulesEditor from './AdvancedScoringRulesEditor';
import BasicScoringRulesEditor, { BasicScoringRulesVariant } from './BasicScoringRulesEditor';

export default function ScoringRulesEditor(props: {
  value: IScoringRulesInput;
  onChange: (value: IScoringRulesInput) => void;
  /** Prefix for every input id on this instance. Required; see `BasicScoringRulesEditor`. */
  idPrefix: string;
  /** Which basic form to show. The advanced form has no variants. */
  basicVariant?: BasicScoringRulesVariant;
  /** What this screen can say about the clock, when it has something to say. */
  timedHint?: string;
}) {
  const { value, onChange, idPrefix, basicVariant = 'basic', timedHint } = props;
  const canSimplify = value.mode === 'advanced' && advancedFitsBasicForm(value.advanced);

  return (
    <div className="rules-editor">
      {value.mode === 'basic' ? (
        <BasicScoringRulesEditor
          idPrefix={idPrefix}
          variant={basicVariant}
          value={value.basic}
          onChange={(basic) => onChange({ mode: 'basic', basic })}
          timedHint={timedHint}
        />
      ) : (
        <AdvancedScoringRulesEditor
          idPrefix={idPrefix}
          value={value.advanced}
          onChange={(advanced) => onChange({ mode: 'advanced', advanced })}
          timedHint={timedHint}
        />
      )}

      <div className="rules-mode">
        {value.mode === 'basic' ? (
          <>
            <button
              type="button"
              className="shell-button"
              onClick={() => onChange(scoringRulesInputAs(value, 'advanced'))}
            >
              Advanced rules
            </button>
            <p className="shell-hint rules-mode-hint">
              For more than one power tier, more than one neg, a zero-point answer, or bonuses whose
              parts are not all worth the same.
            </p>
          </>
        ) : (
          <>
            <button
              type="button"
              className="shell-button"
              disabled={!canSimplify}
              onClick={() => onChange(scoringRulesInputAs(value, 'basic'))}
            >
              Simple rules
            </button>
            <p className="shell-hint rules-mode-hint">
              {canSimplify
                ? 'These rules also fit the simple form. Nothing is lost either way.'
                : /* Not "would change what this game is worth": an extended regulation and a renamed
                     answer type are both things the simple form cannot hold and neither changes a
                     score. The sentence has to cover what the check actually refuses. */
                  'The simple form cannot state these rules, so going back would change them.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
