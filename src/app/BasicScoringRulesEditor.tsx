/**
 * The fields a scorekeeper states a scoring format in.
 *
 * # One set of number fields, two reasons to be looking at them
 *
 * A QBJ that carried no `ScoringRules` asks for these; so does somebody creating a practice game
 * from nothing. The two screens have different things to say about *why* they are asking — one is
 * about a document that came up short, the other is about a game that was never on anybody's
 * schedule — but the questions themselves are identical, and two copies of them is two places for a
 * bonus to acquire a different meaning.
 *
 * So the copy stays with the screens and the fields live here. This component holds no state and
 * makes no decisions: it renders `IBasicScoringRulesInput` and reports edits. Everything about what
 * the values mean is `BasicScoringRules`, which builds a standard `ScoringRules` object and reads it
 * back through the same mapper a file goes through.
 *
 * # Two variants, not two components
 *
 * `basic` is the compact four-question surface. `full` adds the controls a game being described
 * from scratch or a rule-less imported game needs — how many players are on the floor, bouncebacks,
 * the shape of overtime, lightning — because a practice game almost never changes them but has to be
 * able to.
 *
 * # Four groups, because a format has four parts
 *
 * The fields used to be one run of numbers and checkboxes with a rule drawn across it before the
 * overtime settings, and it read as a screen of boxes rather than as a format: "Points per bonus
 * part" sat under a checkbox that turned it on with nothing to say they belonged together, and
 * "Tossups in regulation" — a fact about the round's length — sat in the middle of what a tossup is
 * worth.
 *
 * So they are grouped by the question each one answers: what an answer scores, whether there are
 * bonuses and what they are worth, how long the round is, and what happens if it ends tied. Real
 * `<fieldset>`s with `<legend>`s, so the grouping is in the accessibility tree rather than only in
 * the styling — a screen reader announces the group when focus enters it, which is the same help the
 * captions give a sighted reader.
 *
 * The order is the order a format is usually stated in, and it puts the fields a practice game
 * actually edits first.
 *
 * No rule set is named anywhere. A format is what its numbers say, and a scorer that recognized
 * "NAQT" would mis-score the first tournament that edited its powers.
 */
import { IBasicScoringRulesInput } from '../qbj/BasicScoringRules';
import HelpTooltip from './HelpTooltip';

