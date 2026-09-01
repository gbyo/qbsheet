/**
 * The only thing the arcade is allowed to remember.
 *
 * # Why this is not part of any game record
 *
 * A best score is a fact about whoever has been idling at this Chromebook between rounds. It is not
 * a fact about a match, and the whole point of keeping it here is that there is no route from it to
 * anything that is. Nothing in this file can reach the event journal, a QBJ, a recovery snapshot or
 * tournament control, because the only names it knows are the two below and the only values it
 * writes are integers.
 *
 * # Why the keys are spelled out rather than derived
 *
 * `qbsheet.arcade.<game>.bestScore`, written literally, so that a search for a storage key finds the
 * code that owns it. The prefix keeps the arcade in its own corner of a namespace the scorer shares
 * with the journal every scored question is written to; a template built from a game id would make
 * the set of keys a function of whatever a future caller passes in.
 *
 * # Storage is optional, and a locked-down profile is not an error
 *
 * A school profile that refuses `localStorage` gets a working game whose best score lasts as long as
 * the dialog. That is the same degradation `keyboardPreference` accepts, for the same reason: the
 * feature is worth having without the memory, and there is nothing here worth refusing to run over.
 */

export type ArcadeGameId = 'qbbird' | 'snake';

/** Written out in full, one per game, so a key search lands here. See the note above. */
export const arcadeBestScoreKeys: Record<ArcadeGameId, string> = {
  qbbird: 'qbsheet.arcade.qbbird.bestScore',
  snake: 'qbsheet.arcade.snake.bestScore',
};

/** The subset of `Storage` this file uses, so a test can pass a broken one deliberately. */
export interface IArcadeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): IArcadeStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The stored best, or zero.
 *
 * Anything that is not a non-negative integer is read as zero rather than repaired. A key somebody
 * has hand-edited to `"999999"` is indistinguishable from one that was earned, and there is no harm
 * in either; a key holding `"NaN"` is a key that never meant anything.
 */
export function loadBestScore(game: ArcadeGameId, storage: IArcadeStorage | null = browserStorage()): number {
  try {
    const stored = Number(storage?.getItem(arcadeBestScoreKeys[game]));
    return Number.isInteger(stored) && stored >= 0 ? stored : 0;
  } catch {
    return 0;
  }
}

/**
 * Keep a new best, reporting whether it stuck.
 *
 * The return value exists so a caller can say "not saved on this device" rather than silently
 * implying a memory it does not have. Nothing in the games depends on it being true.
 */
export function saveBestScore(
  game: ArcadeGameId,
  score: number,
  storage: IArcadeStorage | null = browserStorage(),
): boolean {
  if (!Number.isInteger(score) || score < 0) return false;
  try {
    storage?.setItem(arcadeBestScoreKeys[game], String(score));
    return storage !== null;
  } catch {
    return false;
  }
}

/** Forget both bests. For tests, and for anything that ever offers to clear them. */
export function clearBestScores(storage: IArcadeStorage | null = browserStorage()): void {
  try {
    Object.values(arcadeBestScoreKeys).forEach((key) => storage?.removeItem(key));
  } catch {
    // Nothing depends on this succeeding.
  }
}
