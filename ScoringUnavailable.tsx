/**
 * What the room shows where the scoresheet goes, before the first-party scorer exists.
 *
 * MODAQ has been taken out of the room UI, and its replacement is not built yet, so on this build
 * the default path has no scorer to render. This says so rather than showing a blank panel or a
 * spinner that will never resolve — a scorekeeper who cannot score needs to know immediately that
 * the problem is the software and not their Chromebook, because the alternative is a room quietly
 * losing a round while somebody tries reloading.
 *
 * Temporary by construction. It goes when the scorer lands.
 */

export interface IScoringUnavailableProps {
  /** Round and room, so a director reading over a shoulder knows which game is stuck. */
  // eslint-disable-next-line react/require-default-props
  roundName?: string;
  // eslint-disable-next-line react/require-default-props
  roomName?: string;
}

export default function ScoringUnavailable(props: IScoringUnavailableProps) {
  const { roundName, roomName } = props;
  const context = [roundName ? `Round ${roundName}` : null, roomName].filter(Boolean).join(' · ');

  return (
    <div className="room-shell">
      <div className="room-empty">
        <p className="room-empty-title">Scorekeeping is not available in this build</p>
        {context !== '' && <p className="room-muted">{context}</p>}
        <p className="room-muted">
          This copy of YellowFruit is part-way through replacing its browser scorekeeping interface. The new one is not
          finished, and the old one has been taken out of the way.
        </p>
        <p className="room-muted">Score this game on paper and give it to tournament control to enter.</p>
      </div>
    </div>
  );
}
