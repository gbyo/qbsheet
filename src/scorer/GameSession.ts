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
export const gameSessionVersion = 2;
/** The shape written before action-level recovery metadata existed. */
export const legacyGameSessionVersion = 1;

/*
 * Keep the original key as the write location. The shape, rather than the key, is versioned: this
 * lets a v2 build upgrade a v1 journal in place without leaving a second copy of the same game
 * behind. `loadGame` also checks the v2 key so a short-lived build that used versioned keys can be
 * recovered safely.
 */
const storagePrefix = 'yellowfruit.room.game.v1.';
const alternateStoragePrefix = `yellowfruit.room.game.v${gameSessionVersion}.`;

/** The auxiliary undo/redo state. The event list remains the source of truth. */
export interface IGameSessionHistory {
  /** Sizes of user actions, oldest first. A frame may contain several events. */
  undo: number[];
  /** Events removed by undo, newest action last. */
  redo: ScoreEvent[][];
}

/** Everything needed to put a half-scored game back on the screen. */
export interface IStoredGame {
  version: number;
  /** The session or emergency game this belongs to. Also the storage key. */
  gameKey: string;
  setup: IGameSetup;
  events: ScoreEvent[];
  /** Optional because v1 journals predate action history, and an empty history need not be written. */
  history?: IGameSessionHistory;
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

function alternateStorageKey(gameKey: string): string {
  return `${alternateStoragePrefix}${gameKey}`;
}

function copyHistory(history: IGameSessionHistory | undefined): IGameSessionHistory | undefined {
  if (!history) return undefined;
  return {
    undo: history.undo.slice(),
    redo: history.redo.map((frame) => frame.map((event) => ({ ...event }))),
  };
}

/**
 * Validate auxiliary action metadata without making it a second event journal.
 *
 * A bad frame is discarded as a whole. In particular, never trim or repair an undo frame: doing so
 * would make the button remove a different action from the event list than the one the scorekeeper
 * originally performed.
 */
function parseHistory(value: unknown, events: ScoreEvent[]): IGameSessionHistory | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const history = value as Partial<IGameSessionHistory>;
  // Each stack is auxiliary on its own. Preserve a good stack when the other one is malformed, but
  // never repair a bad frame or leave a malformed frame available to the scorer.
  const undo = Array.isArray(history.undo)
    ? history.undo.every((frame) => typeof frame === 'number' && Number.isInteger(frame) && frame > 0) &&
      history.undo.reduce((sum, frame) => sum + frame, 0) <= events.length
      ? history.undo.slice()
      : []
    : [];
  const redo = Array.isArray(history.redo)
    ? history.redo.every(
        (frame) => Array.isArray(frame) && frame.length > 0 && frame.every((event) => validEvent(event)),
      )
      ? history.redo.map((frame) => frame.map((event) => ({ ...event })))
      : []
    : [];
  return undo.length > 0 || redo.length > 0 ? { undo, redo } : undefined;
}

function parseStored(
  raw: string | null,
  gameKey: string,
): (Omit<IStoredGame, 'updatedAt'> & { updatedAt: string }) | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<IStoredGame>;
  if (parsed?.version !== gameSessionVersion && parsed?.version !== legacyGameSessionVersion) return null;
  if (parsed.gameKey !== gameKey) return null;
  if (!Array.isArray(parsed.events) || !parsed.events.every(validEvent)) return null;
  if (!validSetup(parsed.setup)) return null;
  if (typeof parsed.updatedAt !== 'string') return null;
  // Auxiliary metadata is explicitly best effort. A malformed history must not hide a usable game.
  const history = parseHistory(parsed.history, parsed.events);
  return {
    version: gameSessionVersion,
    gameKey,
    setup: parsed.setup,
    events: parsed.events,
    ...(history ? { history } : {}),
    updatedAt: parsed.updatedAt,
  };
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
  history?: IGameSessionHistory,
): boolean {
  if (!storage || gameKey === '') return false;
  const stored: IStoredGame = {
    version: gameSessionVersion,
    gameKey,
    setup,
    events,
    ...(history && (history.undo.length > 0 || history.redo.length > 0)
      ? { history: copyHistory(history) }
      : {}),
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
    const candidates = [
      parseStored(storage.getItem(alternateStorageKey(gameKey)), gameKey),
      parseStored(storage.getItem(storageKey(gameKey)), gameKey),
    ].filter((candidate): candidate is IStoredGame => candidate !== null);
    const current = candidates
      .map((candidate) => ({ candidate, updated: new Date(candidate.updatedAt).getTime() }))
      .filter(({ updated }) => Number.isFinite(updated))
      .filter(({ updated }) => {
        const age = now.getTime() - updated;
        return age >= 0 && age <= gameSessionMaxAgeMs;
      })
      .sort((first, second) => second.updated - first.updated)[0];
    return current?.candidate ?? null;
  } catch {
    return null;
  }
}

