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
  if (motion.points !== team.points)
    setMotion({
      points: team.points,
      direction: team.points < motion.points ? 'is-down' : 'is-up',
      started: true,
    });
  return (
    <span
      className="score-reaction"
      data-power={reaction?.power || undefined}
      data-milestone={reaction?.milestone || undefined}
      data-tie={reaction?.tie || undefined}
    >
      <span
        key={reaction?.token ?? team.points}
        className={`scorer-team-score-value${motion.started ? ` ${motion.direction}` : ''}`}
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
