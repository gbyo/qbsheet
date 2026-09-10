/**
 * Process-exit close-guard registry (#731).
 *
 * The native shell (`apps/director/src/main.tsx`) owns the Tauri
 * `onCloseRequested` interception and the real `window.close()`, but the
 * durability decision lives in the Director controller. This module is the
 * narrow bridge between them so neither side imports the other:
 *
 * - the `useCloseGuard` hook registers a `RequestAppClose` that flushes the
 *   canonical persistence queue and resolves `true` only once the current
 *   revision is durable;
 * - the native shell registers a `PerformAppClose` that sets its one-shot
 *   close bypass and terminates the window.
 *
 * There is intentionally no browser close performer: a web tab cannot be
 * closed programmatically, so the destructive-quit path is native-only and
 * the browser keeps its best-effort `beforeunload` warning.
 */

/** Resolves true when the process may exit; false keeps the app open. */
export type RequestAppClose = () => Promise<boolean>;
/** Performs the real window close. Installed by the native shell only. */
export type PerformAppClose = () => void;

let requestAppClose: RequestAppClose | null = null;
let performAppClose: PerformAppClose | null = null;

export function registerCloseGuardRequest(fn: RequestAppClose | null): void {
  requestAppClose = fn;
}

export function getCloseGuardRequest(): RequestAppClose | null {
  return requestAppClose;
}

export function registerClosePerformer(fn: PerformAppClose | null): void {
  performAppClose = fn;
}

export function getClosePerformer(): PerformAppClose | null {
  return performAppClose;
}