/** Forget a game, once its result is safely in the outbox. */
export function clearGame(gameKey: string, storage: IStorageLike | null = browserStorage()): void {
  try {
    storage?.removeItem(storageKey(gameKey));
    storage?.removeItem(alternateStorageKey(gameKey));
  } catch {
    // The age check is the backstop.
  }
}

/**
 * Everything this device has journalled, as raw text.
 *
 * # Why this bypasses `loadGame`
 *
 * `loadGame` is deliberately strict: an unrecognized version, a failed `validEvent`, a game older
 * than `gameSessionMaxAgeMs` all read as "no saved game", because a scorer that starts fresh is
 * recoverable and one that crashes on load is not. That is the right rule for putting a game back
 * on screen and exactly the wrong one for getting a game *off* a device that will not render.
 *
 * So this reads the strings and does not judge them. It is the last resort behind
 * `RenderErrorBoundary`: when the application cannot draw the scoresheet at all, a scorekeeper can
 * still put the morning's scoring on a USB stick and hand it to somebody who can read JSON. A
 * corrupt entry is more useful in that file than absent from it, because the corruption is the
 * evidence.
 *
 * Carries no tokens for the same reason the journal itself does not: see the note at the top.
 */
export function exportJournals(storage: IStorageLike | null = browserStorage()): Record<string, string> {
  const found: Record<string, string> = {};
  const timestamps = new Map<string, number | null>();
  const prefixes = new Map<string, string>();
  const timestampOf = (raw: string): number | null => {
    try {
      const updatedAt = (JSON.parse(raw) as { updatedAt?: unknown }).updatedAt;
      const timestamp = typeof updatedAt === 'string' ? new Date(updatedAt).getTime() : NaN;
      return Number.isFinite(timestamp) ? timestamp : null;
    } catch {
      return null;
    }
  };
  try {
    const enumerable = storage as
      (IStorageLike & { length?: number; key?: (index: number) => string | null }) | null;
    if (!enumerable || typeof enumerable.length !== 'number' || typeof enumerable.key !== 'function')
      return found;
    for (let index = 0; index < enumerable.length; index += 1) {
      const key: string | null = enumerable.key(index);
      const prefix = key?.startsWith(alternateStoragePrefix)
        ? alternateStoragePrefix
        : key?.startsWith(storagePrefix)
          ? storagePrefix
          : null;
      if (key === null || prefix === null) continue;
      const raw = enumerable.getItem(key);
      if (raw !== null) {
        const gameKey = key.slice(prefix.length);
        const timestamp = timestampOf(raw);
        const priorTimestamp = timestamps.get(gameKey);
        const priorPrefix = prefixes.get(gameKey);
        // A short-lived build used the alternate key. If both survive, retain the newest timestamp
        // just as `loadGame` does. An unreadable timestamp is still worth exporting; ties and two
        // unreadable copies prefer the current write key so one raw bucket remains deterministic.
        if (
          found[gameKey] === undefined ||
          (timestamp !== null &&
            (priorTimestamp === null || priorTimestamp === undefined || timestamp > priorTimestamp)) ||
          (timestamp === priorTimestamp && prefix === storagePrefix && priorPrefix !== storagePrefix)
        ) {
          found[gameKey] = raw;
          timestamps.set(gameKey, timestamp);
          prefixes.set(gameKey, prefix);
        }
      }
    }
  } catch {
    // A profile that refuses enumeration gives back whatever was collected before it refused.
  }
  return found;
}
