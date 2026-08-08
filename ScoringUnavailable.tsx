/**
 * What the room shows when a game exists but its selected scorekeeper cannot be opened.
 *
 * This should be a useful operational state, not an implementation note. A scorekeeper needs to
 * know whether to ask tournament control to repair the room setup or move to paper, not that a
 * particular UI migration is in progress.
 */

export interface IScoringUnavailableProps {
  /**
   * Round and room, so a director reading over a shoulder knows which game is stuck. The round
   * arrives already named ("Round 4", "Finals") and is shown as it stands.
   */
  // eslint-disable-next-line react/require-default-props
  roundName?: string;
  // eslint-disable-next-line react/require-default-props
  roomName?: string;
}

export default function ScoringUnavailable(props: IScoringUnavailableProps) {
  const { roundName, roomName } = props;
  const context = [roundName, roomName].filter(Boolean).join(' · ');

  return (
    <div className="room-shell">
      <div className="room-empty">
        <p className="room-empty-title">Room scorekeeping is unavailable</p>
        {context !== '' && <p className="room-muted">{context}</p>}
        <p className="room-muted">
          YellowFruit could not load usable scorekeeping rules for this game. Ask tournament control to check the room
          setup before trying to start it again.
        </p>
        <p className="room-muted">
          If the game must begin now, use a paper scoresheet and give it to tournament control.
        </p>
      </div>
    </div>
  );
}
