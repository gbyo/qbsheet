/**
 * The bonus, asked for the way the format actually defines one.
 *
 * A regular bonus gets buttons, because a regular bonus has a small known set of totals and pressing
 * one of them is faster than typing. An irregular one gets a number field, because its parts need
 * not be worth the same and there is no set to enumerate — offering buttons there would be inventing
 * a structure the tournament did not define.
 *
 * Bouncebacks appear only when the format bounces bonuses back, and only offer what is left on the
 * bonus after the controlling team has taken its share.
 *
 * # Why parts are an aside and not the default
 *
 * Because 0 / 10 / 20 / 30 is one click and three parts is three, and the bonus is the half of the
 * cycle where a scorekeeper is already behind. But `ScoreEvents` carries part-level results, QBJ
 * reads them, and there are real occasions when which part was got is the thing in question: a
 * protested bonus, a spoiled part read from the wrong packet, a room being asked afterwards what
 * happened. So parts are one press away and never in the way.
 */
import { useState } from 'react';
import { IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import { IBonusPartResult } from '../scoring/ScoreEvents';
import { bonusTotalProblem, bouncebackOptions, regularBonusTotals } from './bonusOptions';

export interface IBonusPromptProps {
  format: IScorekeeperFormat;
  /** The team that converted the tossup. */
  controllingTeamName: string;
  opponentName: string;
  questionNumber: number;
  onRecord: (controlledPoints: number, bouncebackPoints?: number) => void;
  /** Record the bonus part by part instead of as a total. */
  onRecordParts: (parts: IBonusPartResult[]) => void;
}

/**
 * How many parts this bonus has.
 *
 * Only meaningful for a regular bonus, where every part is worth the same and the count follows from
 * the maximum. An irregular one has no fixed count, which is why part entry is not offered for it.
 */
function regularPartCount(format: IScorekeeperFormat): number | null {
  const { pointsPerPart, maximumScore, regular, minimumParts, maximumParts } = format.bonus;
  if (!regular || !pointsPerPart || pointsPerPart <= 0) return null;
  const count = Math.round(maximumScore / pointsPerPart);
  if (count < 1) return null;
  // Trust the rules' own bounds over the division when they disagree.
  return Math.min(Math.max(count, minimumParts), Math.max(maximumParts, minimumParts));
}

/** Part-by-part entry: got it / missed it, and who got it when bonuses bounce. */
function PartEntry(props: {
  format: IScorekeeperFormat;
  partCount: number;
  onRecord: (parts: IBonusPartResult[]) => void;
  onCancel: () => void;
}) {
  const { format, partCount, onRecord, onCancel } = props;
  const perPart = format.bonus.pointsPerPart ?? 0;
  const bouncesBack = format.bonus.bounceBack;
  /** Per part: who took it, if anybody. */
  const [outcomes, setOutcomes] = useState<Array<'controlled' | 'bounceback' | 'missed'>>(
    Array.from({ length: partCount }, () => 'missed' as const),
  );

  const set = (index: number, value: 'controlled' | 'bounceback' | 'missed') =>
    setOutcomes((current) => current.map((existing, position) => (position === index ? value : existing)));

  const parts: IBonusPartResult[] = outcomes.map((outcome) => ({
    controlledPoints: outcome === 'controlled' ? perPart : 0,
    ...(outcome === 'bounceback' ? { bouncebackPoints: perPart } : {}),
  }));
  const controlledTotal = parts.reduce((sum, part) => sum + part.controlledPoints, 0);
  const bouncebackTotal = parts.reduce((sum, part) => sum + (part.bouncebackPoints ?? 0), 0);

  return (
    <div className="scorer-bonus-parts">
      <ol className="scorer-part-list">
        {outcomes.map((outcome, index) => (
          // Position is the identity of a bonus part; there is nothing else to key on.
          // eslint-disable-next-line react/no-array-index-key
          <li key={index} className="scorer-part-row">
            <span className="scorer-part-label">Part {index + 1}</span>
            <span className="scorer-choices">
              <button
                type="button"
                aria-pressed={outcome === 'controlled'}
                className={outcome === 'controlled' ? 'scorer-choice is-selected' : 'scorer-choice'}
                onClick={() => set(index, 'controlled')}
              >
                +{perPart}
              </button>
              {bouncesBack && (
                <button
                  type="button"
                  aria-pressed={outcome === 'bounceback'}
                  className={outcome === 'bounceback' ? 'scorer-choice is-selected' : 'scorer-choice'}
                  onClick={() => set(index, 'bounceback')}
                >
                  Bounce
                </button>
              )}
              <button
                type="button"
                aria-pressed={outcome === 'missed'}
                className={outcome === 'missed' ? 'scorer-choice is-selected' : 'scorer-choice'}
                onClick={() => set(index, 'missed')}
              >
                Miss
              </button>
            </span>
          </li>
        ))}
      </ol>
      <p className="scorer-part-total">
        {controlledTotal}
        {bouncesBack && bouncebackTotal > 0 && <> · {bouncebackTotal} bounced back</>}
      </p>
      <div className="scorer-choices">
        <button type="button" className="scorer-choice" onClick={() => onRecord(parts)}>
          Record parts
        </button>
        <button type="button" className="scorer-action" onClick={onCancel}>
          Back to totals
        </button>
      </div>
    </div>
  );
}

export default function BonusPrompt(props: IBonusPromptProps) {
  const { format, controllingTeamName, opponentName, questionNumber, onRecord, onRecordParts } = props;
  const totals = regularBonusTotals(format.bonus);
  const partCount = regularPartCount(format);
  const [controlled, setControlled] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  const [byParts, setByParts] = useState(false);

  const bouncesBack = format.bonus.bounceBack;

  /** With no bouncebacks to ask about, choosing the total is the whole interaction. */
  const finish = (controlledPoints: number) => {
    if (!bouncesBack) {
      onRecord(controlledPoints);
      return;
    }
    setControlled(controlledPoints);
  };

  const typedProblem = typed === '' ? null : bonusTotalProblem(format.bonus, Number(typed));

  if (controlled !== null && bouncesBack) {
    return (
      <section className="scorer-prompt" aria-label="Bounceback">
        <p className="scorer-prompt-title">
          <span className="scorer-prompt-team">{opponentName}</span> bounceback
          <span className="scorer-prompt-context">
            Q{questionNumber} · {controllingTeamName} took {controlled}
          </span>
        </p>
        <div className="scorer-choices">
          {bouncebackOptions(format.bonus, controlled).map((points) => (
            <button key={points} type="button" className="scorer-choice" onClick={() => onRecord(controlled, points)}>
              {points}
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="scorer-prompt" aria-label="Bonus">
      <p className="scorer-prompt-title">
        <span className="scorer-prompt-team">{controllingTeamName}</span> bonus
        <span className="scorer-prompt-context">Q{questionNumber}</span>
      </p>

      {byParts && partCount !== null ? (
        <PartEntry format={format} partCount={partCount} onRecord={onRecordParts} onCancel={() => setByParts(false)} />
      ) : (
        <>
          {totals ? (
            <div className="scorer-choices">
              {totals.map((points) => (
                <button key={points} type="button" className="scorer-choice" onClick={() => finish(points)}>
                  {points}
                </button>
              ))}
            </div>
          ) : (
            <form
              className="scorer-inline-form"
              onSubmit={(submitEvent) => {
                submitEvent.preventDefault();
                if (typed === '' || typedProblem) return;
                finish(Number(typed));
              }}
            >
              <label htmlFor="scorer-bonus-points">
                Bonus points
                <input
                  id="scorer-bonus-points"
                  type="number"
                  inputMode="numeric"
                  step={format.bonus.divisor || 1}
                  min={0}
                  max={format.bonus.maximumScore}
                  value={typed}
                  onChange={(changeEvent) => setTyped(changeEvent.target.value)}
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                />
              </label>
              <button type="submit" className="scorer-choice" disabled={typed === '' || typedProblem !== null}>
                Record
              </button>
              {typedProblem && <p className="scorer-problem">{typedProblem}</p>}
            </form>
          )}
          {partCount !== null && (
            <button type="button" className="scorer-text-action" onClick={() => setByParts(true)}>
              Parts&hellip;
            </button>
          )}
        </>
      )}
    </section>
  );
}
