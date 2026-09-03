/**
 * The one shared source of truth for native QBTCP server status.
 *
 * DirectorApp polls this once per second; the sidebar, the Overview preflight check, and
 * Tournament Control all read the same snapshot, and start/stop/pairing actions write through
 * to it — so an external change, a server failure, or a local mutation becomes visible
 * everywhere instead of each surface owning a copy that can disagree.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readNativeServerStatus,
  startNativeServer,
  stopNativeServer,
  type NativeRoomPairingInvitation,
  type NativeServerStatus,
} from '../platform/native';

export interface NativeServerState {
  status: NativeServerStatus;
  loading: boolean;
  /** Re-read the native snapshot now (also runs on the poll interval while active). */
  refresh(): Promise<void>;
  /** Start or stop the server based on the current snapshot; applies the result. */
  toggle(): Promise<NativeServerStatus>;
  /** Merge a newly issued pairing invitation into the shared snapshot. */
  addInvitation(invitation: NativeRoomPairingInvitation): void;
  /** Replace the snapshot, e.g. after an external/native change observed elsewhere. */
  apply(next: NativeServerStatus): void;
}

export function useNativeServerStatus(options: {
  /** When false no polling or initial read happens; the snapshot stays `{ running: false }`. */
  active: boolean;
  /** Called on every poll tick (e.g. QBTCP session sync) — never creates its own interval. */
  onPoll?: () => void;
}): NativeServerState {
  const { active, onPoll } = options;
  const [status, setStatus] = useState<NativeServerStatus>({ running: false });
  // Loading is derived, never set inside the polling effect: a read is in flight, or polling
  // is active and no read has completed yet. Async completions are the only writers.
  const [inFlightReads, setInFlightReads] = useState(0);
  const [everLoaded, setEverLoaded] = useState(false);
  const loading = inFlightReads > 0 || (active && !everLoaded);
  const statusRef = useRef(status);
  const onPollRef = useRef(onPoll);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    onPollRef.current = onPoll;
  }, [onPoll]);

  const refresh = useCallback(async () => {
    setInFlightReads((count) => count + 1);
    try {
      const next = await readNativeServerStatus();
      setStatus(next);
    } catch (reason: unknown) {
      setStatus({
        running: false,
        message: reason instanceof Error ? reason.message : 'Server status could not be read.',
      });
    } finally {
      setEverLoaded(true);
      setInFlightReads((count) => Math.max(0, count - 1));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    const poll = () => {
      if (!mounted) return;
      onPollRef.current?.();
      void refresh();
    };
    poll();
    const interval = window.setInterval(poll, 1000);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [active, refresh]);

  const toggle = useCallback(async () => {
    setInFlightReads((count) => count + 1);
    try {
      const next = statusRef.current.running ? await stopNativeServer() : await startNativeServer();
      setStatus(next);
      return next;
    } finally {
      setEverLoaded(true);
      setInFlightReads((count) => Math.max(0, count - 1));
    }
  }, []);

  const addInvitation = useCallback((invitation: NativeRoomPairingInvitation) => {
    setStatus((previous) => {
      const current = (previous.pairingInvitations ?? []).filter(
        (entry) => entry.roomId !== invitation.roomId,
      );
      const nextInvitations = [...current, invitation].sort((left, right) =>
        left.roomId.localeCompare(right.roomId),
      );
      return {
        ...previous,
        pairingInvitations: nextInvitations,
        pairingCode: nextInvitations.length === 1 ? nextInvitations[0].pairingCode : undefined,
        pairingUrl: nextInvitations.length === 1 ? nextInvitations[0].pairingUrl : undefined,
      };
    });
  }, []);

  const apply = useCallback((next: NativeServerStatus) => {
    setStatus(next);
  }, []);

  return { status, loading, refresh, toggle, addInvitation, apply };
}
