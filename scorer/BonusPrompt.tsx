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
 */
import { useState } from 'react';
import { IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import { bonusTotalProblem, bouncebackOptions, regularBonusTotals } from './bonusOptions';

export interface IBonusPromptProps {
  format: IScorekeeperFormat;
  /** The team that converted the tossup. */
  controllingTeamName: string;
  opponentName: string;
  questionNumber: number;
  onRecord: (controlledPoints: number, bouncebackPoints?: number) => void;
}

export default function BonusPrompt(props: IBonusPromptProps) {
  const { format, controllingTeamName, opponentName, questionNumber, onRecord } = props;
  const totals = regularBonusTotals(format.bonus);
  const [controlled, setControlled] = useState<number | null>(null);
  const [typed, setTyped] = useState('');

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
    </section>
  );
}
