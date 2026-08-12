/**
 * Asking for the scoring rules a QBJ did not carry.
 *
 * # Why this exists rather than a default
 *
 * A generic QBJ can arrive with no `ScoringRules` at all. The scoresheet then knows the teams, the
 * round and the room, and does not know what a tossup is worth — and the two tempting answers are
 * both wrong. Refusing the file makes the scoresheet useless for exactly the interoperability it
 * claims. Assuming a familiar rule set produces a game scored under somebody else's tournament,
 * silently, with nobody in the room aware there was a question.
 *
 * So it asks. The values are shown, they start at the most common shape rather than an empty form,
 * and nothing is applied until the scorekeeper submits.
 *
 * # Small on purpose
 *
 * This is still a compact rule-entry surface rather than a complete QBJ authoring tool. It uses the
 * shared structural variant so every default that can affect scoring is visible, while unusual
 * answer tiers, irregular bonuses, and other full QBJ shapes remain file-provided.
 *
 * # The fields themselves are shared
 *
 * They are also what Create a game asks, so they live in `BasicScoringRulesEditor` and this screen
 * supplies only the reason it is asking. What stays here is everything about the missing document:
 * the parser's own complaints, and the request to fix it upstream.
 */
import { useState } from 'react';
import {
  IBasicScoringRulesInput,
  basicScoringRulesDefaults,
  basicScoringRulesProblems,
  basicScorekeeperFormat,
} from '../qbj/BasicScoringRules';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import BasicScoringRulesEditor from './BasicScoringRulesEditor';

export default function ScoringRulesSetup(props: {
  /** Why the scoresheet is asking, in the parser's own words. */
  reason: string[];
  onUse: (format: IScorekeeperFormat) => void;
  onCancel: () => void;
}) {
  const { reason, onUse, onCancel } = props;
  const [input, setInput] = useState<IBasicScoringRulesInput>(basicScoringRulesDefaults);
  const [submitted, setSubmitted] = useState(false);

  const problems = basicScoringRulesProblems(input);

  const submit = () => {
    setSubmitted(true);
    const format = basicScorekeeperFormat(input);
    if (format) onUse(format);
  };

  return (
    <section className="rules-setup">
      <h2 className="rules-setup-title">Scoring rules needed</h2>
      {reason.map((line) => (
        <p key={line} className="rules-setup-reason">
          {line}
        </p>
      ))}
      <p className="rules-setup-reason">
        Enter the rules this game is played under. Ask tournament control to include scoring rules in
        the QBJ to avoid this next time.
      </p>

      <BasicScoringRulesEditor idPrefix="rules" value={input} onChange={setInput} variant="full" />

      {submitted && problems.length > 0 && (
        <div className="shell-errors" role="alert">
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="rules-setup-actions">
        <button type="button" className="shell-button is-primary" onClick={submit}>
          Use these rules
        </button>
        <button type="button" className="shell-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
