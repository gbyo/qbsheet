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
import { useEffect, useRef, useState } from 'react';
import { LeftOrRight } from '../../renderer/Utils/UtilTypes';
import { IDerivedTeam } from '../scoring/deriveGame';
import ScorerDialog from './ScorerDialog';
import { roomPlayerNameMaxLength } from '../../main/server/ServerTypes';
import { orderBySeating } from './PlayerSeating';

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
  // eslint-disable-next-line react/require-default-props
  timeouts?: Record<LeftOrRight, number>;
  /** How many each team gets. Zero means timeouts are not tracked and nothing is shown. */
  // eslint-disable-next-line react/require-default-props
  timeoutsPerTeam?: number;
  /** Whether the current procedure allows a lineup change at this point in the game. */
  // eslint-disable-next-line react/require-default-props
  lineupChangeAllowed?: boolean;
  /** Shown when the roster can be viewed but the procedure does not permit changing it yet. */
  // eslint-disable-next-line react/require-default-props
  lineupChangeReason?: string;
  onSubstitute: (team: LeftOrRight, activePlayers: string[]) => void;
  /**
   * Add somebody to the roster, and say who should be on the floor afterwards.
   *
   * The two are separate decisions and are passed separately: a player added while the team is
   * already at capacity joins the bench, and `activePlayers` simply comes back unchanged.
   */
  onAddPlayer: (team: LeftOrRight, playerName: string, activePlayers: string[]) => void;
  // eslint-disable-next-line react/require-default-props
  rosterSyncStatus?: Record<string, 'synced' | 'waiting' | 'local' | 'rejected'>;
  // eslint-disable-next-line react/require-default-props
  onRequestControl?: (team: LeftOrRight, playerName: string) => void;
  /**
   * The order the room wants to see each team in, and how to change it.
   *
   * A view preference, kept out of the event history on purpose — see `PlayerSeating`. Absent means
   * the roster's own order, and no reordering controls.
   */
  // eslint-disable-next-line react/require-default-props
  seating?: Record<LeftOrRight, string[]>;
  // eslint-disable-next-line react/require-default-props
  onMovePlayer?: (team: LeftOrRight, visibleNames: string[], playerName: string, direction: -1 | 1) => void;
  /** Told which way round a one-for-one substitution went, so the replacement takes the same seat. */
  // eslint-disable-next-line react/require-default-props
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
  | { kind: 'confirm'; out?: string; incoming: string }
  | { kind: 'full' }
  | { kind: 'add' };

