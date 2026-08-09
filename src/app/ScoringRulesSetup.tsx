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
 * Four questions, no rules editor. Anything more elaborate is better fixed upstream by exporting
 * the rules in the QBJ, which is what this screen says.
 */
import { useState } from 'react';
import {
  IBasicScoringRulesInput,
  basicScoringRulesDefaults,
  basicScoringRulesProblems,
  basicScorekeeperFormat,
} from '../qbj/BasicScoringRules';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';

/** A number field that tolerates being empty while it is being typed in. */
function numberValue(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

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
  const set = (patch: Partial<IBasicScoringRulesInput>) => setInput((current) => ({ ...current, ...patch }));

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

      <div className="rules-setup-grid">
        <label htmlFor="rules-tossup">
          Tossup
          <input
            id="rules-tossup"
            type="number"
            value={String(input.tossupValue)}
            onChange={(event) => set({ tossupValue: numberValue(event.target.value) ?? 0 })}
          />
        </label>
        <label htmlFor="rules-power">
          Power (blank for none)
          <input
            id="rules-power"
            type="number"
            value={input.powerValue === undefined ? '' : String(input.powerValue)}
            onChange={(event) => set({ powerValue: numberValue(event.target.value) })}
          />
        </label>
        <label htmlFor="rules-neg">
          Neg (blank for none)
          <input
            id="rules-neg"
            type="number"
            value={input.negValue === undefined ? '' : String(input.negValue)}
            onChange={(event) => set({ negValue: numberValue(event.target.value) })}
          />
        </label>
        <label htmlFor="rules-tossup-count">
          Tossups in regulation
          <input
            id="rules-tossup-count"
            type="number"
            value={String(input.tossupCount)}
            onChange={(event) => set({ tossupCount: numberValue(event.target.value) ?? 0 })}
          />
        </label>
      </div>

      <label className="rules-setup-check" htmlFor="rules-bonuses">
        <input
          id="rules-bonuses"
          type="checkbox"
          checked={input.useBonuses}
          onChange={(event) => set({ useBonuses: event.target.checked })}
        />
        This tournament uses bonuses
      </label>

      {input.useBonuses && (
        <div className="rules-setup-grid">
          <label htmlFor="rules-bonus-part">
            Points per bonus part
            <input
              id="rules-bonus-part"
              type="number"
              value={String(input.pointsPerBonusPart ?? 10)}
              onChange={(event) => set({ pointsPerBonusPart: numberValue(event.target.value) })}
            />
          </label>
          <label htmlFor="rules-bonus-parts">
            Parts per bonus
            <input
              id="rules-bonus-parts"
              type="number"
              value={String(input.partsPerBonus ?? 3)}
              onChange={(event) => set({ partsPerBonus: numberValue(event.target.value) })}
            />
          </label>
        </div>
      )}

      <label className="rules-setup-check" htmlFor="rules-timed">
        <input
          id="rules-timed"
          type="checkbox"
          checked={input.timed === true}
          onChange={(event) => set({ timed: event.target.checked })}
        />
        Rounds run on a clock
      </label>

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
