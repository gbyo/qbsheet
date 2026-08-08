/**
 * Which game this browser is in the middle of, and everything it needs to reopen it alone.
 *
 * # The problem this solves
 *
 * The scored questions were already safe: `GameSession` writes the whole event list to localStorage
 * after every action, filed under the session id. What was not safe was *finding* it again. The
 * session id arrives in the assignment response, so a Chromebook that reloaded while the server was
 * unreachable had a perfectly intact game on disk and no idea which key it was under. It sat on
 * "Connecting to YellowFruit…" until tournament control came back — which is exactly the moment a
 * scorekeeper needs the questions they already scored.
 *
 * So this record is the index: one small entry naming the game in progress, the frozen context it
 * started with, and the credentials to resume talking to the server about it.
 *
 * # Why credentials belong here and nowhere else
 *
 * This never leaves browser storage. It is not exported, not attached to QBJ, not put in the
 * outbox, not rendered as text. That is the whole distinction from `GameSession`, which is written
 * to be handed around — downloaded, emailed, imported — and therefore must never carry a capability
 * token. Keeping the two apart means a reload can re-authenticate without a game file ever being a
 * credential.
 *
 * # Why it is not cleared eagerly
 *
 * A missing server, a 403, a poll that disagrees, a renderer that restarted: none of those mean the
 * game is over, and all of them used to be treated as though they did. This is retired when the
 * result has reached the outbox, when tournament control has accepted it, or when a human says so —
 * and otherwise it stays, because a stale local backup costs a confirmation click and a lost one
 * costs a played game.
 */
import { IRoomMatchup } from '../main/server/ServerTypes';
import { IScorekeeperFormat } from '../renderer/Services/ScorekeeperFormat';
import { IRoomProcedure } from '../renderer/Services/RoomProcedure';

/** Bumped when the stored shape changes. An unrecognized version is treated as no record. */
export const activeRoomGameVersion = 1;

const storageKey = `yellowfruit.room.active-game.v${activeRoomGameVersion}`;

/**
 * The game this browser is scoring, as this browser knows it.
 *
 * Everything here is what the *server said when the game started*. It is deliberately frozen: a
 * game whose roster changed underneath its recorded substitutions would produce tossups-heard for
 * players who were never on the floor.
 */
export interface IActiveRoomGame {
  version: number;

  /** The room this browser is. A record for another room is ignored rather than adopted. */
  roomId: string;
  /** The tournament the server confirmed when the game started, when it had confirmed one. */
  tournamentKey?: string;
  scheduledMatchId?: string;

  sessionId: string;
  /**
   * The session capability token.
   *
   * Safe here and only here: this object is never exported, downloaded or displayed. See the file
   * comment.
   */
  sessionToken: string;

  tournamentName: string;
  roomName?: string;
  roundNumber?: number;
  roundName: string;
  packetName?: string;

  /** The matchup exactly as it was handed to the scorer, rosters included. */
  matchup: IRoomMatchup;
  scoringFormat: IScorekeeperFormat;
  roomProcedure?: IRoomProcedure;

  /** ISO 8601 */
  startedAt: string;
  /** ISO 8601. Refreshed as scoring progresses so an abandoned record ages out. */
  updatedAt: string;
}

/**
 * How stale a record may be and still reopen a game.
 *
 * The same day-and-a-half window `GameSession` uses, for the same reason: past that, a record is
 * far more likely to be last weekend's leftovers than the game this room is playing.
 */
export const activeRoomGameMaxAgeMs = 36 * 60 * 60 * 1000;

interface IStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): IStorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function validTeam(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const team = value as Record<string, unknown>;
  if (typeof team.name !== 'string' || team.name.trim() === '') return false;
  if (!Array.isArray(team.players)) return false;
  return team.players.every(
    (player) => typeof player === 'object' && player !== null && typeof (player as any).name === 'string',
  );
}

function validMatchup(value: unknown): value is IRoomMatchup {
  if (typeof value !== 'object' || value === null) return false;
  const matchup = value as Record<string, unknown>;
  if (typeof matchup.scheduledMatchId !== 'string') return false;
  if (typeof matchup.roundName !== 'string') return false;
  return validTeam(matchup.leftTeam) && validTeam(matchup.rightTeam);
}

/**
 * Is this a scoring format the scorer can actually be handed?
 *
 * Only the structural minimum. `scorekeeperFormatProblems` is the real gate and runs where the
 * format is used; this exists so a truncated or half-written record is treated as no record instead
 * of crashing the page that reads it.
 */
function validFormat(value: unknown): value is IScorekeeperFormat {
  if (typeof value !== 'object' || value === null) return false;
  const format = value as Record<string, any>;
  return (
    Array.isArray(format.answerTypes) &&
    format.answerTypes.length > 0 &&
    typeof format.regulation?.tossupCount === 'number' &&
    typeof format.players?.maximumActive === 'number'
  );
}

