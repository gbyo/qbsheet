/**
 * Whether this game has already been asked which scoring layout to use.
 *
 * # Why a new game asks at all
 *
 * The layout is a device preference (see `scoringViewPreference`), and a device preference is the
 * wrong thing to inherit silently here. A tournament Chromebook is handed between rounds: the person
 * who scored round three from the table is often not the person sitting down for round four, and the
 * first thing that scorekeeper should see is a scoresheet they recognise or a question they can
 * answer in one press — not somebody else's choice already in force.
 *
 * So a new game asks, with the last-used layout preselected. One press, once a game.
 *
 * # Why it must not ask twice
 *
 * A scoresheet that re-asked on every mount would ask after every reload, after every recovery, and
 * in the middle of a game somebody was already scoring — which is the one moment a modal is worst.
 * So the answer is recorded per game, keyed by `gameKey`, and a game that already has one is never
 * asked again.
 *
 * That marker is the *only* thing stored. It is presentation state about a device, exactly like the
 * seating preference beside it: it reaches no `ScoreEvent`, no QBJ, no game package, no tournament
 * control, and nothing that undo can take back.
 *
 * # Storage that may not be there
 *
 * A locked-down browser profile refuses `localStorage`. The consequence must not be a dialog that
 * reappears every time React re-mounts the scoresheet, so an in-memory set answers first and is
 * written unconditionally. The choice then lasts as long as the tab, which is the same degradation
 * every other preference in this directory takes.
 */

/** Bumped when the stored shape changes. An unrecognized version is treated as never asked. */
export const scoringLayoutPromptVersion = 1;

/**
 * How stale a marker may be and still count as answered.
 *
 * The day-and-a-half window the seating preference uses, and for the same reason: nothing calls a
 * cleanup, so the age check is what stops a Chromebook accumulating a row per game it has ever
 * scored. A marker older than this belongs to a tournament that finished, and asking again is the
 * right answer for a game nobody has touched since.
 */
export const scoringLayoutPromptMaxAgeMs = 36 * 60 * 60 * 1000;

interface IPromptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): IPromptStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function scoringLayoutPromptStorageKey(gameKey: string): string {
  return `qbsheet.scorer.layout-asked.v${scoringLayoutPromptVersion}.${encodeURIComponent(gameKey)}`;
}

/**
 * Games answered during this tab's lifetime.
 *
 * Consulted first and written always, so a device whose storage refuses still only asks once. Module
 * state for the reason the other preferences are module state: there is one scorekeeper per device.
 */
const answeredHere = new Set<string>();

export function scoringLayoutChosen(
  gameKey: string,
  now: Date = new Date(),
  storage: IPromptStorage | null = browserStorage(),
): boolean {
  if (gameKey === '') return false;
  if (answeredHere.has(gameKey)) return true;
  if (!storage) return false;
  try {
    const raw = storage.getItem(scoringLayoutPromptStorageKey(gameKey));
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { version?: number; answeredAt?: unknown };
    if (parsed?.version !== scoringLayoutPromptVersion) return false;
    const answered = typeof parsed.answeredAt === 'string' ? new Date(parsed.answeredAt).getTime() : NaN;
    if (!Number.isFinite(answered)) return false;
    const age = now.getTime() - answered;
    // A clock correction can make a fresh marker appear to come from the future. Treat that as age
    // zero rather than asking the scorekeeper the same per-game question again after a reload.
    return age <= scoringLayoutPromptMaxAgeMs;
  } catch {
    // A marker that cannot be read is a marker that is not there. The cost is one extra question.
    return false;
  }
}

/** Record that this game has been asked. Returns whether it survived beyond this tab. */
export function rememberScoringLayoutChoice(
  gameKey: string,
  now: Date = new Date(),
  storage: IPromptStorage | null = browserStorage(),
): boolean {
  if (gameKey === '') return false;
  answeredHere.add(gameKey);
  if (!storage) return false;
  try {
    storage.setItem(
      scoringLayoutPromptStorageKey(gameKey),
      JSON.stringify({ version: scoringLayoutPromptVersion, answeredAt: now.toISOString() }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Forget the answer, so this game asks again. For device resets and for tests. */
export function forgetScoringLayoutChoice(
  gameKey: string,
  storage: IPromptStorage | null = browserStorage(),
): void {
  answeredHere.delete(gameKey);
  try {
    storage?.removeItem(scoringLayoutPromptStorageKey(gameKey));
  } catch {
    // Nothing depends on this being gone.
  }
}

/** Drop every in-memory answer. For tests, which reuse one module across cases. */
export function resetScoringLayoutPrompts(): void {
  answeredHere.clear();
}