/** The checkbox editor, kept for halftime and for anything that is not one-for-one. */
function FullLineupEditor(props: {
  team: IDerivedTeam;
  side: LeftOrRight;
  maximumActive: number;
  seatOrder: readonly string[];
  onApply: (activePlayers: string[]) => void;
  onCancel: () => void;
}) {
  const { team, side, maximumActive, seatOrder, onApply, onCancel } = props;
  const [selected, setSelected] = useState<string[]>(team.activePlayers);
  const focusPlayerIndex = useRef<number | null>(null);

  useEffect(() => {
    if (focusPlayerIndex.current === null) return;
    document.getElementById(`scorer-lineup-${side}-${focusPlayerIndex.current}`)?.focus();
    focusPlayerIndex.current = null;
  }, [selected, side]);

  const atCapacity = selected.length >= maximumActive;
  const unchanged =
    selected.length === team.activePlayers.length && selected.every((name) => team.activePlayers.includes(name));

  const toggle = (name: string, index: number) => {
    focusPlayerIndex.current = index;
    setSelected((current) => {
      if (current.includes(name)) return current.filter((other) => other !== name);
      if (current.length >= maximumActive) return current;
      return current.concat(name);
    });
  };

  return (
    <div className="scorer-lineup-editor">
      <ul className="scorer-lineup-list">
        {orderBySeating(team.players, seatOrder, (player) => player.name).map((player, index) => {
          const id = `scorer-lineup-${side}-${index}`;
          const active = selected.includes(player.name);
          return (
            <li key={id}>
              <label className="scorer-lineup-row" htmlFor={id}>
                <input
                  id={id}
                  type="checkbox"
                  checked={active}
                  disabled={!active && atCapacity}
                  onChange={() => toggle(player.name, index)}
                />
                <span className="scorer-lineup-name">{player.name}</span>
                <span className="scorer-lineup-tuh">{player.tossupsHeard} TUH</span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="scorer-lineup-count">
        {selected.length} of {maximumActive} selected
      </p>
      <div className="scorer-lineup-actions">
        <button
          type="button"
          className="scorer-choice"
          disabled={unchanged || selected.length === 0}
          onClick={() => onApply(selected)}
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
  seatOrder: readonly string[];
  // eslint-disable-next-line react/require-default-props
  onRequestControl?: (team: LeftOrRight, playerName: string) => void;
  // eslint-disable-next-line react/require-default-props
  onMovePlayer?: (team: LeftOrRight, visibleNames: string[], playerName: string, direction: -1 | 1) => void;
  // eslint-disable-next-line react/require-default-props
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
    lineupChangeAllowed,
    seatOrder,
    onRequestControl,
    onMovePlayer,
    onSeatSubstitute,
  } = props;
  const [mode, setMode] = useState<PanelMode>({ kind: 'idle' });
  const [newPlayer, setNewPlayer] = useState('');

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
  const cleanNewPlayer = newPlayer.trim();
  const canAdd =
    cleanNewPlayer !== '' &&
    !team.players.some((player) => player.name.toLocaleLowerCase() === cleanNewPlayer.toLocaleLowerCase());

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

  const playerRow = (player: IDerivedTeam['players'][number], active: boolean, seat: number) => {
    const sync = rosterSyncStatus[rosterSyncKey(side, player.name)];
    const syncLabel = syncLabelFor(sync);
    const canMove = active && onMovePlayer !== undefined && playing.length > 1;
    return (
      <li key={player.name} className="scorer-lineup-entry">
        {/* The seat number, matching the column this player occupies on the scoring screen. */}
        <span className="scorer-lineup-seat" aria-hidden="true">
          {active ? seat + 1 : '\u2014'}
        </span>
        <span className="scorer-lineup-name">{player.name}</span>
        <span className="scorer-lineup-tuh">{player.tossupsHeard} TUH</span>
        {syncLabel && <span className="scorer-lineup-sync">{syncLabel}</span>}
        {/*
          Two buttons rather than a drag handle. This is a touchscreen a scorekeeper is using with
          one hand while the other holds a pen, and a drag that ends one row off is a mis-seat
          nobody notices until somebody buzzes.
        */}
        {canMove && (
          <span className="scorer-lineup-move">
            <button
              type="button"
              className="scorer-text-action"
              aria-label={`Move ${player.name} up`}
              disabled={seat === 0}
              onClick={() => onMovePlayer?.(side, playingNames, player.name, -1)}
            >
              &uarr;
            </button>
            <button
              type="button"
              className="scorer-text-action"
              aria-label={`Move ${player.name} down`}
              disabled={seat === playing.length - 1}
              onClick={() => onMovePlayer?.(side, playingNames, player.name, 1)}
            >
              &darr;
            </button>
          </span>
        )}
        {active ? (
          <button
            type="button"
            className="scorer-text-action"
            disabled={!lineupChangeAllowed}
            onClick={() => setMode({ kind: 'choose-replacement', out: player.name })}
          >
            Sub out
          </button>
        ) : (
          <button
            type="button"
            className="scorer-text-action"
            // At capacity there is no free seat, so coming on has to be somebody else coming off.
            // Sub out is the control that expresses that, and offering Put in here would only
            // produce a refusal.
            disabled={!lineupChangeAllowed || atCapacity}
            onClick={() => setMode({ kind: 'confirm', incoming: player.name })}
          >
            Put in
          </button>
        )}
        {sync === 'rejected' && onRequestControl && (
          <button type="button" className="scorer-text-action" onClick={() => onRequestControl(side, player.name)}>
            Request tournament control
          </button>
        )}
      </li>
    );
  };

  return (
    <section className="scorer-lineup" aria-label={`${team.name} lineup`}>
      <h3 className="scorer-lineup-team">{team.name}</h3>
      {timeoutsPerTeam > 0 && (
        <p className="scorer-team-timeout">
          {timeoutsUsed === 0 &&
            (timeoutsPerTeam === 1 ? 'Timeout available' : `${timeoutsPerTeam} timeouts available`)}
          {timeoutsUsed > 0 && timeoutsUsed === 1 && 'Timeout used'}
          {timeoutsUsed > 1 && `${timeoutsUsed} timeouts used`}
        </p>
      )}

      {mode.kind === 'idle' && (
        <>
          <h4 className="scorer-lineup-group">Playing</h4>
          <ul className="scorer-lineup-list">{playing.map((player, seat) => playerRow(player, true, seat))}</ul>
          {bench.length > 0 && (
            <>
              <h4 className="scorer-lineup-group">Bench</h4>
              <ul className="scorer-lineup-list">{bench.map((player) => playerRow(player, false, -1))}</ul>
            </>
          )}
          <p className="scorer-lineup-count">
            {team.activePlayers.length} of {maximumActive} playing
          </p>
          <div className="scorer-lineup-actions">
            <button
              type="button"
              className="scorer-text-action"
              disabled={!lineupChangeAllowed}
              onClick={() => setMode({ kind: 'full' })}
            >
              Edit full lineup…
            </button>
            <button type="button" className="scorer-text-action" onClick={() => setMode({ kind: 'add' })}>
              Add missing player…
            </button>
          </div>
        </>
      )}

      {mode.kind === 'choose-replacement' && (
        <div className="scorer-lineup-step">
          <p className="scorer-lineup-step-title">Replace {mode.out} with:</p>
          {bench.length === 0 ? (
            <p className="scorer-dialog-note">
              Everybody on the roster is already playing. Use Add missing player to bring somebody else on.
            </p>
          ) : (
            <ul className="scorer-lineup-list">
              {bench.map((player) => (
                <li key={player.name} className="scorer-lineup-entry">
                  <span className="scorer-lineup-name">{player.name}</span>
                  <span className="scorer-lineup-tuh">{player.tossupsHeard} TUH</span>
                  <button
                    type="button"
                    className="scorer-text-action"
                    onClick={() => setMode({ kind: 'confirm', out: mode.out, incoming: player.name })}
                  >
                    Put in
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
        <FullLineupEditor
          team={team}
          side={side}
          maximumActive={maximumActive}
          seatOrder={seatOrder}
          onApply={(activePlayers) => onSubstitute(side, activePlayers)}
          onCancel={() => setMode({ kind: 'idle' })}
        />
      )}

      {mode.kind === 'add' && (
        <form
          className="scorer-lineup-step scorer-add-player"
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault();
            if (!canAdd) return;
            /*
             * Two decisions, kept apart. Adding somebody to the roster is always allowed — a player
             * who turned up late exists whether or not the procedure lets them on right now — and
             * whether they also go on the floor depends on there being a seat and on the lineup
             * being changeable at this moment.
             */
            const goesOn = lineupChangeAllowed && !atCapacity;
            onAddPlayer(side, cleanNewPlayer, goesOn ? team.activePlayers.concat(cleanNewPlayer) : team.activePlayers);
          }}
        >
          <p className="scorer-lineup-step-title">Add missing player</p>
          <label htmlFor={`scorer-add-player-${side}`}>
            Player name
            <input
              id={`scorer-add-player-${side}`}
              value={newPlayer}
              maxLength={roomPlayerNameMaxLength}
              placeholder="Player name"
              onChange={(changeEvent) => setNewPlayer(changeEvent.target.value)}
            />
          </label>
          <p className="scorer-dialog-note">
            {(() => {
              if (!lineupChangeAllowed)
                return 'They will be added to the bench and can come on at the next allowed substitution.';
              if (atCapacity)
                return `${team.name} already has ${maximumActive} playing, so they join the bench. Use Sub out to bring them on.`;
              return `They will start playing from Tossup ${questionNumber}.`;
            })()}
          </p>
          <div className="scorer-lineup-actions">
            <button type="button" className="scorer-text-action" onClick={() => setMode({ kind: 'idle' })}>
              Cancel
            </button>
            <button type="submit" className="scorer-choice" disabled={!canAdd}>
              Add to roster
            </button>
          </div>
        </form>
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
    lineupChangeReason,
    onRequestControl,
    seating = { left: [], right: [] },
    onMovePlayer,
    onSeatSubstitute,
    onClose,
  } = props;

  return (
    <ScorerDialog title="Players" onClose={onClose}>
      <p className="scorer-dialog-note">
        {lineupChangeAllowed
          ? `Changes apply starting Tossup ${questionNumber}.`
          : lineupChangeReason ?? 'Lineup changes are not available at this checkpoint.'}
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
          seatOrder={seating.right}
          onRequestControl={onRequestControl}
          onMovePlayer={onMovePlayer}
          onSeatSubstitute={onSeatSubstitute}
        />
      </div>
    </ScorerDialog>
  );
}
