/**
 * What the scoresheet is allowed to claim about tournament control.
 *
 * Three states rather than a boolean, because "the server answered" and "what is on screen is
 * current" are different facts and a scorekeeper deciding whether to trust the header needs the
 * difference. A poll that fails against a server that is plainly there — a refusal, a 500 — means
 * the room can no longer prove the assignment on screen is the current one, and saying "Connected"
 * about that is a claim we cannot back.
 *
 * A game scored from a file has no tournament control at all and is not in any of these states; see
 * `ConnectionSummary`.
 *
 * Extracted from `RoomConnectionState` in YellowFruit's room lifecycle.
 */
export enum RoomConnectionState {
  /** The latest poll succeeded. What is on screen is current. */
  Connected = 'connected',
  /** Control answered, but the latest poll failed. On-screen data may be stale. */
  Degraded = 'degraded',
  /** No answer at all: dropped Wi-Fi, refused connection, or our own timeout. */
  Offline = 'offline',
}