/** What a caller has to agree with before a stored record is offered back. */
export interface IActiveGameExpectation {
  roomId: string;
  /**
   * The tournament the page has confirmed, when it has confirmed one.
   *
   * Left undefined while offline on purpose: a browser that cannot reach the server has no way to
   * confirm the tournament, and refusing to reopen the game for want of a confirmation it cannot
   * obtain is the failure this whole file exists to prevent.
   */
  tournamentKey?: string;
}

/**
 * Read the game this browser was scoring, if there still is one it may reopen.
 *
 * Returns null for anything unrecognizable rather than throwing. A corrupt record is the same as no
 * record: the room falls back to asking the server, which is slower but never wrong.
 */
export function readActiveGame(
  expected: IActiveGameExpectation,
  now: Date = new Date(),
  storage: IStorageLike | null = browserStorage(),
): IActiveRoomGame | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IActiveRoomGame>;
    if (parsed?.version !== activeRoomGameVersion) return null;
    if (typeof parsed.roomId !== 'string' || parsed.roomId !== expected.roomId) return null;
    if (typeof parsed.sessionId !== 'string' || parsed.sessionId === '') return null;
    if (typeof parsed.sessionToken !== 'string' || parsed.sessionToken === '') return null;
    if (typeof parsed.tournamentName !== 'string') return null;
    if (typeof parsed.roundName !== 'string') return null;
    if (!validMatchup(parsed.matchup)) return null;
    if (!validFormat(parsed.scoringFormat)) return null;
    if (typeof parsed.startedAt !== 'string' || typeof parsed.updatedAt !== 'string') return null;

    // A record from a different tournament is somebody else's game. Only checked when the caller
    // actually knows which tournament this is — see `IActiveGameExpectation.tournamentKey`.
    if (
      expected.tournamentKey !== undefined &&
      parsed.tournamentKey !== undefined &&
      parsed.tournamentKey !== expected.tournamentKey
    ) {
      return null;
    }

    const updated = new Date(parsed.updatedAt).getTime();
    if (!Number.isFinite(updated)) return null;
    const age = now.getTime() - updated;
    if (age < 0 || age > activeRoomGameMaxAgeMs) return null;

    return {
      version: activeRoomGameVersion,
      roomId: parsed.roomId,
      tournamentKey: typeof parsed.tournamentKey === 'string' ? parsed.tournamentKey : undefined,
      scheduledMatchId: typeof parsed.scheduledMatchId === 'string' ? parsed.scheduledMatchId : undefined,
      sessionId: parsed.sessionId,
      sessionToken: parsed.sessionToken,
      tournamentName: parsed.tournamentName,
      roomName: typeof parsed.roomName === 'string' ? parsed.roomName : undefined,
      roundNumber: typeof parsed.roundNumber === 'number' ? parsed.roundNumber : undefined,
      roundName: parsed.roundName,
      packetName: typeof parsed.packetName === 'string' ? parsed.packetName : undefined,
      matchup: parsed.matchup,
      scoringFormat: parsed.scoringFormat,
      roomProcedure: parsed.roomProcedure,
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Record, or re-record, the game in progress.
 *
 * @returns false when this browser refused the write, so the page can say the game is only on
 * screen rather than promising a recovery that will not happen.
 */
export function writeActiveGame(
  record: Omit<IActiveRoomGame, 'version' | 'updatedAt'> & { updatedAt?: string },
  now: Date = new Date(),
  storage: IStorageLike | null = browserStorage(),
): boolean {
  if (!storage || record.roomId === '' || record.sessionId === '') return false;
  const stored: IActiveRoomGame = {
    ...record,
    version: activeRoomGameVersion,
    updatedAt: record.updatedAt ?? now.toISOString(),
  };
  try {
    storage.setItem(storageKey, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

/** Push the record's age forward without rewriting the frozen context. */
export function touchActiveGame(
  sessionId: string,
  now: Date = new Date(),
  storage: IStorageLike | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Partial<IActiveRoomGame>;
    if (parsed?.version !== activeRoomGameVersion || parsed.sessionId !== sessionId) return false;
    storage.setItem(storageKey, JSON.stringify({ ...parsed, updatedAt: now.toISOString() }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Retire the record for one game.
 *
 * Scoped to a session id on purpose: a stale clear arriving after the next game has already started
 * would leave that game unrecoverable, which is the exact failure this file exists to prevent.
 */
export function clearActiveGame(sessionId?: string, storage: IStorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    if (sessionId !== undefined) {
      const raw = storage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<IActiveRoomGame>;
        if (parsed?.sessionId !== undefined && parsed.sessionId !== sessionId) return;
      }
    }
    storage.removeItem(storageKey);
  } catch {
    // The age check is the backstop.
  }
}
