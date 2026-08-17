/**
 * What the scorer says about the network, and what it promises about the game.
 *
 * # Every line here is a promise the room will be held to
 *
 * "It will be sent automatically" and "download the file and hand it over" are opposite
 * instructions, and a scorekeeper who is given the wrong one at the end of a round either sits
 * waiting for a delivery that is never coming or carries a USB stick to a director who already has
 * the game. So nothing in this file is written from what is likely: the reassurance is chosen from
 * whether this browser accepted the last local write, whether a snapshot has ever reached the
 * server, and whether the finished result has a session behind it to be delivered through.
 *
 * # And nothing here is a dashboard
 *
 * The ordinary scoring screen shows one word about the connection. The detail — when the game was
 * last saved, when the server last heard from it, what will happen to the result — is one dialog
 * behind that word, because a room in the middle of a round needs the tossup buttons, not
 * telemetry. A failure that genuinely changes what the scorekeeper should do gets a banner; the
 * rest waits to be asked for.
 */
import { RoomConnectionState } from '../app/ConnectionState';
import { ITimelineEntry, timelineLine } from '../app/ConnectionTimeline';
import { buildLabel } from '../pwa/BuildVersion';
import ScorerDialog from './ScorerDialog';

/** One thing the room needs to tell the scorekeeper about, with what they can do about it. */
export interface IScorerAlert {
  /** Stable identity, so a repeated poll does not restack the same warning. */
  id: string;
  tone: 'info' | 'warning' | 'error';
  title: string;
  body?: string;
  actions?: { label: string; onSelect: () => void }[];
  /**
   * Offer the scorer's own QBJ download alongside this alert.
   *
   * A flag rather than an action because the room does not hold the game: the live QBJ belongs to
   * the scorer, and the room asking for "the current game" would be asking for a copy that is one
   * throttled snapshot out of date.
   */
  offerDownload?: boolean;
}

/** Where this game currently exists, as facts rather than as reassurance. */
export interface IScorerRecoveryStatus {
  /** False when this browser refused the last write of the game. */
  localSaveOk: boolean;
  /** Whether the complete game record survives closing and reopening this tab. */
  recordDurablyStored?: boolean;
  /** Epoch ms of the last accepted local write, or null if there has never been one. */
  localSavedAt?: number | null;
  /** Epoch ms of the last snapshot the server accepted. Null means one has never been sent. */
  serverSnapshotAt?: number | null;
  /** What the server said about the last snapshot attempt, when it refused one. */
  snapshotError?: string;
  /**
   * Whether a finished result from this game can be delivered without a human carrying it.
   *
   * False for emergency scoring, which has no session, and for a result tournament control has
   * permanently refused. The offline copy changes completely on this, so it is never assumed.
   */
  automaticDelivery?: boolean;
  /**
   * Whether there is tournament control behind this game at all.
   *
   * A different question from `automaticDelivery`, which is about whether a result can travel on its
   * own: emergency scoring has a server and no delivery, and a file game has neither. It matters
   * here because a row reading "Server snapshot — Not yet sent", in the colour this dialog uses for
   * problems, is a report of a failure. For a game opened from a file or typed in by hand there is
   * no server and never was one, so nothing failed, and a scorekeeper sent looking for the fault
   * would be looking for something that does not exist.
   *
   * Defaults to true, because every caller that has a session says nothing and should keep the row.
   */
  tournamentControl?: boolean;
  /** Where the finished result has got to, once there is one. */
  delivery?: 'in-progress' | 'waiting' | 'sent' | 'accepted' | 'hand-over';
}

