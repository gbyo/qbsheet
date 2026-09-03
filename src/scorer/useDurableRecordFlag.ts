import { useCallback, useState } from 'react';

/**
 * Whether the finished record may currently be presented as safely stored.
 *
 * Pure derivation — no render-phase state update, no synchronizing effect. The saver owns the
 * only state (was the last write durable?); the live props gate the presentation, so a store
 * that has stopped being durable is immediately no longer presented as safely stored, while a
 * stale prop can only ever fail conservative (it cannot overwrite a successful save, it merely
 * waits for props to catch up). Scoring controls never move for this transition.
 */
export function useDurableRecordFlag(
  durable: boolean,
  storageDegraded: boolean,
): readonly [stored: boolean, setStored: (stored: boolean) => void] {
  const [savedDurably, setSavedDurably] = useState(durable && !storageDegraded);
  // Stable identity: save callbacks can safely depend on it without re-creating.
  const setStored = useCallback((stored: boolean) => setSavedDurably(stored), []);
  return [savedDurably && durable && !storageDegraded, setStored] as const;
}
