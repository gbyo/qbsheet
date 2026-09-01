/**
 * The two teams as the room is actually sitting.
 *
 * # It is a view, not a second scorer
 *
 * Everything here is handed down already display-mapped: the teams, who is in which seat, whether a
 * side may still answer, whether a neg is still legal. Nothing is recomputed, and the two callbacks
 * are the same wrappers `TeamPanel` is given — so a ruling recorded from a rectangle on the table is
 * the same event, in the same journal, with the same undo frame, as one recorded from a button on a
 * row. There is no "visual scoring" anywhere in the history.
 *
 * # Why a rectangle rather than a row of buttons
 *
 * The scoresheet's answer is one press: the ruling buttons live on the player's own line, so "Sarah,
 * ten points" is a single target. That works because the eye finds a *name* quickly in a short
 * ordered list. A scorekeeper watching a table finds a *position* quickly instead — third from the
 * left, second table — and the fastest thing they can do is point at it. So the first press here is
 * the person, and the ruling opens against them; see `RulingPicker` for why it opens beside the tile
 * and never in the middle of the screen.
 *
 * # The seat is the object
 *
 * A tile is a chair, not a person. The `<li>` is keyed by seat, so a substitution changes who is
 * sitting in it and moves nothing: the rectangle, its number and its place on the table are all
 * exactly where they were. What travels is a reordering — the room telling the software it had the
 * table wrong — and that is the one thing that should look like movement.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { LeftOrRight } from '../scoring/types';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IDerivedTeam } from '../scoring/deriveGame';
import { useLineupMotion } from './LineupMotion';
import { seatChangeEmphasisMs } from './TeamPanel';
import RulingPicker from './RulingPicker';
import tossupChoices, { TossupChoice } from './tossupChoices';

/** How long a tile keeps the wash that says a ruling landed on it. The scoresheet's own duration. */
const rulingEmphasisMs = 220;

const displaySides: readonly LeftOrRight[] = ['left', 'right'];

export interface ITableViewProps {
  format: IScorekeeperFormat;
  /** Already display-mapped. Left here is the team on the left of the screen. */
  teams: Record<LeftOrRight, IDerivedTeam>;
  /** Who is in each seat, in the room's own order. The same derivation the keyboard addresses. */
  seatedPlayers: Record<LeftOrRight, readonly string[]>;
  /** False while the other team is on a bonus, during a timeout, or once the game is over. */
  scoringEnabled: boolean;
  eligible: (side: LeftOrRight) => boolean;
  negsAvailable: (side: LeftOrRight) => boolean;
  /** A seat a keystroke just scored into, flashed briefly. Zero-based, as `TeamPanel` has it. */
  flashSeat?: { side: LeftOrRight; seat: number } | null;
  /** Returns true only when the scoring engine committed the ruling. */
  onBuzz: (side: LeftOrRight, playerName: string, answerType: IScorekeeperAnswerType) => boolean;
  onWrongNoPenalty: (side: LeftOrRight, playerName: string) => boolean;
  /** Identity of the current display orientation. A change closes anything anchored to a tile. */
  sideLayoutKey: string;
  /** True while one of the scorer's own dialogs is open, which owns the screen. */
  dialogOpen?: boolean;
  timeouts?: Record<LeftOrRight, number>;
  timeoutsPerTeam?: number;
  /**
   * Move one player one seat along the table.
   *
   * The same `seating.move` the Players dialog calls: there is one physical seat order, and this is a
   * second way into it rather than a second copy of it. Absent means the table cannot be rearranged
   * from here and no arrangement controls are drawn.
   */
  onMoveSeat?: (
    side: LeftOrRight,
    visibleNames: readonly string[],
    playerName: string,
    direction: -1 | 1,
  ) => void;
  /**
   * Nobody has told this device what order the room is sitting in.
   *
   * True only when no seating preference exists for this game, which is the case the starting-lineup
   * prompt never covers: a roster of exactly the maximum starts everybody automatically, so nothing
   * ever asked. It is a hint and not a gate; scoring works with it on screen.
   */
  arrangementUnconfirmed?: boolean;
  /** The room says the roster order is the table order. Writes the preference, not an event. */
  onConfirmArrangement?: () => void;
  /**
   * The hint has been answered, one way or the other.
   *
   * Reported upward rather than only remembered here, because this component is unmounted every time
   * the scorekeeper looks at the scoresheet, and a question that comes back after it has been
   * answered is a question that was not really asked.
   */
  onDismissArrangementHint?: () => void;
  /** Set when a lineup change filled seats this device had to choose for itself. */
  lineupOrderCheck?: { token: number } | null;
  onDismissOrderCheck?: () => void;
}

