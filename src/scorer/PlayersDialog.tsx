/**
 * Who is on the floor.
 *
 * The main screen shows only active players, and never a row of empty seats waiting to be filled —
 * a roster of four with two blanks under it invites somebody to score a buzz against nobody.
 * Changing the lineup is a deliberate act, so it happens here.
 *
 * The change takes effect from the question about to be played, which is what keeps tossups heard
 * honest: a player who came on at question eleven heard ten fewer tossups than one who started, and
 * that difference is a real statistic rather than an approximation.
 *
 * # Substitutions, not a spreadsheet
 *
 * What the engine stores is the complete lineup effective at a question boundary, and that is the
 * right thing to store: it is unambiguous, it survives a reload, and tossups heard fall out of it
 * exactly. What it is not is the thing a scorekeeper is thinking about. They are being told "eleven
 * for four" by a coach, and the old screen answered that with a grid of checkboxes, a running total
 * to verify by eye, and an Apply button — four steps and an arithmetic check for the single most
 * common thing that happens in a game.
 *
 * So the ordinary path is now the sentence itself: Sub out, choose who comes on, confirm. The
 * complete-lineup event is built from that. The checkbox editor is still here, one click away,
 * because halftime really is four changes at once and a format change really does need it — but it
 * is no longer what a one-for-one substitution costs.
 */
import { KeyboardEvent, useEffect, useRef, useState } from 'react';
import { LeftOrRight } from '../scoring/types';
import { IDerivedTeam } from '../scoring/deriveGame';
import ScorerDialog from './ScorerDialog';
import { playerNameMaxLength, validatePlayerName } from '../game/Roster';
import { orderBySeating } from './PlayerSeating';
import PlayingBenchEditor from './PlayingBenchEditor';
import { orderedActivePlayers, sameMembership } from './LineupEditing';
import { useLineupMotion } from './LineupMotion';

export interface IPlayersDialogProps {
  left: IDerivedTeam;
  right: IDerivedTeam;
  /** How many a team may have active at once, from the format. */
  maximumActive: number;
  /** The question the change will apply from. */
  questionNumber: number;
  /**
   * Timeouts each team has taken, when the tournament tracks them.
   *
   * Here as well as on the team panel because this is where a scorekeeper looks when a coach asks,
   * and because substitutions and timeouts are the same conversation on a real scoresheet.
   */
  timeouts?: Record<LeftOrRight, number>;
  /** How many each team gets. Zero means timeouts are not tracked and nothing is shown. */
  timeoutsPerTeam?: number;
  /** Whether the current procedure allows a lineup change at this point in the game. */
  lineupChangeAllowed?: boolean;
  /**
   * Teams that have been authorized one change the procedure would not otherwise offer.
   *
   * Separate from `lineupChangeAllowed` because a ruling is about one team: a director who lets a
   * late arrival on for Central has said nothing about the other bench. See `ProcedureExceptions`.
   */
  lineupChangeAuthorized?: Record<LeftOrRight, boolean>;
  /**
   * Whether somebody may be added to the roster at all.
   *
   * Separate from `lineupChangeAllowed` because they are separate acts: a player who has turned up
   * exists whether or not the procedure lets them on the floor this second, and a room that cannot
   * write them down has to remember them instead.
   */
  rosterAdditionAllowed?: boolean;
  /** Shown when the roster can be viewed but the procedure does not permit changing it yet. */
  lineupChangeReason?: string;
  /**
   * The way out when the procedure is what is standing in the way.
   *
   * Rendered only beside that explanation, so it exists exactly when a scorekeeper has just been
   * told they cannot do the thing they opened this dialog to do. A room whose lineup changes are
   * available — which is every room at every ordinary boundary — never sees it.
   */
  onProcedureQuery?: () => void;
  onSubstitute: (team: LeftOrRight, activePlayers: string[]) => void;
  /**
   * Add somebody to the roster, and say who should be on the floor afterwards.
   *
   * The two are separate decisions and are passed separately: a player added while the team is
   * already at capacity joins the bench, and `activePlayers` simply comes back unchanged.
   */
  onAddPlayer: (team: LeftOrRight, playerName: string, activePlayers: string[]) => void;
  rosterSyncStatus?: Record<string, 'synced' | 'waiting' | 'local' | 'rejected'>;
  onRequestControl?: (team: LeftOrRight, playerName: string) => void;
  /**
   * The order the room wants to see each team in, and how to change it.
   *
   * A view preference, kept out of the event history on purpose — see `PlayerSeating`. Absent means
   * the roster's own order, and no reordering controls.
   */
  seating?: Record<LeftOrRight, string[]>;
  onMovePlayer?: (team: LeftOrRight, visibleNames: string[], playerName: string, direction: -1 | 1) => void;
  /** Told which way round a one-for-one substitution went, so the replacement takes the same seat. */
  onSeatSubstitute?: (team: LeftOrRight, outgoing: string, incoming: string) => void;
  onClose: () => void;
}

