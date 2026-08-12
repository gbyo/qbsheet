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
 * the shape of overtime, lightning — under a quiet advanced heading rather than in the main grid,
 * because a practice game almost never changes them.
 *
 * No rule set is named anywhere. A format is what its numbers say, and a scorer that recognized
 * "NAQT" would mis-score the first tournament that edited its powers.
 */
import { IBasicScoringRulesInput } from '../qbj/BasicScoringRules';

/** A number field that tolerates being empty while it is being typed in. */
export function numberValue(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export type BasicScoringRulesVariant =
  /** What a QBJ with no rules in it is asked: values, counts, bonuses, whether there is a clock. */
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
      <div className="rules-setup-grid">
        <label htmlFor={id('tossup')}>
          Correct tossup
          <input
            id={id('tossup')}
            type="number"
            value={String(value.tossupValue)}
            onChange={(event) => set({ tossupValue: numberValue(event.target.value) ?? 0 })}
          />
        </label>
        <label htmlFor={id('power')}>
          Power (blank for none)
          <input
            id={id('power')}
            type="number"
            value={value.powerValue === undefined ? '' : String(value.powerValue)}
            onChange={(event) => set({ powerValue: numberValue(event.target.value) })}
          />
        </label>
        <label htmlFor={id('neg')}>
          Neg (blank for none)
          <input
            id={id('neg')}
            type="number"
            value={value.negValue === undefined ? '' : String(value.negValue)}
            onChange={(event) => set({ negValue: numberValue(event.target.value) })}
          />
        </label>
        <label htmlFor={id('tossup-count')}>
          Tossups in regulation
          <input
            id={id('tossup-count')}
            type="number"
            value={String(value.tossupCount)}
            onChange={(event) => set({ tossupCount: numberValue(event.target.value) ?? 0 })}
          />
        </label>
        {variant === 'full' && (
          <label htmlFor={id('max-active')}>
            Players playing at once
            <input
              id={id('max-active')}
              type="number"
              value={value.maximumPlayersPerTeam === undefined ? '' : String(value.maximumPlayersPerTeam)}
              onChange={(event) => set({ maximumPlayersPerTeam: numberValue(event.target.value) ?? 0 })}
            />
          </label>
        )}
      </div>

      <label className="rules-setup-check" htmlFor={id('bonuses')}>
        <input
          id={id('bonuses')}
          type="checkbox"
          checked={value.useBonuses}
          onChange={(event) => set({ useBonuses: event.target.checked })}
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
          {variant === 'full' && (
            <label className="rules-setup-check" htmlFor={id('bounce-back')}>
              <input
                id={id('bounce-back')}
                type="checkbox"
                checked={value.bonusesBounceBack === true}
                onChange={(event) => set({ bonusesBounceBack: event.target.checked })}
              />
              Missed parts bounce back
            </label>
          )}
        </>
      )}

      <label className="rules-setup-check" htmlFor={id('timed')}>
        <input
          id={id('timed')}
          type="checkbox"
          checked={value.timed === true}
          onChange={(event) => set({ timed: event.target.checked })}
        />
        {variant === 'full' ? 'Round is timed' : 'Rounds run on a clock'}
      </label>
      {timedHint && <p className="shell-hint rules-fields-hint">{timedHint}</p>}

      {variant === 'full' && (
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
      )}
    </div>
  );
}
