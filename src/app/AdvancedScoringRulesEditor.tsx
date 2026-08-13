/**
 * The fields a scorekeeper states an unusual scoring format in.
 *
 * # A table of answer types, because that is what a format has
 *
 * The basic editor asks three questions — power, correct, neg — which is the shape of most formats and
 * not the shape of a format. `IScorekeeperFormat` has always carried an arbitrary list, so a tournament
 * with two power tiers, or a 20-point tossup with a 10-point partial, or two different negs, is
 * something the scorer can score and the form could not say. Here it is a list: add a row, give it a
 * value and a name, say whether it earns a bonus, remove it, move it.
 *
 * # No sorting while somebody is typing
 *
 * The scorer shows answer types descending by value — powers first, negs last — and
 * `readQbjScoringRules` establishes that order, exactly as it does for an imported file. This form
 * deliberately does not: a table that reshuffles itself as a value is typed moves the row out from
 * under the cursor, and typing "15" into a row briefly makes it a "1". Order here is the order rows
 * were added, and Move up / Move down are there for a director who wants the table to read the way the
 * scorer will.
 *
 * # It holds no state and decides nothing
 *
 * Like `BasicScoringRulesEditor`: it renders `IAdvancedScoringRulesInput` and reports edits. What the
 * values mean is `AdvancedScoringRules`, which builds a standard `ScoringRules` object and reads it
 * back through the same mapper a file goes through.
 */
import {
  IAdvancedAnswerTypeInput,
  IAdvancedScoringRulesInput,
  newAdvancedAnswerType,
} from '../qbj/AdvancedScoringRules';
import { numberValue } from './BasicScoringRulesEditor';

/** Above this a table is a data-entry problem, not a rule set. `readQbjScoringRules` caps at 50. */
const maximumAnswerTypeRows = 20;

