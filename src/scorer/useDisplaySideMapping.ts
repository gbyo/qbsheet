/** React lifecycle around the per-game display-side preference. */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  DisplaySideMapping,
  identityDisplaySideMapping,
  loadDisplaySideMapping,
  saveDisplaySideMapping,
  swapDisplaySideMapping,
} from './DisplaySideMapping';

export interface IDisplaySideMappingApi {
  mapping: DisplaySideMapping;
  swapped: boolean;
  swap: () => void;
}

interface IDisplaySideStore {
  mapping: DisplaySideMapping;
  listeners: Set<() => void>;
}

const stores = new Map<string, IDisplaySideStore>();

function storeFor(gameKey: string): IDisplaySideStore {
  const existing = stores.get(gameKey);
  if (existing) return existing;
  const created: IDisplaySideStore = {
    mapping: gameKey === '' ? { ...identityDisplaySideMapping } : loadDisplaySideMapping(gameKey),
    listeners: new Set(),
  };
  stores.set(gameKey, created);
  return created;
}

function subscribe(store: IDisplaySideStore, listener: () => void): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

function updateStore(store: IDisplaySideStore, next: DisplaySideMapping): void {
  store.mapping = next;
  store.listeners.forEach((listener) => listener());
}

export default function useDisplaySideMapping(gameKey: string): IDisplaySideMappingApi {
  const store = storeFor(gameKey);
  const mapping = useSyncExternalStore(
    useCallback((listener) => subscribe(store, listener), [store]),
    useCallback(() => store.mapping, [store]),
    () => identityDisplaySideMapping,
  );

  const swap = useCallback(() => {
    const next = swapDisplaySideMapping(store.mapping);
    // A storage refusal should not block this mount; the view can still be corrected immediately.
    saveDisplaySideMapping(gameKey, next);
    updateStore(store, next);
  }, [gameKey, store]);

  return useMemo(
    () => ({
      mapping,
      swapped: mapping.left === 'right',
      swap,
    }),
    [mapping, swap],
  );
}