interface ISelection {
  side: LeftOrRight;
  playerName: string;
  /**
   * The chair that was pressed.
   *
   * Kept as the element rather than looked up when it is wanted, because both things that want it —
   * where to put the picker, and where to send focus when it closes — happen outside a render and
   * are about the chair the scorekeeper actually touched.
   */
  tile: HTMLButtonElement;
}

export default function TableView(props: ITableViewProps) {
  const {
    format,
    teams,
    seatedPlayers,
    scoringEnabled,
    eligible,
    negsAvailable,
    flashSeat,
    onBuzz,
    onWrongNoPenalty,
    sideLayoutKey,
    dialogOpen = false,
    timeouts,
    timeoutsPerTeam,
    onMoveSeat,
    arrangementUnconfirmed = false,
    onConfirmArrangement,
    onDismissArrangementHint,
    lineupOrderCheck,
    onDismissOrderCheck,
  } = props;

  const [selected, setSelected] = useState<ISelection | null>(null);
  const [arranging, setArranging] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(false);
  /** Answered here and reported upward, so it stays answered across a look at the scoresheet. */
  const dismissHint = () => {
    setHintDismissed(true);
    onDismissArrangementHint?.();
  };
  const pickerId = useId();

  const close = useCallback(
    (returnFocus: boolean) => {
      setSelected(null);
      // Escape sends the scorekeeper back to the chair they opened, which is where they were
      // looking. An outside press does not: they are already somewhere else.
      if (selected && returnFocus) selected.tile.focus();
    },
    [selected],
  );

  /**
   * The tile the engine actually accepted a ruling for.
   *
   * Held for the whole view rather than per team, because the acknowledgement has to survive the
   * picker closing and because both teams share one sequence: two rulings in a row are two tokens,
   * so the second does not inherit what is left of the first one's timer.
   */
  const [recorded, setRecorded] = useState<{
    side: LeftOrRight;
    playerName: string;
    isNeg: boolean;
    token: number;
  } | null>(null);
  const recordedSequence = useRef(0);
  useEffect(() => {
    if (recorded === null) return undefined;
    const timer = window.setTimeout(() => setRecorded(null), rulingEmphasisMs);
    return () => window.clearTimeout(timer);
  }, [recorded]);

  /*
   * Everything that makes an open picker wrong, in one place.
   *
   * A picker is anchored to one chair and describes one tossup. Anything that changes which chair is
   * where, or whether that tossup can still be ruled on, has to take it off the screen — otherwise
   * the next press lands on a ruling for a state that has already gone.
   *
   * Closed as the render that would have drawn it happens rather than afterwards in an effect, so it
   * is never painted pointing at something that has stopped being true. `TeamPanel` makes the same
   * adjustment for its own substitution picker.
   */
  const [layoutKey, setLayoutKey] = useState(sideLayoutKey);
  if (layoutKey !== sideLayoutKey) {
    // The two teams have changed places on screen, so every chair is somewhere else.
    setLayoutKey(sideLayoutKey);
    setSelected(null);
  } else if (
    selected !== null &&
    // No tossup to rule on, a dialog that owns the screen, or the table being rearranged.
    (!scoringEnabled ||
      dialogOpen ||
      arranging ||
      // The player left the floor, by substitution or by a change made in the Players dialog.
      !seatedPlayers[selected.side].includes(selected.playerName) ||
      // This team has already answered, so there is no second ruling for it to be given.
      !eligible(selected.side))
  ) {
    setSelected(null);
  }

  const choices = selected === null ? [] : tossupChoices(format, negsAvailable(selected.side));

  const choose = (choice: TossupChoice) => {
    if (selected === null) return;
    const { side, playerName } = selected;
    // Synchronously, and before anything is recorded: one press is one decision, and a picker left
    // open over an action the engine refused is how the same press happens twice.
    setSelected(null);
    const accepted =
      choice.kind === 'answer'
        ? onBuzz(side, playerName, choice.answerType)
        : onWrongNoPenalty(side, playerName);
    if (accepted) {
      setRecorded({
        side,
        playerName,
        isNeg: choice.kind === 'answer' && choice.answerType.isNeg,
        token: recordedSequence.current + 1,
      });
      recordedSequence.current += 1;
    }
  };

  const showHint = arrangementUnconfirmed && !hintDismissed && !arranging && onMoveSeat !== undefined;

  return (
    <div className="scorer-table-view">
      <div className="scorer-table-tools">
        {onMoveSeat && (
          <button
            type="button"
            className="scorer-text-action"
            onClick={() => {
              setArranging((current) => !current);
              dismissHint();
              onDismissOrderCheck?.();
            }}
          >
            {arranging ? 'Done arranging' : 'Arrange table'}
          </button>
        )}
      </div>

      {showHint && (
        <div className="scorer-table-hint" role="note">
          <p className="scorer-table-hint-title">Match the table</p>
          <p className="scorer-table-hint-body">
            Players are currently shown in roster order. Arrange them if they&rsquo;re sitting differently.
          </p>
          <div className="scorer-table-hint-actions">
            <button
              type="button"
              className="scorer-choice"
              onClick={() => {
                dismissHint();
                setArranging(true);
              }}
            >
              Arrange
            </button>
            <button
              type="button"
              className="scorer-text-action"
              onClick={() => {
                dismissHint();
                onConfirmArrangement?.();
              }}
            >
              This is right
            </button>
          </div>
        </div>
      )}

      {lineupOrderCheck && !arranging && (
        <div className="scorer-table-notice" role="status">
          <span>Lineup changed · Check table order</span>
          {onMoveSeat && (
            <button
              type="button"
              className="scorer-text-action"
              onClick={() => {
                setArranging(true);
                onDismissOrderCheck?.();
              }}
            >
              Arrange
            </button>
          )}
          <button type="button" className="scorer-text-action" onClick={() => onDismissOrderCheck?.()}>
            Dismiss
          </button>
        </div>
      )}

      <div className="scorer-table-teams">
        {displaySides.map((side) => (
          <TableTeam
            key={side}
            side={side}
            team={teams[side]}
            seats={seatedPlayers[side]}
            scoringEnabled={scoringEnabled}
            eligible={eligible(side)}
            arranging={arranging}
            flashSeat={flashSeat?.side === side ? flashSeat.seat : undefined}
            recorded={recorded?.side === side ? recorded : null}
            selectedPlayer={selected?.side === side ? selected.playerName : null}
            pickerId={pickerId}
            timeoutsUsed={timeouts?.[side]}
            timeoutsPerTeam={timeoutsPerTeam}
            onMoveSeat={onMoveSeat}
            onSelect={(playerName, tile) =>
              setSelected((current) =>
                current && current.side === side && current.playerName === playerName
                  ? null
                  : { side, playerName, tile },
              )
            }
          />
        ))}
      </div>

      {selected !== null && choices.length > 0 && (
        <RulingPicker
          id={pickerId}
          playerName={selected.playerName}
          teamName={teams[selected.side].name}
          choices={choices}
          anchor={selected.tile}
          onChoose={choose}
          onDismiss={close}
        />
      )}
    </div>
  );
}

