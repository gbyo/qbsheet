import ScoreValue, { ScoreReaction } from './secrets/ScoreReaction';
/**
 * The two teams as the room is actually sitting.
 *
 * # It is a layout, not a second scorer
 *
 * Everything here is handed down already display-mapped: the teams, who is in which seat, whether a
 * side may still answer, whether a neg is still legal. Nothing is recomputed, and the two callbacks
 * are the same wrappers `TeamPanel` is given — so a ruling recorded from a rectangle on the table is
 * the same event, in the same journal, with the same undo frame, as one recorded from a button on a
 * row. Choosing this layout writes nothing at all.
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
 * # Two representations of the same table
 *
 * While scoring, a tile is a *chair*. The `<li>` is keyed by seat, so a substitution changes who is
 * sitting in it and moves nothing: the rectangle, its number and its place on the table are all
 * exactly where they were. That is the whole sentence a substitution has to say — same seat,
 * different person — and a chair that flew across the table would say the opposite.
 *
 * While arranging, a tile is a *player*. The room is telling the software it had the order wrong,
 * and the thing being moved is a person between positions, so the `<li>` is keyed by name and the
 * drag carries it. The two representations are separate lists rather than one list with a flag,
 * which is what keeps each of them honest about what its keys mean.
 *
 * # Which way the tables run
 *
 * A scorekeeper sitting alongside the tables sees each team's seats left to right. One sitting at the
 * end of the room, beside the moderator — which is where most of them actually sit — is looking down
 * the tables, and the seats run away from them. `down` draws that, and is the same table in every
 * other respect: same tiles, same picker, same seat order, same drag. It is a chair to look from, not
 * a third layout. See `TableOrientation`.
 *
 * This is still not a floor plan. Two fixed tables, one linear order along each, no arbitrary
 * placement, nothing draggable except a player's position among their own team-mates.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { LeftOrRight } from '../scoring/types';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IDerivedTeam } from '../scoring/deriveGame';
import { useLineupMotion } from './LineupMotion';
import { reorderSeats } from './PlayerSeating';
import { previewSeatNumber, useSeatDrag } from './SeatDrag';
import { seatChangeEmphasisMs } from './TeamPanel';
import RulingPicker from './RulingPicker';
import tossupChoices, { TossupChoice } from './tossupChoices';
import { defaultTableOrientation, TableOrientation } from './scoringViewPreference';

/**
 * Which way a seat's neighbours are, in the words its controls use.
 *
 * The arrow keys accept both pairs whichever way the table runs — a scorekeeper who reaches for the
 * one that matches the screen is right, and so is one who reaches for the other. What has to follow
 * the orientation is the *naming*: "Move Jeremy left" on a table that runs downwards is a label
 * describing a different screen.
 */
const nudgeNames: Record<TableOrientation, { earlier: string; later: string }> = {
  across: { earlier: 'left', later: 'right' },
  down: { earlier: 'up', later: 'down' },
};

/** The glyphs beside them, pointing the way the seat would actually go. */
const nudgeGlyphs: Record<TableOrientation, { earlier: string; later: string }> = {
  across: { earlier: '‹', later: '›' },
  down: { earlier: '⌃', later: '⌄' },
};

/** How long a tile keeps the wash that says a ruling landed on it. The scoresheet's own duration. */
const rulingEmphasisMs = 220;

const displaySides: readonly LeftOrRight[] = ['left', 'right'];

