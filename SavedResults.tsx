/**
 * The list of games this Chromebook has finished, and how far each one has got.
 *
 * Deliberately compact and deliberately below everything else: on a normal day it says one line
 * per game and nobody looks at it. It earns its place on the day the server is down, when it is the
 * only thing that can tell a scorekeeper whether the three games they scored this morning actually
 * reached the tournament — and give them a file for the ones that didn't.
 *
 * Every completed entry offers a download, not just the failed ones. A scorekeeper asked for "the
 * file for round 4" by a director halfway across the building should not first have to make the
 * upload fail.
 */
import { IRoomResultOutboxEntry, describeDeliveryState } from './ResultOutbox';

export interface ISavedResultsProps {
  entries: IRoomResultOutboxEntry[];
  /** Used only for the download filename. */
  // eslint-disable-next-line react/require-default-props
  roomName?: string;
  onDownload: (entry: IRoomResultOutboxEntry) => void;
  /** Set when this browser has no durable storage, which changes what we are allowed to claim. */
  // eslint-disable-next-line react/require-default-props
  durable?: boolean;
  /**
   * Confirm that a stranded result reached tournament control another way.
   *
   * Offered only for a result nothing will ever deliver — the room's server was replaced, so its
   * session is gone. Without it the entry stays unresolved forever and the room cannot start its
   * next game.
   *
   * Called only after the scorekeeper has confirmed the prompt below, so a caller cannot forget to
   * ask: this is the one action that lets go of a result, and it lives on one button in one
   * component, so the confirmation belongs with the button rather than with each page.
   */
  // eslint-disable-next-line react/require-default-props
  onMarkHandedOver?: (entry: IRoomResultOutboxEntry) => void;
}

/**
 * What the scorekeeper is being asked to confirm.
 *
 * Says exactly what it does and what it does not: this device stops trying, the file stays here, and
 * nothing about it is a claim that the tournament has recorded the game.
 */
export function handOverConfirmation(entry: IRoomResultOutboxEntry): string {
  const teams = `${entry.leftTeam || 'Team 1'} vs ${entry.rightTeam || 'Team 2'}`;
  return `Confirm that tournament control has the result for ${teams}. This device will stop trying to send it, and this room will be able to start its next game. The file stays here and can still be downloaded.`;
}

function roundLabel(entry: IRoomResultOutboxEntry): string {
  // The name arrives already spelled out ("Round 4", "Finals"); only a bare number needs the word.
  if (entry.roundName && entry.roundName !== '') return entry.roundName;
  if (typeof entry.roundNumber === 'number') return `Round ${entry.roundNumber}`;
  return 'Game';
}

/** A result nothing on this device will ever manage to send. */
function isStranded(entry: IRoomResultOutboxEntry): boolean {
  return entry.retryBlocked === true && entry.deliveryState !== 'accepted' && entry.handedOver !== true;
}

export default function SavedResults({
  entries,
  roomName,
  onDownload,
  durable = true,
  onMarkHandedOver,
}: ISavedResultsProps) {
  if (entries.length === 0) return null;

  return (
    <section className="room-saved-results" aria-label="Saved results">
      <h2>Saved results</h2>
      {!durable && (
        <p className="room-saved-results-warning">
          This browser cannot save results between reloads. Download each result before closing this page.
        </p>
      )}
      <ul>
        {entries.map((entry) => (
          <li key={entry.id} className="room-saved-result">
            <div className="room-saved-result-main">
              <span className="room-saved-result-round">{roundLabel(entry)}</span>
              <span className="room-saved-result-teams">
                {entry.leftTeam || 'Team 1'} vs {entry.rightTeam || 'Team 2'}
              </span>
              <span className="room-saved-result-state">{describeDeliveryState(entry)}</span>
              {entry.lastError !== undefined && entry.deliveryState !== 'accepted' && (
                <span className="room-saved-result-detail">{entry.lastError}</span>
              )}
            </div>
            <div className="room-saved-result-actions">
              <button type="button" className="room-button room-button-secondary" onClick={() => onDownload(entry)}>
                Download QBJ
              </button>
              {onMarkHandedOver && isStranded(entry) && (
                <button
                  type="button"
                  className="room-button room-button-secondary"
                  onClick={() => {
                    // eslint-disable-next-line no-alert
                    if (window.confirm(handOverConfirmation(entry))) onMarkHandedOver(entry);
                  }}
                >
                  Tournament control has this
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="room-muted room-saved-results-note">
        {roomName ? `${roomName} · ` : ''}
        Downloaded files contain the game result only.
      </p>
    </section>
  );
}

export interface IDeliveryFailureNoticeProps {
  /** False when the result could not be written to this device at all. */
  persisted: boolean;
  /** True while the page is still retrying automatically. */
  retrying: boolean;
  /** The server's refusal when retrying has stopped. */
  // eslint-disable-next-line react/require-default-props
  reason?: string;
  onDownload: () => void;
}

/**
 * What a room sees the moment a final does not reach YellowFruit.
 *
 * The first line is the one that matters and is the one that must be true: it is only shown when
 * the result really is on the device. When persistence failed, the notice says so instead and the
 * download stops being a backup and becomes the only copy.
 */
export function DeliveryFailureNotice({ persisted, retrying, reason, onDownload }: IDeliveryFailureNoticeProps) {
  return (
    <div
      className={persisted ? 'room-banner room-banner-warning' : 'room-banner room-banner-error'}
      role={persisted ? 'status' : 'alert'}
    >
      <strong>
        {persisted ? 'Result saved on this Chromebook.' : 'This result could not be saved on this device.'}
      </strong>
      <div>{reason || 'YellowFruit is unreachable.'}</div>
      <div>
        {persisted && retrying
          ? 'This page will keep trying automatically.'
          : 'Download the file now and give it to tournament control.'}
      </div>
      <button type="button" className="room-button room-button-secondary" onClick={onDownload}>
        Download backup QBJ
      </button>
    </div>
  );
}