/** A number field that tolerates being empty while it is being typed in. */
export function numberValue(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export type BasicScoringRulesVariant =
  /** The four questions: values, counts, bonuses, whether there is a clock. */
  | 'basic'
  /** The same, plus the floor size, bouncebacks, overtime and lightning. */
  | 'full';

export default function BasicScoringRulesEditor(props: {
  value: IBasicScoringRulesInput;
  onChange: (value: IBasicScoringRulesInput) => void;
  /**
   * Prefix for every input id on this instance.
   *
   * Required rather than defaulted: an id collision between two of these on one page would attach a
   * label to the wrong box, which is invisible on screen and complete nonsense to a screen reader.
   */
  idPrefix: string;
  variant?: BasicScoringRulesVariant;
  /** What this screen can say about the clock, when it has something to say. */
  timedHint?: string;
}) {
  const { value, onChange, idPrefix, variant = 'basic', timedHint } = props;
  const set = (patch: Partial<IBasicScoringRulesInput>) => onChange({ ...value, ...patch });
  const id = (suffix: string) => `${idPrefix}-${suffix}`;

  return (
    <div className="rules-fields">
      <fieldset className="field-group">
        <legend className="field-group-legend">Tossup values</legend>
        <div className="rules-setup-grid">
          <label htmlFor={id('tossup')}>
            Correct tossup
            <input
              id={id('tossup')}
              type="number"
              min={1}
              step={1}
              value={value.tossupValue === undefined ? '' : String(value.tossupValue)}
              onChange={(event) => set({ tossupValue: numberValue(event.target.value) })}
            />
          </label>
          <div>
            <div className="label-with-help">
              <label htmlFor={id('power')}>Power (blank for none)</label>
              <HelpTooltip label="What is a power?">
                A power is a tossup answered before the power mark for extra points. Leave this blank if the format
                does not use powers.
              </HelpTooltip>
            </div>
            <input
              id={id('power')}
              type="number"
              step={1}
              inputMode="decimal"
              value={value.powerValue === undefined ? '' : String(value.powerValue)}
              onChange={(event) => set({ powerValue: numberValue(event.target.value) })}
            />
          </div>
          <div>
            <div className="label-with-help">
              <label htmlFor={id('neg')}>Neg (blank for none)</label>
              <HelpTooltip label="What is a neg?">
                A neg is the penalty for an incorrect buzz before the tossup ends. Enter the value as a negative
                number, or leave it blank when there is no penalty.
              </HelpTooltip>
            </div>
            <input
              id={id('neg')}
              type="number"
              step={1}
              inputMode="decimal"
              value={value.negValue === undefined ? '' : String(value.negValue)}
              onChange={(event) => set({ negValue: numberValue(event.target.value) })}
            />
          </div>
        </div>
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
                ...(event.target.checked ? {} : { bonusesBounceBack: false, overtimeIncludesBonuses: false }),
              })
            }
          />
          {variant === 'full' ? 'Use bonuses' : 'This tournament uses bonuses'}
        </label>

        {value.useBonuses && (
          <>
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
            {variant === 'full' && (
              <div className="rules-check-with-help">
                <label className="rules-setup-check" htmlFor={id('bounce-back')}>
                  <input
                    id={id('bounce-back')}
                    type="checkbox"
                    checked={value.bonusesBounceBack === true}
                    onChange={(event) => set({ bonusesBounceBack: event.target.checked })}
                  />
                  Missed parts bounce back
                </label>
                <HelpTooltip label="What does bonus bounceback mean?">
                  When the team controlling a bonus misses a part, the other team gets a chance to answer that part.
                </HelpTooltip>
              </div>
            )}
          </>
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
          {variant === 'full' && (
            <div>
              <div className="label-with-help">
                <label htmlFor={id('max-active')}>Players playing at once</label>
                <HelpTooltip label="Explain the player limit">
                  The maximum number of active players per team. Additional rostered players begin on the bench.
                </HelpTooltip>
              </div>
              <input
                id={id('max-active')}
                type="number"
                min={1}
                step={1}
                value={value.maximumPlayersPerTeam === undefined ? '' : String(value.maximumPlayersPerTeam)}
                onChange={(event) => set({ maximumPlayersPerTeam: numberValue(event.target.value) })}
              />
            </div>
          )}
        </div>

        <div className="rules-check-with-help">
          <label className="rules-setup-check" htmlFor={id('timed')}>
            <input
              id={id('timed')}
              type="checkbox"
              checked={value.timed === true}
              onChange={(event) => set({ timed: event.target.checked })}
            />
            {variant === 'full' ? 'Round is timed' : 'Rounds run on a clock'}
          </label>
          <HelpTooltip label="About timed rounds">
            In a timed round, regulation ends when the moderator calls time; the tossup count is still used as a
            maximum.
          </HelpTooltip>
        </div>
        {timedHint && <p className="shell-hint rules-fields-hint">{timedHint}</p>}
      </fieldset>

      {variant === 'full' && (
        <fieldset className="field-group">
          <legend className="field-group-legend">Overtime and lightning</legend>
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

          <div className="rules-check-with-help">
            <label className="rules-setup-check" htmlFor={id('lightning')}>
              <input
                id={id('lightning')}
                type="checkbox"
                checked={value.useLightning === true}
                onChange={(event) => set({ useLightning: event.target.checked })}
              />
              Use lightning
            </label>
            <HelpTooltip label="What is lightning?">
              A lightning round is a separate timed or worksheet-style scoring phase. Its points are added outside
              the tossup-and-bonus cycle.
            </HelpTooltip>
          </div>

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
      )}
    </div>
  );
}
