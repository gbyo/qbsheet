/**
 * The relationship between the side a scorekeeper sees and the side stored in the game.
 *
 * The scoring engine deliberately calls the two canonical sides `left` and `right`. A room may
 * discover that the teams are sitting the other way round, though, and changing the order in which
 * the panels are painted must not change any event. Keeping this mapping in one small module makes
 * that distinction explicit: callers use `mapping[displaySide]` before touching game state.
 */
import { LeftOrRight } from '../scoring/types';

export type DisplaySideMapping = Record<LeftOrRight, LeftOrRight>;

/** Version for the local presentation preference and for QBSheet-specific portable state. */
export const displaySideMappingVersion = 1;

/** The ordinary orientation: canonical left is displayed on the left. */
export const identityDisplaySideMapping: DisplaySideMapping = { left: 'left', right: 'right' };

/** The two mappings are an involution: swapping twice is exactly the original view. */
export function swapDisplaySideMapping(mapping: DisplaySideMapping): DisplaySideMapping {
  return { left: mapping.right, right: mapping.left };
}

/** Whether a mapping is one of the two valid orientations. */
export function isDisplaySideMapping(value: unknown): value is DisplaySideMapping {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<DisplaySideMapping>;
  const keys = Object.keys(candidate);
  if (
    keys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(candidate, 'left') ||
    !Object.prototype.hasOwnProperty.call(candidate, 'right')
  )
    return false;
  return (
    (candidate.left === 'left' && candidate.right === 'right') ||
    (candidate.left === 'right' && candidate.right === 'left')
  );
}

/** Return the canonical side represented by a side on screen. */
export function canonicalSideForDisplay(mapping: DisplaySideMapping, displaySide: LeftOrRight): LeftOrRight {
  return mapping[displaySide];
}

/** Return where a canonical side is currently displayed. */
export function displaySideForCanonical(
  mapping: DisplaySideMapping,
  canonicalSide: LeftOrRight,
): LeftOrRight {
  return mapping.left === canonicalSide ? 'left' : 'right';
}

/** Re-key a side-indexed value for a screen-oriented consumer. */
export function mapSides<T>(
  canonical: Record<LeftOrRight, T>,
  mapping: DisplaySideMapping,
): Record<LeftOrRight, T> {
  return { left: canonical[mapping.left], right: canonical[mapping.right] };
}

/** A small explicit shape suitable for embedding in a QBSheet-specific backup. */
export interface ISerializedDisplaySideMapping {
  version: typeof displaySideMappingVersion;
  mapping: DisplaySideMapping;
}

export function serializeDisplaySideMapping(mapping: DisplaySideMapping): ISerializedDisplaySideMapping {
  // Validate at the serialization boundary too. No caller should be able to create a backup whose
  // orientation is ambiguous or whose two displayed columns point at one canonical team.
  if (!isDisplaySideMapping(mapping)) throw new Error('Invalid display-side mapping.');
  return {
    version: displaySideMappingVersion,
    mapping: { left: mapping.left, right: mapping.right },
  };
}

/** Parse portable presentation state; malformed/unknown state is absent rather than trusted. */
export function parseDisplaySideMapping(value: unknown): DisplaySideMapping | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as { version?: unknown; mapping?: unknown };
  const keys = Object.keys(candidate);
  if (
    keys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(candidate, 'version') ||
    !Object.prototype.hasOwnProperty.call(candidate, 'mapping')
  )
    return null;
  if (candidate.version !== displaySideMappingVersion || !isDisplaySideMapping(candidate.mapping)) {
    return null;
  }
  return { left: candidate.mapping.left, right: candidate.mapping.right };
}

interface IDisplaySideStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): IDisplaySideStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function displaySideStorageKey(gameKey: string): string {
  return `yellowfruit.room.display-sides.v${displaySideMappingVersion}.${encodeURIComponent(gameKey)}`;
}

/** Read this game's view orientation. Anything malformed safely means the normal orientation. */
export function loadDisplaySideMapping(
  gameKey: string,
  storage: IDisplaySideStorage | null = browserStorage(),
): DisplaySideMapping {
  if (!storage || gameKey === '') return { ...identityDisplaySideMapping };
  try {
    const raw = storage.getItem(displaySideStorageKey(gameKey));
    if (!raw) return { ...identityDisplaySideMapping };
    const parsed = JSON.parse(raw) as unknown;
    const mapping = parseDisplaySideMapping(parsed);
    return mapping ?? { ...identityDisplaySideMapping };
  } catch {
    // Presentation state is disposable. A bad preference must never prevent the game from loading.
    return { ...identityDisplaySideMapping };
  }
}

/** Save this game's view orientation without touching scoring state. */
export function saveDisplaySideMapping(
  gameKey: string,
  mapping: DisplaySideMapping,
  storage: IDisplaySideStorage | null = browserStorage(),
): boolean {
  if (!storage || gameKey === '' || !isDisplaySideMapping(mapping)) return false;
  try {
    storage.setItem(displaySideStorageKey(gameKey), JSON.stringify(serializeDisplaySideMapping(mapping)));
    return true;
  } catch {
    return false;
  }
}

export function clearDisplaySideMapping(
  gameKey: string,
  storage: IDisplaySideStorage | null = browserStorage(),
): void {
  try {
    storage?.removeItem(displaySideStorageKey(gameKey));
  } catch {
    // Nothing depends on this preference being removed.
  }
}
