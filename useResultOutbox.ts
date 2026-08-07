/**
 * The outbox, wired into a React page.
 *
 * One hook rather than two copies, because both the assigned-room workflow and the manual/emergency
 * workflow have exactly the same obligations: persist before uploading, keep retrying on a bounded
 * backoff, never lose a result, and always be able to hand one over as a file. The differences
 * between the two workflows are about which game is being scored, not about what happens to the
 * result afterwards.
 *
 * The store instance is created once per page and deliberately not recreated on re-render: it owns
 * an IndexedDB connection and an in-memory cache that must not fork.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import RoomResultOutbox, { IEnqueueResult, IOutboxDraft } from './OutboxStore';
import { IOutboxDriver, resolveOutboxDriver } from './OutboxStorage';
import { IRoomResultOutboxEntry } from './ResultOutbox';
import { downloadOutboxQbj } from './QbjBackup';
import { postFinal } from './api';

/** How often to look for a result that has become due for another attempt. */
const flushIntervalMs = 5000;

export interface IUseResultOutbox {
  /** Everything held on this device, newest first. */
  entries: IRoomResultOutboxEntry[];
  /** Results the tournament does not yet have. */
  unresolved: IRoomResultOutboxEntry[];
  /** False when this browser cannot save results between reloads. */
  durable: boolean;
  /** True once the store has been read, so the UI does not flash an empty list. */
  ready: boolean;
  /** Malformed records that were skipped. Surfaced so a real problem is not silently invisible. */
  skipped: number;
  enqueue: (draft: IOutboxDraft) => Promise<IEnqueueResult>;
  /** Deliver one result immediately, ignoring the backoff, and report what happened to it. */
  submitNow: (id: string) => Promise<IRoomResultOutboxEntry | null>;
  markSubmitted: (id: string) => Promise<void>;
  markAccepted: (id: string) => Promise<void>;
  markNeedsCorrection: (id: string, reason?: string) => Promise<void>;
  /** Record that the scorekeeper got a stranded result to tournament control another way. */
  markHandedOver: (id: string) => Promise<void>;
  /** Does this specific result survive a reload right now? */
  isPersisted: (id: string) => boolean;
  /** Try every due result now, rather than waiting for the next tick. */
  flushNow: () => Promise<void>;
  download: (entry: IRoomResultOutboxEntry, roomName?: string) => boolean;
}

/**
 * Deliver one entry over the room API.
 *
 * A manual-backup entry has no session and is therefore never delivered automatically: it is
 * non-authoritative by construction and reaches the tournament only through a human importing its
 * QBJ. Saying so here rather than in the caller keeps the rule in one place.
 */
async function deliverEntry(entry: IRoomResultOutboxEntry) {
  if (!entry.sessionCredentials) {
    return { ok: false as const, status: 409, error: 'This result was scored outside a tournament assignment.' };
  }
  const result = await postFinal(entry.sessionCredentials, entry.qbj);
  if (result.ok) return { ok: true as const, newSubmission: result.value.newSubmission };
  return { ok: false as const, status: result.status, error: result.error };
}

export default function useResultOutbox(driver?: IOutboxDriver): IUseResultOutbox {
  const outbox = useMemo(() => new RoomResultOutbox(driver ?? resolveOutboxDriver()), [driver]);
  const [entries, setEntries] = useState<IRoomResultOutboxEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [skipped, setSkipped] = useState(0);
  const [durable, setDurable] = useState(true);
  /** Guards against two flushes overlapping, which would double-count attempts. */
  const flushing = useRef(false);

  const refresh = useCallback(() => {
    setEntries(outbox.list());
  }, [outbox]);

  useEffect(() => {
    let cancelled = false;
    outbox
      .load()
      .then((result) => {
        if (cancelled) return result;
        setEntries(result.entries);
        setSkipped(result.skipped);
        setDurable(result.durable);
        setReady(true);
        return result;
      })
      .catch(() => {
        // `load` already swallows store failures; this is only for an unexpected throw. An outbox
        // that cannot be read must still let the page render and score.
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [outbox]);

  const flushNow = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      await outbox.flush(deliverEntry);
    } finally {
      flushing.current = false;
      refresh();
    }
  }, [outbox, refresh]);

  // The retry loop. It runs unconditionally rather than only while something is queued: the
  // condition would have to be recomputed from state that this hook is itself changing, and a
  // five-second no-op on an idle room costs nothing.
  useEffect(() => {
    if (!ready) return undefined;
    const handle = setInterval(() => {
      flushNow().catch(() => undefined);
    }, flushIntervalMs);
    return () => clearInterval(handle);
  }, [ready, flushNow]);

  const enqueue = useCallback(
    async (draft: IOutboxDraft) => {
      const result = await outbox.enqueue(draft);
      refresh();
      return result;
    },
    [outbox, refresh],
  );

  const submitNow = useCallback(
    async (id: string) => {
      const entry = await outbox.deliverOne(id, deliverEntry);
      refresh();
      return entry;
    },
    [outbox, refresh],
  );

  const markSubmitted = useCallback(
    async (id: string) => {
      await outbox.markSubmitted(id);
      refresh();
    },
    [outbox, refresh],
  );

  const markAccepted = useCallback(
    async (id: string) => {
      await outbox.markAccepted(id);
      await outbox.prune();
      refresh();
    },
    [outbox, refresh],
  );

  const markNeedsCorrection = useCallback(
    async (id: string, reason?: string) => {
      await outbox.markNeedsCorrection(id, reason);
      refresh();
    },
    [outbox, refresh],
  );

  const markHandedOver = useCallback(
    async (id: string) => {
      await outbox.markHandedOver(id);
      refresh();
    },
    [outbox, refresh],
  );

  const isPersisted = useCallback((id: string) => outbox.isPersisted(id), [outbox]);

  const download = useCallback(
    (entry: IRoomResultOutboxEntry, roomName?: string) => downloadOutboxQbj(entry, roomName),
    [],
  );

  const unresolved = useMemo(() => entries.filter((entry) => entry.deliveryState !== 'accepted'), [entries]);

  return {
    entries,
    unresolved,
    durable,
    ready,
    skipped,
    enqueue,
    submitNow,
    markSubmitted,
    markAccepted,
    markNeedsCorrection,
    markHandedOver,
    isPersisted,
    flushNow,
    download,
  };
}
