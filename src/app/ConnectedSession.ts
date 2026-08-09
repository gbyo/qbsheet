/**
 * The credentials a connected room holds, and the one place they live.
 *
 * # Why these are not in the game package or the game record
 *
 * A game package is a file that gets emailed around. A game record contains the QBJ that gets
 * downloaded. Neither is a place for a capability token, and the way to guarantee a token never
 * reaches either is for neither to have a field for one. So the connection lives here, in browser
 * storage that is never exported, never attached to a result, and never rendered as text.
 *
 * The link between the two runs the other way: a connection names the game record it belongs to.
 * That way losing the connection loses nothing — the game is still there, still scoreable, still
 * downloadable — while losing the game correctly leaves a connection pointing at nothing, which is
 * cleared on the next read.
 *
 * # Why the address is remembered at all
 *
 * Because a Chromebook that reloads mid-round should not put a scorekeeper in front of a text box
 * asking for an IP address they saw once, on a projector, forty minutes ago. Remembering it costs
 * nothing; the tokens are the sensitive part and they are the same tokens the room already had.
 */

export const connectionStorageKey = 'standalone-scorekeeper.connection.v1';
export const connectionVersion = 1;

/**
 * How stale a remembered connection may be.
 *
 * A tournament is a day. A token from last weekend is not going to work, and offering it is worse
 * than asking again: it produces an authorization failure at the moment a room is trying to start.
 */
export const connectionMaxAgeMs = 36 * 60 * 60 * 1000;

export interface IConnectedSession {
  version: number;
  /** Normalized, no trailing slash. See `normalizeBaseUrl`. */
  baseUrl: string;
  roomId: string;
  roomName: string;
  /** Room capability token. Never rendered, never exported. */
  roomToken: string;
  /** A stable per-browser label for presence. Descriptive only; carries no authority. */
  deviceId: string;
  /** Set once a game has been started, so a reload resumes the same session. */
  sessionId?: string;
  sessionToken?: string;
  /** The local game record this connection belongs to. */
  gameRecordId?: string;
  /** Which tournament this was paired against, so a server that has opened another is detectable. */
  tournamentKey?: string;
  /** ISO 8601 */
  updatedAt: string;
}

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

export function readConnection(
  now: Date = new Date(),
  storage: IStorageLike | null = browserStorage(),
): IConnectedSession | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(connectionStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IConnectedSession>;
    if (parsed?.version !== connectionVersion) return null;
    if (typeof parsed.baseUrl !== 'string' || parsed.baseUrl === '') return null;
    if (typeof parsed.roomId !== 'string' || typeof parsed.roomToken !== 'string') return null;
    if (parsed.roomId === '' || parsed.roomToken === '') return null;
    if (typeof parsed.updatedAt !== 'string') return null;
    const updated = new Date(parsed.updatedAt).getTime();
    if (!Number.isFinite(updated)) return null;
    const age = now.getTime() - updated;
    if (age < 0 || age > connectionMaxAgeMs) return null;
    return {
      version: connectionVersion,
      baseUrl: parsed.baseUrl,
      roomId: parsed.roomId,
      roomName: typeof parsed.roomName === 'string' ? parsed.roomName : parsed.roomId,
      roomToken: parsed.roomToken,
      deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : newDeviceId(),
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
      sessionToken: typeof parsed.sessionToken === 'string' ? parsed.sessionToken : undefined,
      gameRecordId: typeof parsed.gameRecordId === 'string' ? parsed.gameRecordId : undefined,
      tournamentKey: typeof parsed.tournamentKey === 'string' ? parsed.tournamentKey : undefined,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

export function writeConnection(
  session: Omit<IConnectedSession, 'version' | 'updatedAt'>,
  now: Date = new Date(),
  storage: IStorageLike | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      connectionStorageKey,
      JSON.stringify({ ...session, version: connectionVersion, updatedAt: now.toISOString() }),
    );
    return true;
  } catch {
    // A room with no storage can still score the game in front of it; it just cannot resume one.
    return false;
  }
}

export function clearConnection(storage: IStorageLike | null = browserStorage()): void {
  try {
    storage?.removeItem(connectionStorageKey);
  } catch {
    // The age check is the backstop.
  }
}

/** A stable per-browser label. Descriptive only — it authorizes nothing. */
export function newDeviceId(): string {
  const bytes = new Uint8Array(12);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  }
  return `device-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
