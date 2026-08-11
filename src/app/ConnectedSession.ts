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

export const connectionStorageKey = 'qbsheet.connection.v1';
/** Read-only compatibility for a connection saved by the temporary pre-QBSheet build. */
const legacyConnectionStorageKey = 'standalone-scorekeeper.connection.v1';
export const connectionVersion = 1;

/**
 * Remembered room credentials do not expire on the client.
 *
 * Tournament control remains the authority: a revoked or stale token is rejected by the server and
 * the room is offered connection repair. An arbitrary browser-side timeout is worse because it can
 * discard otherwise-valid credentials during a long tournament or after a device has been offline.
 * Keep this exported value for compatibility with consumers that used it as a policy hint.
 */
export const connectionMaxAgeMs = Number.POSITIVE_INFINITY;

/**
 * A room this device is paired with, independent of any game.
 *
 * The unit that survives a round. Pairing produces one of these and it stays valid until tournament
 * control refuses it; the session fields below come and go with each game played in it.
 */
export interface IPairedRoom {
  /** Normalized, no trailing slash. See `normalizeBaseUrl`. */
  baseUrl: string;
  roomId: string;
  roomName: string;
  /** Room capability token. Never rendered, never exported. */
  roomToken: string;
  /** A stable per-browser label for presence and writer arbitration. Carries no authority. */
  deviceId: string;
}

export interface IConnectedSession extends IPairedRoom {
  version: number;
  /** Set once a game has been started, so a reload resumes the same session. */
  sessionId?: string;
  sessionToken?: string;
  /**
   * The local game record this connection belongs to.
   *
   * The link that lets a reload decide whether these session credentials are still the ones the
   * game on screen was started with. Matching on the session id alone would be nearly the same
   * thing and wrong in one case that matters: a game deliberately re-scored as a second attempt has
   * its own record, and a connection pointing at the first one must not be offered to it.
   */
  gameRecordId?: string;
  /** Which tournament this was paired against, so a server that has opened another is detectable. */
  tournamentKey?: string;
  /** ISO 8601 */
  updatedAt: string;
}

/** The room half of a stored connection, or null when there is no usable pairing. */
export function pairedRoomOf(session: IConnectedSession | null): IPairedRoom | null {
  if (!session) return null;
  return {
    baseUrl: session.baseUrl,
    roomId: session.roomId,
    roomName: session.roomName,
    roomToken: session.roomToken,
    deviceId: session.deviceId,
  };
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
    const raw = storage.getItem(connectionStorageKey) ?? storage.getItem(legacyConnectionStorageKey);
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
    storage?.removeItem(legacyConnectionStorageKey);
  } catch {
    // If storage itself is unavailable there is nothing else to clear locally.
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
