import { useState } from 'react';
import { IDerivedTeam } from '../../scoring/deriveGame';

export interface ScoreReaction {
  token: string;
  power: boolean;
  milestone: boolean;
  tie: boolean;
}
/** Shared by the table and scoresheet. Existing number motion remains the ordinary response. */
export default function ScoreValue({ team, reaction }: { team: IDerivedTeam; reaction?: ScoreReaction }) {
  const [motion, setMotion] = useState({ points: team.points, direction: 'is-up', started: false });
  const [decorated, setDecorated] = useState<number | null>(null);
  if (motion.points !== team.points)
    setMotion({
      points: team.points,
      direction: team.points < motion.points ? 'is-down' : 'is-up',
      started: true,
    });
  /*
   * A reaction is this score's celebration, and it replaces the ordinary roll rather than joining
   * it: `[data-power]` outranks `.is-up`, so while the decoration is up the roll is not what plays.
   * The decoration only lasts 650ms, and its `key` change re-keys the number on the way out — which
   * restarts `.is-up` and animates one commit a second time, after the fact and for no reason.
   *
   * So remember which score a decoration answered. Adjusted during render, guarded, in the same
   * shape as `motion` above: the value is a function of the props, and an effect would both trail
   * the commit it describes and cascade a render behind it.
   */
  if (reaction && decorated !== team.points) setDecorated(team.points);
  const ordinaryMotion = motion.started && !reaction && decorated !== team.points;
  return (
    <span
      className="score-reaction"
      data-power={reaction?.power || undefined}
      data-milestone={reaction?.milestone || undefined}
      data-tie={reaction?.tie || undefined}
    >
      <span
        key={reaction?.token ?? team.points}
        className={`scorer-team-score-value${ordinaryMotion ? ` ${motion.direction}` : ''}`}
      >
        {team.points}
      </span>
      {reaction?.power && (
        <svg
          key={`${reaction.token}-bolt`}
          className="score-lightning"
          viewBox="0 0 36 64"
          aria-hidden="true"
          focusable="false"
        >
          <path className="score-lightning-bolt" d="M24 2 7 30h12l-6 22 21-32H22l8-18Z" />
          <path className="score-lightning-sparks" d="m13 55-7 3m10-1-1 6m6-9 8 5" />
        </svg>
      )}
    </span>
  );
}