interface ITableTeamProps {
  side: LeftOrRight;
  team: IDerivedTeam;
  seats: readonly string[];
  scoringEnabled: boolean;
  eligible: boolean;
  arranging: boolean;
  flashSeat?: number;
  recorded: { playerName: string; isNeg: boolean; token: number } | null;
  selectedPlayer: string | null;
  pickerId: string;
  timeoutsUsed?: number;
  timeoutsPerTeam?: number;
  onMoveSeat?: (
    side: LeftOrRight,
    visibleNames: readonly string[],
    playerName: string,
    direction: -1 | 1,
  ) => void;
  onSelect: (playerName: string, tile: HTMLButtonElement) => void;
}

/**
 * One team's table: the head a scoresheet would give it, and a chair per player on the floor.
 *
 * Only players actually on the floor get a chair. There are no empty seats waiting to be filled, for
 * the reason the roster has never drawn them: a rectangle with nobody in it is an invitation to
 * record a buzz against nobody, and a format's maximum is not a promise about who turned up.
 */
function TableTeam(props: ITableTeamProps) {
  const {
    side,
    team,
    seats,
    scoringEnabled,
    eligible,
    arranging,
    flashSeat,
    recorded,
    selectedPlayer,
    pickerId,
    timeoutsUsed,
    timeoutsPerTeam,
    onMoveSeat,
    onSelect,
  } = props;

  // The same FLIP the lineup editor uses, along the table's own axis. See `LineupMotion`.
  const motion = useLineupMotion({ axis: 'x' });

  /**
   * The seats a lineup change put somebody new into.
   *
   * A seat and not a player, because the seat is what is being asserted: "Phillip → Adam" is a change
   * of person and explicitly not a change of position. Held as a fresh object so two substitutions
   * into the same seat are two events rather than one with a stale timer.
   */
  const [landed, setLanded] = useState<{ seats: number[]; token: number } | null>(null);
  const landedSequence = useRef(0);
  const previousSeats = useRef<readonly string[] | null>(null);
  useLayoutEffect(() => {
    const previous = previousSeats.current;
    previousSeats.current = seats;
    if (previous === null) return;
    const before = new Set(previous);
    // A reordering has the same people in it and is told by the tiles travelling, not by a wash.
    const arrived = seats
      .map((name, seat) => (before.has(name) ? -1 : seat))
      .filter((seat) => seat >= 0 && previous[seat] !== undefined);
    if (arrived.length === 0) return;
    landedSequence.current += 1;
    setLanded({ seats: arrived, token: landedSequence.current });
  }, [seats]);
  useEffect(() => {
    if (landed === null) return undefined;
    const timer = window.setTimeout(() => setLanded(null), seatChangeEmphasisMs);
    return () => window.clearTimeout(timer);
  }, [landed]);

  /*
   * Which way the score last moved, recorded when it moves. The same derivation `TeamPanel` uses,
   * and deliberately the same motion: one scoreboard should not roll two different ways depending on
   * which view is drawing it.
   */
  const [scoreMotion, setScoreMotion] = useState({
    points: team.points,
    direction: 'is-up',
    started: false,
  });
  if (scoreMotion.points !== team.points) {
    setScoreMotion({
      points: team.points,
      direction: team.points < scoreMotion.points ? 'is-down' : 'is-up',
      started: true,
    });
  }

  const disabledReason = !scoringEnabled
    ? 'No tossup is live.'
    : `${team.name} has already answered this tossup.`;

  return (
    <section className="scorer-table-team" aria-label={team.name}>
      <header className="scorer-table-team-head">
        <h2 className="scorer-team-name" title={team.name}>
          {team.name}
        </h2>
        <p className="scorer-team-score" aria-label={`${team.name} score`}>
          <span
            key={team.points}
            className={`scorer-team-score-value${scoreMotion.started ? ` ${scoreMotion.direction}` : ''}`}
          >
            {team.points}
          </span>
        </p>
      </header>
      {timeoutsUsed !== undefined && timeoutsPerTeam !== undefined && timeoutsPerTeam > 0 && (
        <p className="scorer-team-timeout">
          {Math.max(0, timeoutsPerTeam - timeoutsUsed)} remaining
          {timeoutsUsed > 0 && ` (${timeoutsUsed} used)`}
        </p>
      )}

      {/* The table itself: a quiet rectangle whose only job is to say these chairs are one table. */}
      <div className="scorer-table-surface">
        <ul className="scorer-table-seats" aria-label={`${team.name} table`}>
          {seats.map((playerName, seat) => (
            <li
              key={seat}
              ref={motion.rowRef(playerName)}
              className={motion.rowClassName(playerName, 'scorer-table-seat')}
              data-seat-token={landed?.seats.includes(seat) ? landed.token : undefined}
            >
              {arranging ? (
                <div
                  className={[
                    'scorer-table-player',
                    'is-arranging',
                    landed?.seats.includes(seat) ? 'is-substituted' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span className="scorer-table-player-seat" aria-hidden="true">
                    {seat + 1}
                  </span>
                  <span className="scorer-table-player-name" title={playerName}>
                    {playerName}
                  </span>
                  <span className="scorer-table-arrange-actions">
                    <button
                      type="button"
                      className="scorer-text-action"
                      aria-label={`Move ${playerName} left`}
                      disabled={seat === 0}
                      onClick={() => {
                        // Measured immediately before the seating state changes; the change itself is
                        // not delayed. See `LineupMotion`.
                        motion.beginMove(playerName);
                        onMoveSeat?.(side, seats, playerName, -1);
                      }}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      className="scorer-text-action"
                      aria-label={`Move ${playerName} right`}
                      disabled={seat === seats.length - 1}
                      onClick={() => {
                        motion.beginMove(playerName);
                        onMoveSeat?.(side, seats, playerName, 1);
                      }}
                    >
                      →
                    </button>
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  className={[
                    'scorer-table-player',
                    selectedPlayer === playerName ? 'is-selected' : '',
                    !scoringEnabled || !eligible ? 'is-disabled' : '',
                    recorded?.playerName === playerName ? 'is-recorded' : '',
                    recorded?.playerName === playerName && recorded.isNeg ? 'is-neg-recorded' : '',
                    landed?.seats.includes(seat) ? 'is-substituted' : '',
                    seat === flashSeat ? 'is-keyed' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-ruling-token={recorded?.playerName === playerName ? recorded.token : undefined}
                  disabled={!scoringEnabled || !eligible}
                  title={!scoringEnabled || !eligible ? disabledReason : undefined}
                  aria-haspopup="dialog"
                  aria-expanded={selectedPlayer === playerName}
                  aria-controls={selectedPlayer === playerName ? pickerId : undefined}
                  onClick={(event) => onSelect(playerName, event.currentTarget)}
                >
                  {/* The seat, not an identity. Hidden from assistive technology, which reads the name. */}
                  <span className="scorer-table-player-seat" aria-hidden="true">
                    {seat + 1}
                  </span>
                  {/* Keyed by the name, so a substitution replaces the element rather than editing its
                      text — which is what lets the arriving name have an entrance while the chair
                      around it has none. */}
                  <span key={playerName} className="scorer-table-player-name" title={playerName}>
                    {playerName}
                  </span>
                </button>
              )}
            </li>
          ))}
          {seats.length === 0 && (
            <li className="scorer-table-empty">Nobody is on the floor for this team.</li>
          )}
        </ul>
      </div>
      {recorded && (
        <span className="visually-hidden" role="status">
          {recorded.playerName} ruling recorded.
        </span>
      )}
    </section>
  );
}
