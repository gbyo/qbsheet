/**
 * How a room browser reads what the server told it.
 *
 * Two questions get confused with each other unless they are kept apart deliberately:
 *
 *   1. Can this browser reach YellowFruit?  — a transport question
 *   2. What is this room's game doing?      — a tournament question
 *
 * A room whose final is waiting on tournament control, a room whose round has not been released, a
 * room that is on hold: all of these are working rooms having an ordinary tournament day, and all of
 * them must read as connected. Only an unreachable server is offline. Keeping the two apart here,
 * as pure functions over the response, means the polling component never has to decide it by
 * inspecting error strings, and means the rules are testable without a browser.
 */
import {
  IRoomAssignmentResponse,
  IRoomJoinListResponse,
  IRoomLifecycleOutcome,
  RoomBlockedReason,
  SessionStatus,
} from '../main/server/ServerTypes';
import { ApiResult } from './api';

/**
 * How well the room can currently talk to YellowFruit.
 *
 * Three states rather than two, because "reachable" and "up to date" are not the same thing. A room
 * whose last assignment poll came back 500 is still talking to a server that is plainly there — but
 * what it is showing on screen is no longer known to be current, and saying "Connected" about that
 * is a lie the scorekeeper has no way to catch.
 */
export enum RoomConnectionState {
  /** The latest assignment poll succeeded. What is on screen is current. */
  Connected = 'connected',
  /** YellowFruit answered, but the latest assignment poll failed. On-screen data may be stale. */
  Degraded = 'degraded',
  /** No answer at all: dropped Wi-Fi, refused connection, or our own timeout. */
  Offline = 'offline',
}

/** What one poll of the assignment endpoint says about the connection itself. */
export interface IRoomTransportState {
  /** The effective connection state, which is what the room's status indicator shows. */
  connection: RoomConnectionState;
  /**
   * True when YellowFruit answered at all.
   *
   * Any HTTP status means the server is there and talking, so the room is reachable even when the
   * answer is a refusal. Only an aborted or failed request — no status at all — is offline.
   */
  online: boolean;
  /** The room's credentials are not valid for the open tournament; it has to pair again. */
  needsPairing: boolean;
  /** Set when the server answered with something the room should show. Empty on success. */
  errorMessage: string;
  /** YellowFruit's own explanation, when it gave one. Never our status-code fallback text. */
  serverDetail: string;
}

/** Decide connection state from a poll result without looking at any message text. */
export function classifyPollResult(result: ApiResult<unknown>): IRoomTransportState {
  if (result.ok) {
    return {
      connection: RoomConnectionState.Connected,
      online: true,
      needsPairing: false,
      errorMessage: '',
      serverDetail: '',
    };
  }
  const serverDetail = result.detail ?? '';
  // No status means fetch never got an answer: DNS, refused connection, dropped Wi-Fi, or our own
  // timeout abort. That, and only that, is what "offline" means to a scorekeeper.
  if (result.status === undefined) {
    return {
      connection: RoomConnectionState.Offline,
      online: false,
      needsPairing: false,
      errorMessage: result.error,
      serverDetail,
    };
  }
  // The room link itself is wrong for the open tournament. That is a credential problem, not a
  // connection problem, and it is resolved by pairing again rather than by retrying.
  if (result.status === 403) {
    return {
      connection: RoomConnectionState.Connected,
      online: true,
      needsPairing: true,
      errorMessage: result.error,
      serverDetail,
    };
  }
  return {
    connection: RoomConnectionState.Degraded,
    online: true,
    needsPairing: false,
    errorMessage: result.error,
    serverDetail,
  };
}

/** The room's connection status as the page should present it after one poll. */
export interface IRoomConnectionStatus {
  state: RoomConnectionState;
  needsPairing: boolean;
  /**
   * Shown beside a matchup the room is still displaying but could not refresh. Empty unless the
   * room is degraded and has something retained to be stale about.
   */
  degradedMessage: string;
  /** Shown instead of a matchup, for a room that has never managed to load one. Empty otherwise. */
  loadError: string;
}

/** The one sentence a degraded room shows. Not an error: nothing is lost and retrying is automatic. */
export const degradedHeadline = 'YellowFruit couldn’t refresh this room.';

/**
 * Fold one assignment poll into the status the page should show.
 *
 * The retained assignment is the whole reason this is not just `classifyPollResult`. Before the
 * first success there is nothing on screen to go stale, so a failure is a load error and belongs
 * where the matchup would have been. After the first success the matchup stays up — a Chromebook
 * that has lost touch with the control room mid-round must still be able to see what it is playing —
 * and the honest thing to add is a note that it is no longer being refreshed, not a replacement
 * error page.
 *
 * Recovery needs no user action and no separate call: the next successful poll produces Connected
 * with both messages empty, which is what clears the warning.
 */
