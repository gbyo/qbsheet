/**
 * Which scorer this device uses.
 *
 * The browser is moving from MODAQ to a first-party scorekeeping interface. MODAQ stays in the
 * codebase as a fallback while that migration is proven, but it is no longer something a scorekeeper
 * can arrive at: nothing in the UI offers it, and nothing links to it. Reaching it takes a
 * deliberate act by someone who knows it exists.
 *
 * # Why the choice is sticky
 *
 * The obvious implementation — read `?scorer=legacy` on every render — does not survive contact with
 * this app. `adoptRoomIdentity` rewrites the address to `${pathname}${hash}` as soon as a QR identity
 * is adopted, deliberately, so that a room's access token stops being visible over a scorekeeper's
 * shoulder. That rewrite takes the whole query string with it, so a flag read from the URL on every
 * render would last exactly one paint.
 *
 * Persisting it is also the better behaviour on its own terms. Choosing the legacy scorer is a
 * decision about a device in a room — "this one is on the old scorer for now" — and a decision like
 * that should outlive a reload, a flat battery, and a scorekeeper who closed the lid at lunch.
 *
 * # Getting back
 *
 * `?scorer=default` clears it. Without that there would be no way back other than clearing site data,
 * which is not something to ask of somebody in a classroom mid-tournament.
 */

/** Which scorekeeping interface to render. */
export type ScorerChoice = 'first-party' | 'legacy';

const scorerChoiceStorageKey = 'yellowfruit.room.scorer';

/** The query parameter that switches scorers. Not linked from anywhere; typed on purpose. */
export const scorerQueryParameter = 'scorer';

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

/**
 * What `?scorer=` says, if it says anything recognizable.
 *
 * An unrecognized value is not an error and not a reason to change anything: a stray parameter
 * should leave a device on whatever scorer it was already using rather than silently resetting it.
 */
function readOverride(search: string): ScorerChoice | null {
  try {
    const value = new URLSearchParams(search).get(scorerQueryParameter);
    if (value === 'legacy' || value === 'modaq') return 'legacy';
    if (value === 'default' || value === 'first-party') return 'first-party';
    return null;
  } catch {
    return null;
  }
}

/**
 * Which scorer this page should render.
 *
 * A `?scorer=` parameter both answers the question and is remembered for next time. Otherwise the
 * remembered answer stands, and failing that the first-party scorer, which is the default the
 * migration is heading towards.
 */
export function readScorerChoice(
  location: { search: string } = typeof window !== 'undefined' ? window.location : { search: '' },
  storage: IStorageLike | null = browserStorage(),
): ScorerChoice {
  const override = readOverride(location.search);
  if (override) {
    try {
      if (override === 'legacy') storage?.setItem(scorerChoiceStorageKey, 'legacy');
      else storage?.removeItem(scorerChoiceStorageKey);
    } catch {
      // A browser refusing the write only costs stickiness, and the URL still had its say for this
      // load. Not worth failing the page over.
    }
    return override;
  }

  try {
    return storage?.getItem(scorerChoiceStorageKey) === 'legacy' ? 'legacy' : 'first-party';
  } catch {
    return 'first-party';
  }
}

/** Forget any legacy-scorer preference on this device. */
export function clearScorerChoice(storage: IStorageLike | null = browserStorage()): void {
  try {
    storage?.removeItem(scorerChoiceStorageKey);
  } catch {
    // Nothing useful to do.
  }
}
