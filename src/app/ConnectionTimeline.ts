/**
 * What the connection actually did, in order, with times.
 *
 * # Why a history and not just a state
 *
 * The repair behaviour in `useConnectedRuntime` is the most sophisticated thing in this application
 * and it is completely invisible when it works. A session token is refused, the room reopens the
 * session with the capability it still holds, the snapshot that was pending converges, and the word on
 * screen never stops saying "Connected". That is the correct experience for a scorekeeper mid-round
 * and it is useless to the person who has to explain, on Monday, why Room 12 looked stuck for ninety
 * seconds. One line of state cannot answer that question. Eleven lines with clock times can:
 *
 *     10:32:14  progress sent
 *     10:33:02  network unavailable
 *     10:33:09  network restored
 *     10:33:10  session reopened
 *     10:33:11  progress sent
 *
 * # What may go in it
 *
 * Nothing secret, ever. Not a room token, not a session token, not a pairing code, not a URL with
 * credentials in its query string. This buffer is designed to be exported to a file and emailed to a
 * stranger who is helping debug a tournament, so the redaction is not a courtesy — it is the reason the
 * export is safe to offer at all. Server text is passed through `redact` rather than trusted, because
 * the one thing certain about an error message from someone else's software is that nobody here decided
 * what is in it.
 *
 * # It is device-scoped and it is in memory
 *
 * Device-scoped because a Chromebook's Saturday is the unit somebody debugs, not one game. In memory
 * because a reload is a fresh start for the running application and persisting this would mean writing
 * connection metadata on a timer, forever, next to the one storage quota a room genuinely needs.
 */

/**
 * A thing worth a line in the history.
 *
 * Deliberately a closed set. A free-text event kind would eventually carry the detail somebody could
 * not be bothered to redact.
 */
export type TimelineEventKind =
  /** The latest poll succeeded. What is on screen is current. */
  | 'connected'
  /** Control answered, but not usefully. On-screen data may be stale. */
  | 'degraded'
  /** Nothing answered at all. */
  | 'offline'
  /** A snapshot of the game reached tournament control. */
  | 'progress-sent'
  /** Control refused a snapshot. */
  | 'progress-refused'
  /** The room reopened its own session after control forgot it. The invisible repair. */
  | 'session-reopened'
  /** The reopen itself failed. */
  | 'session-reopen-failed'
  /** Control stopped recognizing the room. A person has to type a code. */
  | 'room-refused'
  /** Somebody typed one, and it worked. */
  | 'room-repaired'
  /** Another device holds the writer lock. */
  | 'writer-conflict'
  /** This device took it. */
  | 'writer-taken'
  /** The finished result was accepted. */
  | 'final-sent'
  /** Control already had this exact result. The right answer to a retry. */
  | 'final-duplicate'
  /** Nothing answered; worth retrying. */
  | 'final-pending'
  /** Control refused the result. A person has to act. */
  | 'final-refused'
  /** Control moved this room on to a different game. */
  | 'reassigned'
  /** Control is running a different tournament than this game belongs to. */
  | 'tournament-switched'
  /** A roster change was pushed to control. */
  | 'roster-synced'
  /** The room asked control for something. */
  | 'control-requested'
  /** A room help POST did not reach an accepting server. */
  | 'control-request-failed'
  /** Control answered the help request but refused it. */
  | 'control-request-refused'
  /** The room's outstanding help request was withdrawn or disappeared from control. */
  | 'control-request-cleared';

export interface ITimelineEntry {
  /**
   * Monotonic within the session, and the authority on order.
   *
   * `at` is wall-clock and a Chromebook that syncs its clock mid-morning can move it *backwards*,
   * which would silently reorder a timeline sorted by time. Ordering is by this; the clock is for
   * reading.
   */
  seq: number;
  /** Epoch ms of the first occurrence in this run. */
  at: number;
  /** Epoch ms of the most recent occurrence. Equal to `at` unless `count` is above one. */
  lastAt: number;
  /** How many times this happened in a row. Keeps a busy morning readable. */
  count: number;
  kind: TimelineEventKind;
  /** Safe to show and safe to export. Always through `redact`. */
  detail?: string;
}

/**
 * How many lines are kept.
 *
 * Enough to cover a bad round in full, small enough that it is never the reason a device runs out of
 * memory. Consecutive repeats collapse into a count, so a quiet morning of successful snapshots costs
 * one line rather than nine hundred.
 */
export const timelineLimit = 240;

/** Longest a detail may be. A server that returns a stack trace does not get to fill the file. */
export const detailLimit = 200;