export function reduceConnectionStatus(result: ApiResult<unknown>, hasAssignment: boolean): IRoomConnectionStatus {
  const transport = classifyPollResult(result);
  const status: IRoomConnectionStatus = {
    state: transport.connection,
    needsPairing: transport.needsPairing,
    degradedMessage: '',
    loadError: '',
  };
  if (transport.connection === RoomConnectionState.Connected) return status;

  if (!hasAssignment) {
    status.loadError = transport.errorMessage;
    return status;
  }
  // Offline already has its own retained-assignment messaging, which says the right thing about
  // local scoring and the submission queue. Only the degraded case needs a new note.
  if (transport.connection === RoomConnectionState.Degraded) {
    status.degradedMessage =
      transport.serverDetail === '' ? degradedHeadline : `${degradedHeadline} ${transport.serverDetail}`;
  }
  return status;
}

/** The scorekeeper-facing name for a connection state. Never a status code. */
export function describeConnection(state: RoomConnectionState): string {
  if (state === RoomConnectionState.Connected) return 'Connected';
  if (state === RoomConnectionState.Degraded) return 'Connection issue';
  return 'Offline';
}

/** The status-indicator class for a connection state. */
export function connectionStatusClass(state: RoomConnectionState): string {
  if (state === RoomConnectionState.Connected) return 'room-status room-status-online';
  if (state === RoomConnectionState.Degraded) return 'room-status room-status-degraded';
  return 'room-status room-status-offline';
}

/**
 * Should the bare server address open the pairing screen rather than manual scoring?
 *
 * Only when this tournament is genuinely running browser room scoring and has a room to pair with.
 * A traditional tournament, a tournament with no rooms configured, and a server that could not
 * answer all land on manual scoring, which needs neither a room nor a code. Both workflows stay
 * reachable whichever way this goes — this only decides which one appears first.
 */
export function shouldOfferPairing(result: ApiResult<IRoomJoinListResponse>): boolean {
  if (!result.ok) return false;
  return result.value.roomScoringMode === 'browser' && result.value.rooms.length > 0;
}

/**
 * Is this room's current game sitting with tournament control?
 *
 * Derived from structured lifecycle fields rather than from the presence of an error, so it stays
 * true across a reload: the resumable session's status is what the server persists.
 */
export function isAwaitingReview(assignment: IRoomAssignmentResponse | null): boolean {
  if (!assignment) return false;
  if (assignment.session?.status === SessionStatus.Submitted) return true;
  if (assignment.session?.finalReceived === true) return true;
  return assignment.blockedReason === RoomBlockedReason.Submitted;
}

/** A lifecycle message, kept with the identity of the game it is about. */
export interface ILifecycleNotice {
  scheduledMatchId: string;
  status: SessionStatus.Accepted | SessionStatus.Rejected;
  text: string;
}

function noticeText(outcome: IRoomLifecycleOutcome): string {
  if (outcome.status === SessionStatus.Accepted) {
    return 'Result accepted. Waiting for the next assignment…';
  }
  const reason = outcome.rejectionReason?.trim();
  return reason
    ? `Result needs correction. Tournament control: “${reason}”`
    : 'Result needs correction. Check with tournament control.';
}

/**
 * Work out which lifecycle notice, if any, this room should still be showing.
 *
 * Notices are owned by a specific scheduled game and expire with it, which is the whole reason
 * `lastOutcome` carries an id. The two verdicts age differently:
 *
 * - Accepted is a courtesy note for the gap between finishing one game and being handed the next.
 *   Once a *different* game is current, round 4's acceptance is no longer what the room needs to be
 *   looking at, and continuing to show it buries the round 5 matchup under stale good news.
 * - Rejected is not a courtesy note. The same game has to be corrected and sent again, so the reason
 *   stays on screen for as long as that game is the room's current one — and disappears the moment
 *   the correction is under review, because at that point the room is waiting, not fixing.
 */
export function resolveLifecycleNotice(assignment: IRoomAssignmentResponse | null): ILifecycleNotice | null {
  const outcome = assignment?.lastOutcome;
  if (!assignment || !outcome || !outcome.scheduledMatchId) return null;

  const currentId = assignment.current?.scheduledMatchId ?? null;
  const notice: ILifecycleNotice = {
    scheduledMatchId: outcome.scheduledMatchId,
    status: outcome.status,
    text: noticeText(outcome),
  };

  if (outcome.status === SessionStatus.Accepted) {
    // Nothing else to look at yet, or the accepted game is somehow still current: keep the note.
    return currentId === null || currentId === outcome.scheduledMatchId ? notice : null;
  }

  // Rejected. Only relevant while the room is still holding that same game.
  if (currentId !== outcome.scheduledMatchId) return null;
  // A resubmission has already gone in, so the room is back to waiting on control rather than to
  // correcting. The awaiting-review state says that more accurately than a stale rejection does.
  if (isAwaitingReview(assignment)) return null;
  return notice;
}