export function rosterSyncKey(team: LeftOrRight, playerName: string): string {
  return `${team}\u0000${playerName.toLocaleLowerCase()}`;
}

function syncLabelFor(status: string | undefined): string {
  if (status === 'synced') return 'Synced';
  if (status === 'waiting') return 'Waiting to sync';
  if (status === 'local') return 'Saved in this game';
  if (status === 'rejected') return 'Needs tournament control';
  return '';
}

/**
 * What the panel is in the middle of.
 *
 * A substitution is two decisions — who comes off, who goes on — and the confirmation exists
 * because it is the one place the effective question number can be shown before the event is
 * written. `full` and `add` are the two escapes from the ordinary path.
 */
type PanelMode =
  | { kind: 'idle' }
  | { kind: 'choose-replacement'; out: string }
  | { kind: 'choose-outgoing'; incoming: string }
  | { kind: 'confirm'; out?: string; incoming: string }
  | { kind: 'full' }
  | { kind: 'add' }
  | { kind: 'reorder' };

/**
 * The multi-change editor, kept for halftime and for anything that is not one-for-one.
 *
 * Membership is the state; the array that gets written is derived from it at Apply — see
 * `orderedActivePlayers`. Rows are presented in this device's seating order because that is what the
 * rest of Players is showing, and that presentation order is deliberately not what gets serialized:
 * a room that likes its rows a different way must not be able to write a substitution that reorders
 * a lineup nobody changed.
 */
