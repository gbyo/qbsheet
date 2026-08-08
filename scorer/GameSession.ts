/**
 * The in-progress game, kept on the device.
 *
 * A Chromebook lid closes, a browser reloads, a tab is restored a day later. None of that may cost a
 * room the questions it has already scored, and none of it may produce a second copy of the same
 * game.
 *
 * # Keyed by the session, not by the device
 *
 * The key is whatever identity the game already has — the room's session id for an assigned game,
 * the emergency game id for one scored without a server. Storing under a device-wide key would mean
 * a room that starts its next game silently inherits the last one's events, which is worse than
 * losing them: it produces a plausible wrong result rather than an obvious empty one.
 *
 * # What is deliberately not stored
 *
 * No room access token, no session token. The saved game is exported and handed around — it goes to
 * the outbox, it can be downloaded as QBJ, a director may email it — and a capability token that
 * travels with a game file is a capability token that ends up somewhere it shouldn't. The tokens
 * live in the room's own identity storage and stay there.
 */
import { ScoreEvent } from '../scoring/ScoreEvents';
import { IGameSetup } from '../scoring/deriveGame';
import { validEvent, validSetup } from './ScorerRecovery';

/** Bumped when the stored shape changes. An unrecognized version is treated as no saved game. */
export const gameSessionVersion = 1;

const storagePrefix = `yellowfruit.room.game.v${gameSessionVersion}.`;

/** Everything needed to put a half-scored game back on the screen. */
export interface IStoredGame {
  version: number;
  /** The session or emergency game this belongs to. Also the storage key. */
  gameKey: string;
  setup: IGameSetup;
  events: ScoreEvent[];
  /** ISO 8601. Used to retire games left behind by a previous tournament. */
  updatedAt: string;
}

/**
 * How stale a saved game may be and still be offered.
 *
 * The same reasoning as the scoring kit's: a tournament is a day, and a game older than that is far
 * more likely to be left over from last weekend than to be the one this room is playing.
 */
export const gameSessionMaxAgeMs = 36 * 60 * 60 * 1000;

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

function storageKey(gameKey: string): string {
  return `${storagePrefix}${gameKey}`;
}

/**
 * Save the game as it stands.
 *
 * @returns false when this browser refused the write, so nothing promises a scorekeeper their game
 * is safe when it isn't.
 */
export function saveGame(
  gameKey: string,
  setup: IGameSetup,
  events: ScoreEvent[],
  now: Date = new Date(),
  storage: IStorageLike | null = browserStorage(),
): boolean {
  if (!storage || gameKey === '') return false;
  const stored: IStoredGame = {
    version: gameSessionVersion,
    gameKey,
    setup,
    events,
    updatedAt: now.toISOString(),
  };
  try {
    storage.setItem(storageKey(gameKey), JSON.stringify(stored));
    return true;
  } catch {
    // Quota, private browsing, a locked-down profile. The caller tells the scorekeeper.
    return false;
  }
}

/**
 * Read back a game for this key, if there is a usable one.
 *
 * Returns null rather than throwing for anything unrecognizable. A corrupt saved game is the same as
 * no saved game: the room starts fresh, which is recoverable, rather than crashing on load, which
 * is not.
 */
export function loadGame(
  gameKey: string,
  now: Date = new Date(),
  storage: IStorageLike | null = browserStorage(),
): IStoredGame | null {
  if (!storage || gameKey === '') return null;
  try {
    const raw = storage.getItem(storageKey(gameKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IStoredGame>;
    if (parsed?.version !== gameSessionVersion) return null;
    if (parsed.gameKey !== gameKey) return null;
    if (!Array.isArray(parsed.events) || !parsed.events.every(validEvent)) return null;
    if (!validSetup(parsed.setup)) return null;
    if (typeof parsed.updatedAt !== 'string') return null;

    const updated = new Date(parsed.updatedAt).getTime();
    if (!Number.isFinite(updated)) return null;
    const age = now.getTime() - updated;
    if (age < 0 || age > gameSessionMaxAgeMs) return null;

    return {
      version: parsed.version,
      gameKey,
      setup: parsed.setup,
      events: parsed.events,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

/** Forget a game, once its result is safely in the outbox. */
export function clearGame(gameKey: string, storage: IStorageLike | null = browserStorage()): void {
  try {
    storage?.removeItem(storageKey(gameKey));
  } catch {
    // The age check is the backstop.
  }
}