/** "just now", "7 sec ago", "3 min ago" — short enough to sit in a two-column detail row. */
export function describeAge(at: number | null | undefined, now: number): string {
  if (at === null || at === undefined) return 'Not yet';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr ago`;
}

export function connectionLabel(connection: RoomConnectionState): string {
  if (connection === RoomConnectionState.Connected) return 'Connected';
  if (connection === RoomConnectionState.Offline) return 'Offline';
  return 'Connection issue';
}

export function connectionClass(connection: RoomConnectionState): string {
  if (connection === RoomConnectionState.Connected) return 'scorer-conn is-ok';
  if (connection === RoomConnectionState.Offline) return 'scorer-conn is-offline';
  return 'scorer-conn is-degraded';
}

/**
 * The second sentence of the offline banner.
 *
 * Three cases, and the difference between them is the difference between a scorekeeper who can go
 * home and one who has to find the director.
 */
export function offlineBody(recovery: IScorerRecoveryStatus): string {
  if (recovery.recordDurablyStored === false) {
    return 'This game is temporary in this tab. Download a QBJ backup now and again when the game ends; do not close or reload this tab.';
  }
  if (!recovery.localSaveOk) {
    return 'This browser could not save the game. Download a QBJ backup now and again when the game ends.';
  }
  if (recovery.automaticDelivery === false) {
    return 'This game is saved on this Chromebook, but it will not be sent on its own. Download the QBJ when the game ends and give it to tournament control.';
  }
  return 'This game is saved on this Chromebook and will retry automatically. If tournament control is still unreachable when the game ends, download the QBJ and give it to tournament control.';
}

/**
 * The banner strip above the scoring controls.
 *
 * Ordered by what a scorekeeper has to act on: a browser that cannot save the game is the only
 * thing here that can cost the room questions it has already scored, so it goes first regardless of
 * what the network is doing.
 */
export default function ScorerBanners(props: {
  connection: RoomConnectionState;
  recovery: IScorerRecoveryStatus;
  alerts: IScorerAlert[];
  degradedMessage?: string;
  onDownload: () => void;
}) {
  const { connection, recovery, alerts, degradedMessage, onDownload } = props;
  const recordDurablyStored = recovery.recordDurablyStored !== false;
  return (
    <>
      {!recordDurablyStored && (
        <div className="scorer-banner is-error" role="alert">
          <strong>Temporary — do not close this tab.</strong>
          <span>
            The complete game record is not currently durable on this device. Download a QBJ backup now and again
            when the game ends.
          </span>
          <button type="button" className="scorer-text-action" onClick={onDownload}>
            Download QBJ backup
          </button>
        </div>
      )}
      {!recovery.localSaveOk && (
        <div className="scorer-banner is-error" role="alert">
          <strong>Event journal save failed — do not reload or close this tab.</strong>
          <span>
            The game currently exists only on this screen. Download a QBJ backup now and again when the game ends.
          </span>
          <button type="button" className="scorer-text-action" onClick={onDownload}>
            Download QBJ backup
          </button>
        </div>
      )}
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className={`scorer-banner is-${alert.tone}`}
          role={alert.tone === 'info' ? undefined : 'alert'}
        >
          <strong>{alert.title}</strong>
          {alert.body && <span>{alert.body}</span>}
          {alert.actions?.map((action) => (
            <button key={action.label} type="button" className="scorer-text-action" onClick={action.onSelect}>
              {action.label}
            </button>
          ))}
          {alert.offerDownload && (
            <button type="button" className="scorer-text-action" onClick={onDownload}>
              Download QBJ backup
            </button>
          )}
        </div>
      ))}
      {connection === RoomConnectionState.Offline && recovery.localSaveOk && (
        <div className="scorer-banner is-warning">
          <strong>Offline — keep scoring.</strong>
          <span>{offlineBody(recovery)}</span>
          <button type="button" className="scorer-text-action" onClick={onDownload}>
            Download QBJ backup
          </button>
        </div>
      )}
      {connection !== RoomConnectionState.Offline && degradedMessage && (
        <p className="scorer-banner is-warning">{degradedMessage}</p>
      )}
    </>
  );
}

function DetailRow(props: { label: string; value: string; problem?: boolean }) {
  const { label, value, problem = false } = props;
  return (
    <div className={problem ? 'scorer-detail-row is-problem' : 'scorer-detail-row'}>
      <span className="scorer-detail-label">{label}</span>
      <span className="scorer-detail-value">{value}</span>
    </div>
  );
}

/** How the finished result is travelling, said only where it is actually known. */
function deliveryValue(recovery: IScorerRecoveryStatus): string {
  if (recovery.delivery === 'accepted') return 'Accepted';
  if (recovery.delivery === 'sent') return 'Sent to tournament control';
  if (recovery.delivery === 'waiting') return 'Waiting';
  if (recovery.delivery === 'hand-over') return 'Hand the QBJ over';
  return recovery.automaticDelivery === false ? 'Not automatic' : 'When the game ends';
}

/**
 * What the connection did, most recent first.
 *
 * Newest at the top because the question being asked is always "what just happened", and a scorekeeper
 * who has opened this mid-round should not have to scroll a morning of successful snapshots to find the
 * two lines from ninety seconds ago. Capped on screen for the same reason; the whole history goes into
 * the diagnostics file, which is read by somebody sitting down.
 */
export function ConnectionTimelineList(props: { entries: ITimelineEntry[]; limit?: number }) {
  const { entries, limit = 12 } = props;
  if (entries.length === 0) return null;
  const shown = [...entries].sort((first, second) => second.seq - first.seq).slice(0, limit);
  return (
    <div className="scorer-timeline">
      <p className="scorer-timeline-heading">Recent connection activity</p>
      <ol className="scorer-timeline-list">
        {shown.map((entry) => (
          <li key={entry.seq} className="scorer-timeline-row">
            {timelineLine(entry)}
          </li>
        ))}
      </ol>
      {entries.length > shown.length && (
        <p className="scorer-timeline-more">
          {entries.length - shown.length} earlier {entries.length - shown.length === 1 ? 'entry' : 'entries'} are in
          the downloadable diagnostics.
        </p>
      )}
    </div>
  );
}

/** The detail behind the connection word. Opened deliberately, never on screen by itself. */
export function ConnectionDetailDialog(props: {
  connection: RoomConnectionState;
  recovery: IScorerRecoveryStatus;
  now: number;
  /** The word the header is showing, when the game's standing is not a network fact. See `Scorer`. */
  statusLabel?: string;
  /** The connection history. Passed in rather than read from the singleton so this stays renderable. */
  timeline?: ITimelineEntry[];
  onDownload: () => void;
  onClose: () => void;
}) {
  const { connection, recovery, now, statusLabel, timeline = [], onDownload, onClose } = props;
  const recordDurablyStored = recovery.recordDurablyStored !== false;
  const tournamentControl = recovery.tournamentControl !== false;
  return (
    <ScorerDialog title="Connection" onClose={onClose}>
      {/* The same word as the header pill, and for the same reason: a dialog that says "Connected"
          under a header that says "Practice" is two answers to one question. */}
      <p className={connectionClass(connection)}>
        <span className="scorer-dot" aria-hidden="true" />
        {statusLabel ?? connectionLabel(connection)}
      </p>
      <div className="scorer-detail-rows">
        <DetailRow
          label="Event journal"
          value={recovery.localSaveOk ? describeAge(recovery.localSavedAt, now) : 'FAILED'}
          problem={!recovery.localSaveOk}
        />
        <DetailRow
          label="Game record"
          value={recordDurablyStored ? 'Durable' : 'Temporary'}
          problem={!recordDurablyStored}
        />
        {tournamentControl ? (
          <DetailRow
            label="Server snapshot"
            value={
              recovery.serverSnapshotAt === null || recovery.serverSnapshotAt === undefined
                ? 'Not yet sent'
                : describeAge(recovery.serverSnapshotAt, now)
            }
            problem={recovery.serverSnapshotAt === null || recovery.serverSnapshotAt === undefined}
          />
        ) : (
          <DetailRow label="Tournament control" value="None for this game" />
        )}
        <DetailRow label="Automatic delivery" value={deliveryValue(recovery)} />
        {/* Last, because it is the only row here that is not about this game — and present at all
            because the first question about a room that is misbehaving is whether it is running the
            same build as the rooms that are not. */}
        <DetailRow label="App version" value={buildLabel()} />
      </div>
      {recovery.snapshotError && <p className="scorer-dialog-note">{recovery.snapshotError}</p>}
      <ConnectionTimelineList entries={timeline} />
      <div className="scorer-complete-actions">
        <button type="button" className="scorer-action" onClick={onDownload}>
          Download QBJ backup
        </button>
      </div>
    </ScorerDialog>
  );
}