function FullLineupEditor(props: {
  team: IDerivedTeam;
  side: LeftOrRight;
  maximumActive: number;
  seatOrder: readonly string[];
  onApply: (activePlayers: string[]) => void;
  onCancel: () => void;
}) {
  const { team, side, maximumActive, seatOrder, onApply, onCancel } = props;
  const [playing, setPlaying] = useState<ReadonlySet<string>>(() => new Set(team.activePlayers));

  const rosterNames = team.players.map((player) => player.name);
  const shownOrder = orderBySeating(team.players, seatOrder, (player) => player.name).map(
    (player) => player.name,
  );
  const tossupsHeard = new Map(team.players.map((player) => [player.name, player.tossupsHeard]));
  const proposed = orderedActivePlayers(team.activePlayers, rosterNames, playing);
  const unchanged = sameMembership(proposed, team.activePlayers);

  const bench = (name: string) =>
    setPlaying((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });

  const putIn = (name: string) =>
    setPlaying((current) => {
      if (current.size >= maximumActive) return current;
      const next = new Set(current);
      next.add(name);
      return next;
    });

  return (
    <div className="scorer-lineup-editor">
      <PlayingBenchEditor
        idPrefix={`scorer-lineup-${side}`}
        order={shownOrder}
        playing={playing}
        maximumActive={maximumActive}
        detailFor={(name) => `${tossupsHeard.get(name) ?? 0} TUH`}
        onBench={bench}
        onPutIn={putIn}
      />
      <p className="scorer-lineup-count">
        {playing.size} of {maximumActive} playing
      </p>
      <div className="scorer-lineup-actions">
        <button
          type="button"
          className="scorer-choice"
          disabled={unchanged || proposed.length === 0}
          onClick={() => onApply(proposed)}
        >
          Apply lineup
        </button>
        <button type="button" className="scorer-text-action" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function TeamLineup(props: {
  team: IDerivedTeam;
  side: LeftOrRight;
  maximumActive: number;
  questionNumber: number;
  onSubstitute: (team: LeftOrRight, activePlayers: string[]) => void;
  onAddPlayer: (team: LeftOrRight, playerName: string, activePlayers: string[]) => void;
  rosterSyncStatus: Record<string, 'synced' | 'waiting' | 'local' | 'rejected'>;
  timeoutsUsed: number;
  timeoutsPerTeam: number;
  lineupChangeAllowed: boolean;
  /** A ruling authorized one change for this team, whatever the procedure says. */
  lineupChangeAuthorized: boolean;
  rosterAdditionAllowed: boolean;
  seatOrder: readonly string[];
  onRequestControl?: (team: LeftOrRight, playerName: string) => void;
  onMovePlayer?: (team: LeftOrRight, visibleNames: string[], playerName: string, direction: -1 | 1) => void;
  onSeatSubstitute?: (team: LeftOrRight, outgoing: string, incoming: string) => void;
}) {
  const {
    team,
    side,
    maximumActive,
    questionNumber,
    onSubstitute,
    onAddPlayer,
    rosterSyncStatus,
    timeoutsUsed,
    timeoutsPerTeam,
    lineupChangeAllowed: procedureAllowsChange,
    lineupChangeAuthorized,
    rosterAdditionAllowed,
    seatOrder,
    onRequestControl,
    onMovePlayer,
    onSeatSubstitute,
  } = props;
  const [mode, setMode] = useState<PanelMode>({ kind: 'idle' });
  // The procedure's answer, or the ruling that overrode it for this team alone.
  const lineupChangeAllowed = procedureAllowsChange || lineupChangeAuthorized;
  const [newPlayer, setNewPlayer] = useState('');
  const addPlayerInput = useRef<HTMLInputElement>(null);
  const motion = useLineupMotion();

  // Both lists follow the room's seating, so what is on screen here is what is on screen out
  // there. The bench is ordered too, so a player who comes on lands where the room expects.
  const playing = orderBySeating(
    team.players.filter((player) => team.activePlayers.includes(player.name)),
    seatOrder,
    (player) => player.name,
  );
  const bench = orderBySeating(
    team.players.filter((player) => !team.activePlayers.includes(player.name)),
    seatOrder,
    (player) => player.name,
  );
  const playingNames = playing.map((player) => player.name);
  const atCapacity = team.activePlayers.length >= maximumActive;
  const newPlayerValidation = validatePlayerName(
    newPlayer,
    team.players.map((player) => player.name),
  );

  useEffect(() => {
    if (mode.kind === 'add') addPlayerInput.current?.focus();
  }, [mode.kind]);

  const cancelAdd = () => {
    setNewPlayer('');
    setMode({ kind: 'idle' });
  };

  const handleAddKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cancelAdd();
  };

  /**
   * The complete lineup a one-for-one substitution produces.
   *
   * The incoming player is placed where the outgoing one was rather than appended, so the stored
   * lineup reads in the same order the room is looking at. Nothing downstream depends on that
   * order — tossups heard is set membership — but a scoresheet that reads out of order is a
   * scoresheet somebody has to re-check.
   */
  const lineupAfter = (out: string | undefined, incoming: string): string[] => {
    if (out === undefined) return team.activePlayers.concat(incoming);
    const next = team.activePlayers.slice();
    const seat = next.indexOf(out);
    if (seat < 0) return next.concat(incoming);
    next.splice(seat, 1, incoming);
    return next;
  };

  /** Record the substitution, and give the replacement the seat the outgoing player was in. */
  const confirmSubstitution = (out: string | undefined, incoming: string) => {
    if (out !== undefined && onSeatSubstitute) onSeatSubstitute(side, out, incoming);
    onSubstitute(side, lineupAfter(out, incoming));
  };

  const playerRow = (
    player: IDerivedTeam['players'][number],
    active: boolean,
    seat: number,
    reordering = false,
  ) => {
    const sync = rosterSyncStatus[rosterSyncKey(side, player.name)];
    const syncLabel = syncLabelFor(sync);
    const canMove = reordering && active && onMovePlayer !== undefined && playing.length > 1;
    const move = (direction: -1 | 1) => {
      // Measure immediately before the actual seating state changes. LineupMotion owns the
      // presentation-only FLIP interpolation; the callback still changes the real order at once.
      motion.beginMove(player.name);
      onMovePlayer?.(side, playingNames, player.name, direction);
    };

    if (reordering && active) {
      return (
        <li
          key={player.name}
          ref={motion.rowRef(player.name)}
          className={motion.rowClassName(player.name, 'scorer-lineup-entry scorer-lineup-reorder-entry')}
        >
          <span className="scorer-lineup-seat" aria-hidden="true">
            {seat + 1}
          </span>
          <span className="scorer-lineup-reorder-name">{player.name}</span>
          <span className="scorer-lineup-move">
            <button
              type="button"
              className="scorer-text-action"
              aria-label={`Move ${player.name} up`}
              disabled={!canMove || seat === 0}
              onClick={() => move(-1)}
            >
              &uarr;
            </button>
            <button
              type="button"
              className="scorer-text-action"
              aria-label={`Move ${player.name} down`}
              disabled={!canMove || seat === playing.length - 1}
              onClick={() => move(1)}
            >
              &darr;
            </button>
          </span>
        </li>
      );
    }

    return (
      <li key={player.name} className="scorer-lineup-entry">
        {/* The seat number, matching the column this player occupies on the scoring screen. */}
        <span className="scorer-lineup-seat" aria-hidden="true">
          {active ? seat + 1 : '\u2014'}
        </span>
        <span className="scorer-lineup-player">
          <span className="scorer-lineup-name">{player.name}</span>
          {syncLabel && <span className="scorer-lineup-sync">{syncLabel}</span>}
          {sync === 'rejected' && onRequestControl && (
            <button
              type="button"
              className="scorer-sync-action"
              onClick={() => onRequestControl(side, player.name)}
            >
              Request tournament control
            </button>
          )}
        </span>
        <span className="scorer-lineup-tuh">{player.tossupsHeard} TUH</span>
        {!reordering && active ? (
          <button
            type="button"
            className="scorer-text-action"
            disabled={!lineupChangeAllowed}
            onClick={() => setMode({ kind: 'choose-replacement', out: player.name })}
          >
            Replace
          </button>
        ) : null}
        {!reordering && !active ? (
          <button
            type="button"
            className="scorer-text-action"
            disabled={!lineupChangeAllowed}
            onClick={() =>
              setMode(
                atCapacity
                  ? { kind: 'choose-outgoing', incoming: player.name }
                  : { kind: 'confirm', incoming: player.name },
              )
            }
          >
            {atCapacity ? 'Replace…' : 'Put in'}
          </button>
        ) : null}
      </li>
    );
  };

  return (
    <section className="scorer-lineup" aria-label={`${team.name} lineup`}>
      <div className="scorer-lineup-head">
        <h3 className="scorer-lineup-team">{team.name}</h3>
        {!procedureAllowsChange && lineupChangeAuthorized && (
          <p className="scorer-team-timeout">One lineup change was allowed</p>
        )}
        {timeoutsPerTeam > 0 && (
          <p className="scorer-team-timeout">
            {timeoutsUsed === 0 &&
              (timeoutsPerTeam === 1 ? 'Timeout available' : `${timeoutsPerTeam} timeouts available`)}
            {timeoutsUsed > 0 && timeoutsUsed === 1 && 'Timeout used'}
            {timeoutsUsed > 1 && `${timeoutsUsed} timeouts used`}
          </p>
        )}
      </div>

      {mode.kind === 'idle' && (
        <div className="scorer-lineup-primary-actions">
          <button
            type="button"
            className="scorer-text-action"
            disabled={!rosterAdditionAllowed}
            onClick={() => setMode({ kind: 'add' })}
          >
            + Add player
          </button>
          <button
            type="button"
            className="scorer-text-action"
            disabled={!lineupChangeAllowed}
            onClick={() => setMode({ kind: 'full' })}
          >
            Change lineup
          </button>
          {onMovePlayer && playing.length > 1 && (
            <button type="button" className="scorer-text-action" onClick={() => setMode({ kind: 'reorder' })}>
              Reorder
            </button>
          )}
        </div>
      )}

      {mode.kind === 'add' && (
        <form
          className="scorer-inline-add scorer-player-inline-add"
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault();
            if (!rosterAdditionAllowed || newPlayerValidation.problem) return;
            const goesOn = lineupChangeAllowed && !atCapacity;
            onAddPlayer(
              side,
              newPlayerValidation.name,
              goesOn ? team.activePlayers.concat(newPlayerValidation.name) : team.activePlayers,
            );
          }}
        >
          <label htmlFor={`scorer-add-player-${side}`}>Player name</label>
          <div className="scorer-inline-add-fields">
            <input
              ref={addPlayerInput}
              id={`scorer-add-player-${side}`}
              value={newPlayer}
              maxLength={playerNameMaxLength}
              placeholder="Player name"
              onChange={(changeEvent) => setNewPlayer(changeEvent.target.value)}
              onKeyDown={handleAddKeyDown}
              aria-describedby={
                newPlayer !== '' && newPlayerValidation.problem
                  ? `scorer-add-player-error-${side}`
                  : undefined
              }
            />
            <button
              type="submit"
              className="scorer-choice"
              disabled={!rosterAdditionAllowed || newPlayerValidation.problem !== undefined}
            >
              Add
            </button>
            <button type="button" className="scorer-text-action" onClick={cancelAdd}>
              Cancel
            </button>
          </div>
          {newPlayer !== '' && newPlayerValidation.problem && (
            <span id={`scorer-add-player-error-${side}`} className="scorer-field-error" role="alert">
              {newPlayerValidation.problem}
            </span>
          )}
          <span className="scorer-inline-add-note">
            {!lineupChangeAllowed
              ? 'They will join the bench and can come on at the next allowed substitution.'
              : atCapacity
                ? `They will join the bench; ${team.name} already has ${maximumActive} playing.`
                : `They will start playing from Tossup ${questionNumber}.`}
          </span>
        </form>
      )}

      {(mode.kind === 'idle' || mode.kind === 'add' || mode.kind === 'reorder') && (
        <div className="scorer-lineup-roster">
          {mode.kind === 'reorder' && (
            <div className="scorer-reorder-head">
              <p className="scorer-lineup-step-title">Reorder seats</p>
              <button type="button" className="scorer-text-action" onClick={() => setMode({ kind: 'idle' })}>
                Done
              </button>
            </div>
          )}
          <h4 className="scorer-lineup-group">Playing</h4>
          {mode.kind === 'reorder' ? (
            <ul
              className="scorer-lineup-list scorer-lineup-reorder-list"
              aria-label={`${team.name} playing seats`}
            >
              {playing.map((player, seat) => playerRow(player, true, seat, true))}
            </ul>
          ) : (
            <>
              <ul className="scorer-lineup-list">
                {playing.map((player, seat) => playerRow(player, true, seat))}
              </ul>
              {bench.length > 0 && (
                <>
                  <h4 className="scorer-lineup-group">Bench</h4>
                  <ul className="scorer-lineup-list">
                    {bench.map((player) => playerRow(player, false, -1))}
                  </ul>
                </>
              )}
            </>
          )}
          <p className="scorer-lineup-count">
            {team.activePlayers.length} of {maximumActive} playing
          </p>
        </div>
      )}

      {mode.kind === 'choose-replacement' && (
        <div className="scorer-lineup-step">
          <p className="scorer-lineup-step-title">Replace {mode.out}</p>
          {bench.length === 0 ? (
            <p className="scorer-dialog-note">
              Everybody on the roster is already playing. Add a player first to bring somebody else on.
            </p>
          ) : (
            <ul
              className="scorer-lineup-list scorer-replacement-list"
              aria-label={`Replacements for ${mode.out}`}
            >
              {bench.map((player) => (
                <li key={player.name}>
                  <button
                    type="button"
                    className="scorer-replacement-choice"
                    onClick={() => setMode({ kind: 'confirm', out: mode.out, incoming: player.name })}
                  >
                    <span>{player.name}</span>
                    <span className="scorer-lineup-tuh">{player.tossupsHeard} TUH</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="scorer-lineup-actions">
            <button type="button" className="scorer-text-action" onClick={() => setMode({ kind: 'idle' })}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode.kind === 'choose-outgoing' && (
        <div className="scorer-lineup-step">
          <p className="scorer-lineup-step-title">Put {mode.incoming} in</p>
          <p className="scorer-dialog-note">Replace:</p>
          <ul
            className="scorer-lineup-list scorer-replacement-list"
            aria-label={`Player replaced by ${mode.incoming}`}
          >
            {playing.map((player) => (
              <li key={player.name}>
                <button
                  type="button"
                  className="scorer-replacement-choice"
                  onClick={() => setMode({ kind: 'confirm', out: player.name, incoming: mode.incoming })}
                >
                  <span>{player.name}</span>
                  <span className="scorer-lineup-tuh">{player.tossupsHeard} TUH</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="scorer-lineup-actions">
            <button type="button" className="scorer-text-action" onClick={() => setMode({ kind: 'idle' })}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode.kind === 'confirm' && (
        <div className="scorer-lineup-step">
          <p className="scorer-lineup-step-title">
            {mode.out ? `${mode.out} → ${mode.incoming}` : `${mode.incoming} comes on`}
          </p>
          <p className="scorer-dialog-note">Effective starting Tossup {questionNumber}</p>
          <div className="scorer-lineup-actions">
            <button type="button" className="scorer-text-action" onClick={() => setMode({ kind: 'idle' })}>
              Cancel
            </button>
            <button
              type="button"
              className="scorer-choice"
              onClick={() => confirmSubstitution(mode.out, mode.incoming)}
            >
              Confirm
            </button>
          </div>
        </div>
      )}

      {mode.kind === 'full' && (
        <div className="scorer-lineup-step">
          <p className="scorer-lineup-step-title">Change lineup</p>
          <FullLineupEditor
            team={team}
            side={side}
            maximumActive={maximumActive}
            seatOrder={seatOrder}
            onApply={(activePlayers) => onSubstitute(side, activePlayers)}
            onCancel={() => setMode({ kind: 'idle' })}
          />
        </div>
      )}
    </section>
  );
}

export default function PlayersDialog(props: IPlayersDialogProps) {
  const {
    left,
    right,
    maximumActive,
    questionNumber,
    onSubstitute,
    onAddPlayer,
    rosterSyncStatus = {},
    timeouts = { left: 0, right: 0 },
    timeoutsPerTeam = 0,
    lineupChangeAllowed = true,
    lineupChangeAuthorized = { left: false, right: false },
    rosterAdditionAllowed = true,
    lineupChangeReason,
    onProcedureQuery,
    onRequestControl,
    seating = { left: [], right: [] },
    onMovePlayer,
    onSeatSubstitute,
    onClose,
  } = props;

  const anyAuthorized = lineupChangeAuthorized.left || lineupChangeAuthorized.right;

  return (
    <ScorerDialog title="Players" wide onClose={onClose}>
      <p className="scorer-dialog-note">
        {lineupChangeAllowed || anyAuthorized
          ? `Changes apply starting Tossup ${questionNumber}.`
          : (lineupChangeReason ?? 'Lineup changes are not available at this checkpoint.')}
        {!lineupChangeAllowed && onProcedureQuery && (
          <>
            {' '}
            <button type="button" className="scorer-text-action" onClick={onProcedureQuery}>
              Procedure changed?
            </button>
          </>
        )}
      </p>
      <div className="scorer-lineups">
        <TeamLineup
          team={left}
          side="left"
          maximumActive={maximumActive}
          questionNumber={questionNumber}
          onSubstitute={onSubstitute}
          onAddPlayer={onAddPlayer}
          rosterSyncStatus={rosterSyncStatus}
          timeoutsUsed={timeouts.left}
          timeoutsPerTeam={timeoutsPerTeam}
          lineupChangeAllowed={lineupChangeAllowed}
          lineupChangeAuthorized={lineupChangeAuthorized.left}
          rosterAdditionAllowed={rosterAdditionAllowed}
          seatOrder={seating.left}
          onRequestControl={onRequestControl}
          onMovePlayer={onMovePlayer}
          onSeatSubstitute={onSeatSubstitute}
        />
        <TeamLineup
          team={right}
          side="right"
          maximumActive={maximumActive}
          questionNumber={questionNumber}
          onSubstitute={onSubstitute}
          onAddPlayer={onAddPlayer}
          rosterSyncStatus={rosterSyncStatus}
          timeoutsUsed={timeouts.right}
          timeoutsPerTeam={timeoutsPerTeam}
          lineupChangeAllowed={lineupChangeAllowed}
          lineupChangeAuthorized={lineupChangeAuthorized.right}
          rosterAdditionAllowed={rosterAdditionAllowed}
          seatOrder={seating.right}
          onRequestControl={onRequestControl}
          onMovePlayer={onMovePlayer}
          onSeatSubstitute={onSeatSubstitute}
        />
      </div>
    </ScorerDialog>
  );
}