/**
 * Strip anything that might be a credential out of text somebody else wrote.
 *
 * Three shapes, and the order matters — URLs are cleaned before the token sweep so that a path segment
 * is not mistaken for a secret and a secret in a query string is definitely gone either way:
 *
 *   1. Any `key=value` pair whose key looks like a secret, plus ordinary `Bearer value` syntax.
 *   2. Whole query strings on anything URL-shaped, because a query string is where a token ends up when
 *      somebody is in a hurry.
 *   3. Long unbroken runs of token-ish characters, which is what a bearer token, a session id or a
 *      base64 blob looks like with the label removed.
 *
 * Over-redacting is the correct failure direction. A diagnostics file that says `[redacted]` where a
 * request id used to be is mildly annoying; one that says `Bearer eyJ…` in a support email is a room
 * somebody else can now write scores into.
 */
export function redact(text: string): string {
  const cleaned = text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /\b(token|access[_-]?token|session(?:[_-]?token)?|secret|code|key|password|auth|bearer)\b\s*[=:]\s*\S+/gi,
      '$1=[redacted]',
    )
    .replace(/(\bhttps?:\/\/[^\s?]+)\?\S*/gi, '$1?[redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
  return cleaned.length > detailLimit ? `${cleaned.slice(0, detailLimit)}…` : cleaned;
}

/** Which kinds describe the connection itself, and so are only worth recording when they change. */
const stateKinds: ReadonlySet<TimelineEventKind> = new Set<TimelineEventKind>(['connected', 'degraded', 'offline']);

export class ConnectionTimeline {
  private buffer: ITimelineEntry[] = [];

  private sequence = 0;

  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Note that something happened.
   *
   * A connection state that has not changed is dropped: the assignment poll runs every ten seconds all
   * day, and a line saying "connected" six times a minute is not a timeline, it is a reason nobody reads
   * one. Anything else is recorded, with consecutive repeats collapsed into a count.
   */
  record(kind: TimelineEventKind, detail?: string): void {
    const safe = detail === undefined || detail === '' ? undefined : redact(detail);
    const last = this.buffer[this.buffer.length - 1];

    if (stateKinds.has(kind) && this.lastState() === kind) return;

    if (last && last.kind === kind && last.detail === safe) {
      last.count += 1;
      last.lastAt = this.now();
      return;
    }

    const at = this.now();
    this.sequence += 1;
    this.buffer.push({ seq: this.sequence, at, lastAt: at, count: 1, kind, ...(safe ? { detail: safe } : {}) });
    // Oldest first out. A room debugging a problem cares about the last twenty minutes, and the
    // alternative — refusing to record once full — would silently stop the history at the moment
    // something started going wrong.
    if (this.buffer.length > timelineLimit) this.buffer.splice(0, this.buffer.length - timelineLimit);
  }

  /** The most recent connection state recorded, ignoring everything else. */
  private lastState(): TimelineEventKind | null {
    for (let index = this.buffer.length - 1; index >= 0; index -= 1) {
      const kind = this.buffer[index].kind;
      if (stateKinds.has(kind)) return kind;
    }
    return null;
  }

  /** The history, oldest first. A copy: nothing outside this class may edit it. */
  entries(): ITimelineEntry[] {
    return this.buffer.map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.buffer = [];
  }
}

/**
 * The device's history.
 *
 * A singleton because the unit anybody debugs is a device's day, not a game: the interesting sequence
 * is usually "round 4 was fine, round 5 dropped twice, round 6 could not pair" and that story spans
 * every game the Chromebook scored.
 */
export const connectionTimeline = new ConnectionTimeline();

/** The words a person reads, rather than the enum. */
export const timelineLabels: Record<TimelineEventKind, string> = {
  connected: 'connected',
  degraded: 'control answered but the room could not use it',
  offline: 'network unavailable',
  'progress-sent': 'progress sent',
  'progress-refused': 'progress refused',
  'session-reopened': 'session reopened',
  'session-reopen-failed': 'session reopen failed',
  'room-refused': 'room no longer recognized',
  'room-repaired': 'room paired again',
  'writer-conflict': 'another device holds scoring',
  'writer-taken': 'scoring taken over by this device',
  'final-sent': 'result accepted',
  'final-duplicate': 'result already on record',
  'final-pending': 'result not delivered yet',
  'final-refused': 'result refused',
  reassigned: 'moved to another game',
  'tournament-switched': 'control switched tournament',
  'roster-synced': 'roster change sent',
  'control-requested': 'tournament control asked for',
  'control-request-failed': 'tournament control request failed',
  'control-request-refused': 'tournament control request refused',
  'control-request-cleared': 'tournament control request cleared',
};

/** `10:33:09` — local time, seconds included, because the gaps that matter are seconds long. */
export function timelineClock(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** One line of the history, as a person reads it. */
export function timelineLine(entry: ITimelineEntry): string {
  const repeat = entry.count > 1 ? ` ×${entry.count}` : '';
  const detail = entry.detail ? ` — ${entry.detail}` : '';
  return `${timelineClock(entry.at)}  ${timelineLabels[entry.kind]}${repeat}${detail}`;
}