export interface ITableViewProps {
  format: IScorekeeperFormat;
  /** Already display-mapped. Left here is the team on the left of the screen. */
  teams: Record<LeftOrRight, IDerivedTeam>;
  reactions?: ReadonlyMap<IDerivedTeam, ScoreReaction>;
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
   * Which way the tables run on screen.
   *
   * A device preference about where the scorekeeper is sitting, not a property of the game. Nothing
   * about the seats, the rulings or the events changes with it.
   */
  orientation?: TableOrientation;
  /**
   * Whether the room is currently putting the tables in the order it is sitting in.
   *
   * Controlled from above because the control that turns it on lives in the toolbar beside the
   * layout switcher, which is deliberately outside this component so that it does not move when the
   * layout does.
   */
  arranging?: boolean;
  onArrangingChange?: (arranging: boolean) => void;
  /**
   * Commit one team's table order.
   *
   * The whole visible order rather than a direction, because a drag is not a nudge: a player carried
   * from the fourth chair to the first is one decision, and expressing it as three moves would be
   * three writes describing a journey nobody took. The keyboard and the fallback arrows use the same
   * callback with a distance of one.
   *
   * This is `seating.arrange` under a different name — one physical seat order, shared with the
   * scoresheet rows and the keyboard's seat mapping. Absent means the table cannot be rearranged
   * from here and no arrangement controls are drawn.
   */
  onArrangeSeats?: (side: LeftOrRight, visibleNames: readonly string[]) => void;
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
    reactions,
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
    orientation = defaultTableOrientation,
    arranging = false,
    onArrangingChange,
    onArrangeSeats,
    arrangementUnconfirmed = false,
    onConfirmArrangement,
    onDismissArrangementHint,
    lineupOrderCheck,
    onDismissOrderCheck,
  } = props;

  const [selected, setSelected] = useState<ISelection | null>(null);
  const [hintDismissed, setHintDismissed] = useState(false);
  const pickerId = useId();
  /** Answered here and reported upward, so it stays answered across a look at the scoresheet. */
  const dismissHint = () => {
    setHintDismissed(true);
    onDismissArrangementHint?.();
  };

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

  const showHint = arrangementUnconfirmed && !hintDismissed && !arranging && onArrangeSeats !== undefined;

  return (
    <div className="scorer-table-view" data-orientation={orientation}>
      {showHint && (
        <div className="scorer-table-hint" role="note">
          <p className="scorer-table-hint-title">Match the table</p>
          <p className="scorer-table-hint-body">
            Players are currently shown in roster order. Drag them into the order they&rsquo;re sitting.
          </p>
          <div className="scorer-table-hint-actions">
            <button
              type="button"
              className="scorer-choice"
              onClick={() => {
                dismissHint();
                onArrangingChange?.(true);
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
          {onArrangeSeats && (
            <button
              type="button"
              className="scorer-text-action"
              onClick={() => {
                onArrangingChange?.(true);
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
            reaction={reactions?.get(teams[side])}
            seats={seatedPlayers[side]}
            scoringEnabled={scoringEnabled}
            eligible={eligible(side)}
            arranging={arranging && onArrangeSeats !== undefined}
            flashSeat={flashSeat?.side === side ? flashSeat.seat : undefined}
            recorded={recorded?.side === side ? recorded : null}
            selectedPlayer={selected?.side === side ? selected.playerName : null}
            pickerId={pickerId}
            timeoutsUsed={timeouts?.[side]}
            timeoutsPerTeam={timeoutsPerTeam}
            orientation={orientation}
            onArrangeSeats={onArrangeSeats}
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
  reaction?: ScoreReaction;
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
  orientation: TableOrientation;
  onArrangeSeats?: (side: LeftOrRight, visibleNames: readonly string[]) => void;
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
    reaction,
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
    orientation,
    onArrangeSeats,
    onSelect,
  } = props;

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

  return (
    <section className="scorer-table-team" aria-label={team.name}>
      <header className="scorer-table-team-head">
        <h2 className="scorer-team-name" title={team.name}>
          {team.name}
        </h2>
        <p className="scorer-team-score" aria-label={`${team.name} score`}>
          <ScoreValue team={team} reaction={reaction} />
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
        {arranging && onArrangeSeats ? (
          <ArrangeSeats
            side={side}
            teamName={team.name}
            seats={seats}
            orientation={orientation}
            onArrangeSeats={onArrangeSeats}
          />
        ) : (
          <ScoringSeats
            teamName={team.name}
            seats={seats}
            scoringEnabled={scoringEnabled}
            eligible={eligible}
            flashSeat={flashSeat}
            landed={landed}
            recorded={recorded}
            selectedPlayer={selectedPlayer}
            pickerId={pickerId}
            onSelect={onSelect}
          />
        )}
      </div>
      {recorded && (
        <span className="visually-hidden" role="status">
          {recorded.playerName} ruling recorded.
        </span>
      )}
    </section>
  );
}

/**
 * The table while a tossup is live: one chair per player, and the chair is the object.
 *
 * Keyed by seat. A substitution swaps the name inside a rectangle that does not move, which is the
 * only thing that actually happened.
 */
function ScoringSeats(props: {
  teamName: string;
  seats: readonly string[];
  scoringEnabled: boolean;
  eligible: boolean;
  flashSeat?: number;
  landed: { seats: number[]; token: number } | null;
  recorded: { playerName: string; isNeg: boolean; token: number } | null;
  selectedPlayer: string | null;
  pickerId: string;
  onSelect: (playerName: string, tile: HTMLButtonElement) => void;
}) {
  const {
    teamName,
    seats,
    scoringEnabled,
    eligible,
    flashSeat,
    landed,
    recorded,
    selectedPlayer,
    pickerId,
    onSelect,
  } = props;

  const disabledReason = !scoringEnabled
    ? 'No tossup is live.'
    : `${teamName} has already answered this tossup.`;

  return (
    <ul className="scorer-table-seats" aria-label={`${teamName} table`}>
      {seats.map((playerName, seat) => (
        <li
          key={seat}
          className="scorer-table-seat"
          data-seat-token={landed?.seats.includes(seat) ? landed.token : undefined}
        >
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
        </li>
      ))}
      {seats.length === 0 && <li className="scorer-table-empty">Nobody is on the floor for this team.</li>}
    </ul>
  );
}

/**
 * The table while the room is telling it what order everybody is in.
 *
 * Keyed by player, because the player is what moves. Drag is the ordinary way — see `SeatDrag` — and
 * the arrows beside each tile are there for a pointer that cannot drag; the arrow keys do the same
 * job for a keyboard, on the tile that has focus, and say out loud where the player ended up.
 *
 * Nothing here can move somebody to the other team: each table owns its own list, and a drop is
 * expressed as an index within it.
 */
function ArrangeSeats(props: {
  side: LeftOrRight;
  teamName: string;
  seats: readonly string[];
  orientation: TableOrientation;
  onArrangeSeats: (side: LeftOrRight, visibleNames: readonly string[]) => void;
}) {
  const { side, teamName, seats, orientation, onArrangeSeats } = props;
  const axis = orientation === 'down' ? 'y' : 'x';
  const names = nudgeNames[orientation];
  const glyphs = nudgeGlyphs[orientation];
  const instructionsId = useId();
  const [announcement, setAnnouncement] = useState('');
  /*
   * The FLIP the lineup editor uses, for the discrete moves only.
   *
   * A drag already shows where everybody is going, frame by frame, and running an interpolation over
   * the top of it would animate the same movement twice. An arrow press has no such preview, so it
   * keeps the travel that makes "which one did I just move?" answerable without reading.
   */
  const motion = useLineupMotion({ axis });

  const move = useCallback(
    (from: number, to: number, animate: boolean) => {
      const target = Math.min(seats.length - 1, Math.max(0, to));
      if (target === from || from < 0 || from >= seats.length) return;
      const playerName = seats[from];
      if (animate) motion.beginMove(playerName);
      onArrangeSeats(side, reorderSeats(seats, from, target));
      setAnnouncement(`${playerName} is now seat ${target + 1} of ${seats.length}, ${teamName}.`);
    },
    [motion, onArrangeSeats, seats, side, teamName],
  );

  // The drop owns the movement it has already been showing, so no interpolation is asked for.
  const drag = useSeatDrag(seats.length, (from, to) => move(from, to, false), axis);

  if (seats.length === 0) {
    return (
      <ul className="scorer-table-seats" aria-label={`${teamName} table`}>
        <li className="scorer-table-empty">Nobody is on the floor for this team.</li>
      </ul>
    );
  }

  return (
    <>
      <p id={instructionsId} className="visually-hidden">
        Drag a player along the table, or use the arrow keys to move them.
      </p>
      <ul
        className={`scorer-table-seats is-arranging${drag.drag ? ' is-dragging' : ''}`}
        aria-label={`${teamName} table`}
      >
        {seats.map((playerName, index) => {
          const dragging = drag.drag?.from === index;
          const transform = drag.seatTransform(index);
          return (
            <li
              key={playerName}
              ref={(element) => {
                // Two owners of one element and neither writes what the other reads: the FLIP moves
                // the list item between renders, the drag only measures it.
                motion.rowRef(playerName)(element);
                drag.seatRef(index)(element);
              }}
              className={motion.rowClassName(playerName, 'scorer-table-seat')}
            >
              <button
                type="button"
                className={`scorer-table-player is-arranging${dragging ? ' is-dragging' : ''}`}
                style={transform ? { transform } : undefined}
                aria-roledescription="Sortable seat"
                aria-label={`${playerName}, seat ${previewSeatNumber(index, drag.drag)} of ${seats.length}`}
                aria-describedby={instructionsId}
                onPointerDown={drag.onPointerDown(index)}
                onKeyDown={(event) => {
                  /*
                   * Both pairs, whichever way this table runs.
                   *
                   * A scorekeeper reaching for the arrow that matches the screen is right, and one
                   * reaching for the pair they used on the last table is right too. There is nothing
                   * else for up and down to mean in a single row, or for left and right in a single
                   * column, so accepting both costs no ambiguity and saves a wrong guess.
                   */
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') move(index, index - 1, true);
                  else if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
                    move(index, index + 1, true);
                  else if (event.key === 'Home') move(index, 0, true);
                  else if (event.key === 'End') move(index, seats.length - 1, true);
                  else return;
                  event.preventDefault();
                }}
              >
                <span className="scorer-table-player-seat" aria-hidden="true">
                  {previewSeatNumber(index, drag.drag)}
                </span>
                <span className="scorer-table-player-name" title={playerName}>
                  {playerName}
                </span>
                <span className="scorer-table-grip" aria-hidden="true" />
              </button>
              {/*
                The way round for a pointer that cannot drag.

                Quiet, and revealed by hover or focus rather than drawn on every seat all the time:
                the table has to say "drag these" first, and two arrows per player shouted that
                loudly enough to drown it out.
              */}
              <span className={`scorer-table-nudge${drag.drag ? ' is-hidden' : ''}`}>
                <button
                  type="button"
                  className="scorer-table-nudge-action"
                  aria-label={`Move ${playerName} ${names.earlier}`}
                  disabled={index === 0}
                  onClick={() => move(index, index - 1, true)}
                >
                  {glyphs.earlier}
                </button>
                <button
                  type="button"
                  className="scorer-table-nudge-action"
                  aria-label={`Move ${playerName} ${names.later}`}
                  disabled={index === seats.length - 1}
                  onClick={() => move(index, index + 1, true)}
                >
                  {glyphs.later}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <span className="visually-hidden" role="status">
        {announcement}
      </span>
    </>
  );
}
