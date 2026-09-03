/**
 * The one shared source of truth for native QBTCP server status.
 *
 * DirectorApp polls this once per second; the sidebar, the Overview preflight check, and
 * Rooms all read the same snapshot, and start/stop/pairing actions write through
 * to it — so an external change, a server failure, or a local mutation becomes visible
 * everywhere instead of each surface owning a copy that can disagree.
 *
 * Reads are serialized and generation-checked. A once-per-second interval over a read that can
 * take longer than a second would otherwise overlap, so a slow older read could land after a
 * newer one and move the snapshot backwards; and a read begun before Start/Stop could land after
 * the mutation and undo it. Only one read is ever in flight, and a read whose generation has
 * been superseded by a mutation is discarded rather than applied.
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
  // Loading is derived, never set inside the polling effect: a mutation is in flight, or polling
  // is active and no read has completed yet. A slow background read deliberately does not count,
  // so overlapping polls can never strand the Start/Stop button on "Checking server".
  const [pendingMutations, setPendingMutations] = useState(0);
  const [everLoaded, setEverLoaded] = useState(false);
  const loading = pendingMutations > 0 || (active && !everLoaded);
  const statusRef = useRef(status);
  const onPollRef = useRef(onPoll);
  // One read at a time, and a generation that every mutation bumps so a read started before it
  // cannot apply afterwards.
  const readInFlightRef = useRef(false);
  const generationRef = useRef(0);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    onPollRef.current = onPoll;
  }, [onPoll]);

  /** Authoritative write: supersedes any read that is already in flight. */
  const commitStatus = useCallback((next: NativeServerStatus) => {
    generationRef.current += 1;
    setStatus(next);
  }, []);

  const refresh = useCallback(async () => {
    if (readInFlightRef.current) return;
    readInFlightRef.current = true;
    const generation = generationRef.current;
    try {
      const next = await readNativeServerStatus();
      if (generationRef.current === generation) setStatus(next);
    } catch (reason: unknown) {
      if (generationRef.current === generation) {
        setStatus({
          running: false,
          message: reason instanceof Error ? reason.message : 'Server status could not be read.',
        });
      }
    } finally {
      readInFlightRef.current = false;
      setEverLoaded(true);
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
    setPendingMutations((count) => count + 1);
    try {
      const next = statusRef.current.running ? await stopNativeServer() : await startNativeServer();
      commitStatus(next);
      return next;
    } finally {
      setEverLoaded(true);
      setPendingMutations((count) => Math.max(0, count - 1));
    }
  }, [commitStatus]);

  const addInvitation = useCallback((invitation: NativeRoomPairingInvitation) => {
    generationRef.current += 1;
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

  return { status, loading, refresh, toggle, addInvitation, apply: commitStatus };
}
