/**
 * The deliberately small bootstrap switch for Recovery Mode.
 *
 * Recovery Mode is a safe-mode entry point, not an application route. Keeping the query parsing in
 * this tiny module lets `main.tsx` decide which bundle to load before it imports the normal app.
 */
export const recoveryModeQueryKey = 'recovery';
export const recoveryModeQueryValue = '1';

interface ILocationSearch {
  search: string;
}

interface ILocationPath {
  pathname: string;
}

/** True only for the explicit `?recovery=1` opt-in. */
export function isRecoveryModeRequested(
  target: ILocationSearch | null = typeof window === 'undefined' ? null : window.location,
): boolean {
  if (!target) return false;
  try {
    return new URLSearchParams(target.search).get(recoveryModeQueryKey) === recoveryModeQueryValue;
  } catch {
    // A broken URL must not prevent the ordinary application from starting.
    return false;
  }
}

/** A same-origin link into safe mode, with unrelated query/fragment data deliberately discarded. */
export function recoveryModeHref(
  target: ILocationPath | null = typeof window === 'undefined' ? null : window.location,
): string {
  const pathname = target?.pathname || '/';
  return `${pathname}?${recoveryModeQueryKey}=${recoveryModeQueryValue}`;
}

/** Return to the ordinary single-page entry point without carrying the safe-mode switch forward. */
export function normalModeHref(
  target: ILocationPath | null = typeof window === 'undefined' ? null : window.location,
): string {
  return target?.pathname || '/';
}
