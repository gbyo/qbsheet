/**
 * The update state, as something React can render.
 *
 * Two hooks rather than one, because the two things a screen does with updates are asymmetric. Almost
 * every screen only reads: it wants to know whether to show a line of text. Exactly one place — the
 * component that knows which screen is on — declares whether the application may currently be
 * replaced, and that is a write with real consequences. Keeping them apart means a screen cannot
 * accidentally acquire the authority to allow a mid-game reload by rendering a notice about one.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { AppUpdateWatcher, IAppUpdateState, appUpdates } from './AppUpdate';

/** Subscribe to whether a newer build is waiting. */
export function useAppUpdate(watcher: AppUpdateWatcher = appUpdates): IAppUpdateState {
  const subscribe = useCallback((listener: () => void) => watcher.subscribe(listener), [watcher]);
  const snapshot = useCallback(() => watcher.snapshot(), [watcher]);
  // The watcher is the source, read as the notice renders. A copy in `useState` needed re-reading on
  // subscribe, because the worker can finish installing between the first render and that effect;
  // reading the watcher directly closes the window rather than patching it, so the notice can no
  // longer wait for an unrelated state change to appear.
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * Declare whether the application may be replaced right now.
 *
 * Reset to false on unmount, so a component that stops rendering cannot leave the door open behind
 * it. That is the conservative direction: the screen that comes next declares for itself.
 */
export function useReplaceable(replaceable: boolean, watcher: AppUpdateWatcher = appUpdates): void {
  useEffect(() => {
    watcher.setReplaceable(replaceable);
    return () => watcher.setReplaceable(false);
  }, [replaceable, watcher]);
}