export default function AdvancedScoringRulesEditor(props: {
  value: IAdvancedScoringRulesInput;
  onChange: (value: IAdvancedScoringRulesInput) => void;
  /** Prefix for every input id on this instance. Required; see `BasicScoringRulesEditor`. */
  idPrefix: string;
  /** What this screen can say about the clock, when it has something to say. */
  timedHint?: string;
}) {
  const { value, onChange, idPrefix, timedHint } = props;
  const set = (patch: Partial<IAdvancedScoringRulesInput>) => onChange({ ...value, ...patch });
  const id = (suffix: string) => `${idPrefix}-${suffix}`;

  const setRow = (position: number, patch: Partial<IAdvancedAnswerTypeInput>) =>
    set({
      answerTypes: value.answerTypes.map((row, index) => (index === position ? { ...row, ...patch } : row)),
    });

  const removeRow = (position: number) =>
    set({ answerTypes: value.answerTypes.filter((_, index) => index !== position) });

  const moveRow = (position: number, direction: -1 | 1) => {
    const destination = position + direction;
    if (destination < 0 || destination >= value.answerTypes.length) return;
    const rows = [...value.answerTypes];
    [rows[position], rows[destination]] = [rows[destination], rows[position]];
    set({ answerTypes: rows });
  };

  return (
    <div className="rules-fields">
      <fieldset className="manual-fieldset answer-types">
        <legend className="shell-label">Answer types</legend>
        <p className="shell-hint answer-types-hint">
          Every way a tossup can be answered, and what each is worth. Use a negative value for a neg.
          The scorer shows them highest value first, whatever order they are in here.
        </p>

        {value.answerTypes.length === 0 && (
          <p className="shell-hint">No answer types yet. A format needs at least one.</p>
        )}

        {value.answerTypes.map((row, position) => {
          // The row's accessible names say what it is rather than where it is: "Value for answer type
          // 2" changes meaning when row 1 is deleted, and a screen reader user would be editing a
          // field whose name no longer matches it. A named row says its name; an unnamed one says its
          // value; a row with neither is new, and its position is all there is.
          const described =
            row.label.trim() !== ''
              ? row.label.trim()
              : row.value !== undefined
                ? `${row.value} points`
                : `new answer type ${position + 1}`;
          return (
            <div key={row.key} className="answer-type-row">
              <div className="answer-type-field answer-type-value">
                <label className="shell-label" htmlFor={id(`value-${row.key}`)}>
                  Points
                </label>
                <input
                  id={id(`value-${row.key}`)}
                  className="shell-input manual-number"
                  type="number"
                  inputMode="numeric"
                  value={row.value === undefined ? '' : String(row.value)}
                  onChange={(event) => setRow(position, { value: numberValue(event.target.value) })}
                />
              </div>

              <div className="answer-type-field answer-type-field-grow">
                <label className="shell-label" htmlFor={id(`label-${row.key}`)}>
                  Name
                </label>
                <input
                  id={id(`label-${row.key}`)}
                  className="shell-input"
                  type="text"
                  autoComplete="off"
                  placeholder="Power"
                  value={row.label}
                  onChange={(event) => setRow(position, { label: event.target.value })}
                />
              </div>

              <div className="answer-type-field answer-type-short">
                <label className="shell-label" htmlFor={id(`short-${row.key}`)}>
                  Short
                </label>
                <input
                  id={id(`short-${row.key}`)}
                  className="shell-input"
                  type="text"
                  autoComplete="off"
                  maxLength={4}
                  placeholder="P"
                  value={row.shortLabel}
                  onChange={(event) => setRow(position, { shortLabel: event.target.value })}
                />
              </div>

              <label className="rules-setup-check answer-type-bonus" htmlFor={id(`bonus-${row.key}`)}>
                <input
                  id={id(`bonus-${row.key}`)}
                  type="checkbox"
                  checked={row.awardsBonus}
                  onChange={(event) => setRow(position, { awardsBonus: event.target.checked })}
                />
                Earns a bonus
              </label>

              <div className="answer-type-actions">
                <button
                  type="button"
                  className="shell-button"
                  aria-label={`Move ${described} up`}
                  disabled={position === 0}
                  onClick={() => moveRow(position, -1)}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="shell-button"
                  aria-label={`Move ${described} down`}
                  disabled={position === value.answerTypes.length - 1}
                  onClick={() => moveRow(position, 1)}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="shell-button"
                  aria-label={`Remove ${described}`}
                  onClick={() => removeRow(position)}
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}

        {value.answerTypes.length < maximumAnswerTypeRows && (
          <button
            type="button"
            className="shell-button answer-type-add"
            // A new row follows the format it is being added to, so a bonus-free one does not open
            // with a bonus checked and a complaint about it.
            onClick={() =>
              set({ answerTypes: [...value.answerTypes, newAdvancedAnswerType({ awardsBonus: value.useBonuses })] })
            }
          >
            Add an answer type
          </button>
        )}
      </fieldset>

      <div className="rules-setup-grid">
        <label htmlFor={id('tossup-count')}>
          Tossups in regulation
          <input
            id={id('tossup-count')}
            type="number"
            value={String(value.tossupCount)}
            onChange={(event) => set({ tossupCount: numberValue(event.target.value) ?? 0 })}
          />
        </label>
        <label htmlFor={id('max-tossup-count')}>
          Most tossups possible
          <input
            id={id('max-tossup-count')}
            type="number"
            value={value.maximumTossupCount === undefined ? '' : String(value.maximumTossupCount)}
            onChange={(event) => set({ maximumTossupCount: numberValue(event.target.value) })}
          />
        </label>
        <label htmlFor={id('max-active')}>
          Players playing at once
          <input
            id={id('max-active')}
            type="number"
            value={value.maximumPlayersPerTeam === undefined ? '' : String(value.maximumPlayersPerTeam)}
            onChange={(event) => set({ maximumPlayersPerTeam: numberValue(event.target.value) ?? 0 })}
          />
        </label>
      </div>
      <p className="shell-hint rules-fields-hint">
        Blank “Most tossups possible” means regulation cannot run long.
      </p>

      <label className="rules-setup-check" htmlFor={id('bonuses')}>
        <input
          id={id('bonuses')}
          type="checkbox"
          checked={value.useBonuses}
          onChange={(event) => set({ useBonuses: event.target.checked })}
        />
        Use bonuses
      </label>

      {value.useBonuses && (
        <div className="manual-field-inset">
          <fieldset className="manual-fieldset">
            <legend className="shell-label">Bonus structure</legend>
            {(
              [
                ['regular', 'Every bonus is the same: fixed parts, each worth the same'],
                ['irregular', 'Bonuses vary in parts or in what a part is worth'],
              ] as const
            ).map(([structure, label]) => (
              <label key={structure} className="rules-setup-check" htmlFor={id(`bonus-${structure}`)}>
                <input
                  id={id(`bonus-${structure}`)}
                  type="radio"
                  name={id('bonus-structure')}
                  value={structure}
                  checked={value.bonusStructure === structure}
                  onChange={() => set({ bonusStructure: structure })}
                />
                {label}
              </label>
            ))}
            <p className="shell-hint answer-types-hint">
              {value.bonusStructure === 'regular'
                ? 'The scorer offers a button per part.'
                : 'The scorer takes the bonus total as a number, because there is no fixed set of parts to offer.'}
            </p>
          </fieldset>

          {value.bonusStructure === 'regular' ? (
            <div className="rules-setup-grid">
              <label htmlFor={id('bonus-part')}>
                Points per bonus part
                <input
                  id={id('bonus-part')}
                  type="number"
                  value={value.pointsPerBonusPart === undefined ? '' : String(value.pointsPerBonusPart)}
                  onChange={(event) => set({ pointsPerBonusPart: numberValue(event.target.value) })}
                />
              </label>
              <label htmlFor={id('bonus-parts')}>
                Parts per bonus
                <input
                  id={id('bonus-parts')}
                  type="number"
                  value={value.partsPerBonus === undefined ? '' : String(value.partsPerBonus)}
                  onChange={(event) => set({ partsPerBonus: numberValue(event.target.value) })}
                />
              </label>
            </div>
          ) : (
            <>
              <div className="rules-setup-grid">
                <label htmlFor={id('bonus-max')}>
                  Most a bonus is worth
                  <input
                    id={id('bonus-max')}
                    type="number"
                    value={value.maximumBonusScore === undefined ? '' : String(value.maximumBonusScore)}
                    onChange={(event) => set({ maximumBonusScore: numberValue(event.target.value) })}
                  />
                </label>
                <label htmlFor={id('bonus-divisor')}>
                  Bonus score increment
                  <input
                    id={id('bonus-divisor')}
                    type="number"
                    value={value.bonusDivisor === undefined ? '' : String(value.bonusDivisor)}
                    onChange={(event) => set({ bonusDivisor: numberValue(event.target.value) })}
                  />
                </label>
                <label htmlFor={id('bonus-min-parts')}>
                  Fewest parts
                  <input
                    id={id('bonus-min-parts')}
                    type="number"
                    value={value.minimumPartsPerBonus === undefined ? '' : String(value.minimumPartsPerBonus)}
                    onChange={(event) => set({ minimumPartsPerBonus: numberValue(event.target.value) })}
                  />
                </label>
                <label htmlFor={id('bonus-max-parts')}>
                  Most parts
                  <input
                    id={id('bonus-max-parts')}
                    type="number"
                    value={value.maximumPartsPerBonus === undefined ? '' : String(value.maximumPartsPerBonus)}
                    onChange={(event) => set({ maximumPartsPerBonus: numberValue(event.target.value) })}
                  />
                </label>
              </div>
              <p className="shell-hint rules-fields-hint">
                The increment is the largest number that always divides a bonus total. For parts worth
                10, 10 and 20 that is 10.
              </p>
            </>
          )}

          <label className="rules-setup-check" htmlFor={id('bounce-back')}>
            <input
              id={id('bounce-back')}
              type="checkbox"
              checked={value.bonusesBounceBack}
              onChange={(event) => set({ bonusesBounceBack: event.target.checked })}
            />
            Missed parts bounce back
          </label>
        </div>
      )}

      <label className="rules-setup-check" htmlFor={id('timed')}>
        <input
          id={id('timed')}
          type="checkbox"
          checked={value.timed === true}
          onChange={(event) => set({ timed: event.target.checked })}
        />
        Round is timed
      </label>
      {timedHint && <p className="shell-hint rules-fields-hint">{timedHint}</p>}

      <section className="rules-advanced" aria-labelledby={id('advanced-heading')}>
        <h3 id={id('advanced-heading')} className="rules-advanced-heading">
          Overtime and lightning
        </h3>
        <div className="rules-setup-grid">
          <label htmlFor={id('overtime-count')}>
            Initial overtime tossups
            <input
              id={id('overtime-count')}
              type="number"
              value={value.overtimeQuestionCount === undefined ? '' : String(value.overtimeQuestionCount)}
              onChange={(event) => set({ overtimeQuestionCount: numberValue(event.target.value) })}
            />
          </label>
        </div>
        <p className="shell-hint rules-fields-hint">One tossup means overtime is sudden death.</p>

        <label className="rules-setup-check" htmlFor={id('overtime-bonuses')}>
          <input
            id={id('overtime-bonuses')}
            type="checkbox"
            checked={value.overtimeIncludesBonuses === true}
            onChange={(event) => set({ overtimeIncludesBonuses: event.target.checked })}
          />
          Bonuses in overtime
        </label>

        <label className="rules-setup-check" htmlFor={id('lightning')}>
          <input
            id={id('lightning')}
            type="checkbox"
            checked={value.useLightning === true}
            onChange={(event) => set({ useLightning: event.target.checked })}
          />
          Use lightning
        </label>

        {value.useLightning === true && (
          <div className="rules-setup-grid">
            <label htmlFor={id('lightning-count')}>
              Lightning rounds per team
              <input
                id={id('lightning-count')}
                type="number"
                value={value.lightningCountPerTeam === undefined ? '' : String(value.lightningCountPerTeam)}
                onChange={(event) => set({ lightningCountPerTeam: numberValue(event.target.value) })}
              />
            </label>
            <label htmlFor={id('lightning-divisor')}>
              Lightning score increment
              <input
                id={id('lightning-divisor')}
                type="number"
                value={value.lightningDivisor === undefined ? '' : String(value.lightningDivisor)}
                onChange={(event) => set({ lightningDivisor: numberValue(event.target.value) })}
              />
            </label>
          </div>
        )}
      </section>
    </div>
  );
}
