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
 * # Small on purpose, and not a ceiling
 *
 * It opens as four questions, because four questions is what a document that forgot its rules almost
 * always needs and a rules administration screen is a poor way to start a round. The advanced form is
 * one press away for the tournament whose format the four questions cannot state — two power tiers, an
 * irregular bonus — because "we cannot score this room today" is a worse answer than a longer form.
 * Fixing it upstream by exporting the rules in the QBJ is still the right answer, which is what this
 * screen says.
 *
 * # The fields themselves are shared
 *
 * They are also what Create a game asks, so they live in `ScoringRulesEditor` and this screen supplies
 * only the reason it is asking. What stays here is everything about the missing document: the parser's
 * own complaints, and the request to fix it upstream.
 */
import { useState } from 'react';
import {
  IScoringRulesInput,
  scoringRulesInputDefaults,
  scoringRulesInputFormat,
  scoringRulesInputProblems,
} from '../qbj/ScoringRulesInput';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import ScoringRulesEditor from './ScoringRulesEditor';

export default function ScoringRulesSetup(props: {
  /** Why the scoresheet is asking, in the parser's own words. */
  reason: string[];
  onUse: (format: IScorekeeperFormat) => void;
  onCancel: () => void;
}) {
  const { reason, onUse, onCancel } = props;
  const [input, setInput] = useState<IScoringRulesInput>(scoringRulesInputDefaults);
  const [submitted, setSubmitted] = useState(false);

  const problems = scoringRulesInputProblems(input);

  const submit = () => {
    setSubmitted(true);
    const format = scoringRulesInputFormat(input);
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

      <ScoringRulesEditor idPrefix="rules" value={input} onChange={setInput} />

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
