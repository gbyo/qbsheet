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
 *
 * # Grouped the same way, in the same order
 *
 * The fields are grouped — the answer types, the bonuses, the round, overtime — with the same
 * `field-group` treatment and in the same order as the simple form, because the button between them
 * says these are two ways of stating one thing. A scorekeeper who presses Advanced rules should find
 * the form they were already reading with more in it, not a different form; groups that sat in a
 * different order, or that only one of the two had, would make the switch feel like losing their
 * place. See `BasicScoringRulesEditor` for why the groups are the ones they are.
 */
import {
  IAdvancedAnswerTypeInput,
  IAdvancedScoringRulesInput,
  newAdvancedAnswerType,
} from '../qbj/AdvancedScoringRules';
import { numberValue } from './BasicScoringRulesEditor';
import HelpTooltip from './HelpTooltip';

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
      <fieldset className="field-group answer-types" aria-labelledby={id('answer-types-legend')}>
        <legend className="field-group-legend">
          <span className="label-with-help">
            <span id={id('answer-types-legend')}>Answer types</span>
            <HelpTooltip label="Explain tossup ruling choices">
              An answer type is one possible tossup ruling, such as power, correct, or neg. Each row becomes a
              scoring choice during the game.
            </HelpTooltip>
          </span>
        </legend>
        <p className="shell-hint answer-types-hint">
          Every way a tossup can be answered, and what each is worth. Use a negative value for a neg. The
          scorer shows them highest value first, whatever order they are in here.
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
                  inputMode="decimal"
                  step={1}
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
                <div className="label-with-help">
                  <label className="shell-label" htmlFor={id(`short-${row.key}`)}>
                    Short
                  </label>
                  <HelpTooltip label="Explain compact ruling labels">
                    The compact label shown on scoring buttons and in the keyboard guide, such as P for Power.
                  </HelpTooltip>
                </div>
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
              set({
                answerTypes: [...value.answerTypes, newAdvancedAnswerType({ awardsBonus: value.useBonuses })],
              })
            }
          >
            Add an answer type
          </button>
        )}
      </fieldset>

      <fieldset className="field-group">
        <legend className="field-group-legend">Bonuses</legend>
        <label className="rules-setup-check" htmlFor={id('bonuses')}>
          <input
            id={id('bonuses')}
            type="checkbox"
            checked={value.useBonuses}
            onChange={(event) =>
              set({
                useBonuses: event.target.checked,
                ...(event.target.checked
                  ? {}
                  : {
                      bonusesBounceBack: false,
                      overtimeIncludesBonuses: false,
                      answerTypes: value.answerTypes.map((row) => ({ ...row, awardsBonus: false })),
                    }),
              })
            }
          />
          Use bonuses
        </label>

        {value.useBonuses && (
          <div className="manual-field-inset">
            <fieldset className="manual-fieldset" aria-labelledby={id('bonus-structure-legend')}>
              <legend className="shell-label">
                <span className="label-with-help">
                  <span id={id('bonus-structure-legend')}>Bonus structure</span>
                  <HelpTooltip label="Explain regular and irregular bonuses">
                    Choose regular when every bonus has the same number of equally valued parts. Otherwise
                    QBSheet records the total directly.
                  </HelpTooltip>
                </span>
              </legend>
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
                  ? 'The scorer offers fixed total-score buttons first; Parts opens an optional part-by-part view.'
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
                    min={1}
                    step={1}
                    value={value.pointsPerBonusPart === undefined ? '' : String(value.pointsPerBonusPart)}
                    onChange={(event) => set({ pointsPerBonusPart: numberValue(event.target.value) })}
                  />
                </label>
                <label htmlFor={id('bonus-parts')}>
                  Parts per bonus
                  <input
                    id={id('bonus-parts')}
                    type="number"
                    min={1}
                    step={1}
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
                      min={1}
                      step={1}
                      value={value.maximumBonusScore === undefined ? '' : String(value.maximumBonusScore)}
                      onChange={(event) => set({ maximumBonusScore: numberValue(event.target.value) })}
                    />
                  </label>
                  <div>
                    <div className="label-with-help">
                      <label htmlFor={id('bonus-divisor')}>Bonus score increment</label>
                      <HelpTooltip label="Explain valid bonus-total steps">
                        The smallest step between possible bonus totals. For example, use 10 when totals can
                        be 0, 10, 20, 30, and so on.
                      </HelpTooltip>
                    </div>
                    <input
                      id={id('bonus-divisor')}
                      type="number"
                      min={1}
                      step={1}
                      value={value.bonusDivisor === undefined ? '' : String(value.bonusDivisor)}
                      onChange={(event) => set({ bonusDivisor: numberValue(event.target.value) })}
                    />
                  </div>
                  <label htmlFor={id('bonus-min-parts')}>
                    Fewest parts
                    <input
                      id={id('bonus-min-parts')}
                      type="number"
                      min={1}
                      step={1}
                      value={
                        value.minimumPartsPerBonus === undefined ? '' : String(value.minimumPartsPerBonus)
                      }
                      onChange={(event) => set({ minimumPartsPerBonus: numberValue(event.target.value) })}
                    />
                  </label>
                  <label htmlFor={id('bonus-max-parts')}>
                    Most parts
                    <input
                      id={id('bonus-max-parts')}
                      type="number"
                      min={1}
                      step={1}
                      value={
                        value.maximumPartsPerBonus === undefined ? '' : String(value.maximumPartsPerBonus)
                      }
                      onChange={(event) => set({ maximumPartsPerBonus: numberValue(event.target.value) })}
                    />
                  </label>
                </div>
                <p className="shell-hint rules-fields-hint">
                  The increment is the largest number that always divides a bonus total. For parts worth 10,
                  10 and 20 that is 10.
                </p>
              </>
            )}

            <div className="rules-check-with-help">
              <label className="rules-setup-check" htmlFor={id('bounce-back')}>
                <input
                  id={id('bounce-back')}
                  type="checkbox"
                  checked={value.bonusesBounceBack}
                  onChange={(event) => set({ bonusesBounceBack: event.target.checked })}
                />
                Missed parts bounce back
              </label>
              <HelpTooltip label="What does bonus bounceback mean?">
                When the team controlling a bonus misses a part, the other team gets a chance to answer that
                part.
              </HelpTooltip>
            </div>
          </div>
        )}
      </fieldset>

      <fieldset className="field-group">
        <legend className="field-group-legend">The round</legend>
        <div className="rules-setup-grid">
          <label htmlFor={id('tossup-count')}>
            Tossups in regulation
            <input
              id={id('tossup-count')}
              type="number"
              min={1}
              step={1}
              value={value.tossupCount === undefined ? '' : String(value.tossupCount)}
              onChange={(event) => set({ tossupCount: numberValue(event.target.value) })}
            />
          </label>
          <div>
            <div className="label-with-help">
              <label htmlFor={id('max-tossup-count')}>Most tossups possible</label>
              <HelpTooltip label="Explain the extended-regulation limit">
                A hard cap for formats where regulation may extend beyond its usual count. Leave it blank if
                regulation can never run long.
              </HelpTooltip>
            </div>
            <input
              id={id('max-tossup-count')}
              type="number"
              min={1}
              step={1}
              value={value.maximumTossupCount === undefined ? '' : String(value.maximumTossupCount)}
              onChange={(event) => set({ maximumTossupCount: numberValue(event.target.value) })}
            />
          </div>
          <label htmlFor={id('max-active')}>
            Players playing at once
            <input
              id={id('max-active')}
              type="number"
              min={1}
              step={1}
              value={value.maximumPlayersPerTeam === undefined ? '' : String(value.maximumPlayersPerTeam)}
              onChange={(event) => set({ maximumPlayersPerTeam: numberValue(event.target.value) })}
            />
          </label>
        </div>
        <p className="shell-hint rules-fields-hint">
          Blank “Most tossups possible” means regulation cannot run long.
        </p>
        <div className="rules-check-with-help">
          <label className="rules-setup-check" htmlFor={id('timed')}>
            <input
              id={id('timed')}
              type="checkbox"
              checked={value.timed === true}
              onChange={(event) => set({ timed: event.target.checked })}
            />
            Round is timed
          </label>
          <HelpTooltip label="About timed rounds">
            In a timed round, regulation ends when the moderator calls time; the tossup count is still used as
            a maximum.
          </HelpTooltip>
        </div>
        {timedHint && <p className="shell-hint rules-fields-hint">{timedHint}</p>}
      </fieldset>

      <fieldset className="field-group" aria-labelledby={id('advanced-heading')}>
        <legend id={id('advanced-heading')} className="field-group-legend">
          Overtime and lightning
        </legend>
        <div className="rules-setup-grid">
          <div>
            <div className="label-with-help">
              <label htmlFor={id('overtime-count')}>Initial overtime tossups</label>
              <HelpTooltip label="Explain the overtime length">
                The number of tossups guaranteed when regulation ends tied. If the game remains tied, QBSheet
                continues with sudden-death tossups.
              </HelpTooltip>
            </div>
            <input
              id={id('overtime-count')}
              type="number"
              min={1}
              step={1}
              value={value.overtimeQuestionCount === undefined ? '' : String(value.overtimeQuestionCount)}
              onChange={(event) => set({ overtimeQuestionCount: numberValue(event.target.value) })}
            />
          </div>
        </div>
        <p className="shell-hint rules-fields-hint">One tossup means overtime is sudden death.</p>

        {value.useBonuses && (
          <label className="rules-setup-check" htmlFor={id('overtime-bonuses')}>
            <input
              id={id('overtime-bonuses')}
              type="checkbox"
              checked={value.overtimeIncludesBonuses === true}
              onChange={(event) => set({ overtimeIncludesBonuses: event.target.checked })}
            />
            Bonuses in overtime
          </label>
        )}

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
                min={1}
                step={1}
                value={value.lightningCountPerTeam === undefined ? '' : String(value.lightningCountPerTeam)}
                onChange={(event) => set({ lightningCountPerTeam: numberValue(event.target.value) })}
              />
            </label>
            <label htmlFor={id('lightning-divisor')}>
              Lightning score increment
              <input
                id={id('lightning-divisor')}
                type="number"
                min={1}
                step={1}
                value={value.lightningDivisor === undefined ? '' : String(value.lightningDivisor)}
                onChange={(event) => set({ lightningDivisor: numberValue(event.target.value) })}
              />
            </label>
          </div>
        )}
      </fieldset>
    </div>
  );
}
