/**
 * The background publication worker.
 *
 * Drains `state.live.outbox` against the tournament's QBLive backend. It is deliberately dumb: it
 * takes one item, sends it, and reports what happened. Every decision about what to do next —
 * backoff, conflict repair, giving up — is in `publication.ts`, as a pure function of the
 * publication record, so the interesting behaviour is testable without a network.
 *
 * The worker never blocks a Director mutation. It runs on its own timer, and a mutation that lands
 * mid-flight simply appends to the outbox.
 */

import { QbliveClient, QbliveClientError, type QbliveSnapshot } from '@qbsheet/qblive-protocol';
import type { LiveOutboxItem, LivePublication } from '../domain';
import {
  acknowledgeOutboxItem,
  nextOutboxItem,
  recordOutboxFailure,
  type PublishFailure,
} from './publication';

export interface PublishAttempt {
  item: LiveOutboxItem;
  outcome: 'published' | 'failed';
  publication: LivePublication;
}

/**
 * Classify a client error into what the retry policy should do about it.
 *
 * The judgement that matters: `401`/`403`/`404`/`410` are **fatal**. Retrying a wrong credential
 * every minute for an eight-hour tournament drains a laptop battery to solve a problem only a human
 * can solve, and buries the one message the Director needs to read.
 */
export function classifyFailure(reason: unknown): PublishFailure {
  if (reason instanceof QbliveClientError) {
    if (reason.code === 'conflict') {
      return { kind: 'conflict', message: reason.message, currentRevision: reason.currentRevision };
    }
    if (
      reason.code === 'unauthorized' ||
      reason.code === 'forbidden' ||
      reason.code === 'not-found' ||
      reason.code === 'gone' ||
      reason.code === 'unsupported-protocol' ||
      reason.code === 'payload-too-large'
    ) {
      return { kind: 'fatal', message: reason.message };
    }
    return { kind: 'transient', message: reason.message };
  }
  return {
    kind: 'transient',
    message: reason instanceof Error ? reason.message : 'The tournament server could not be reached.',
  };
}

/**
 * Attempt the next due outbox item, if any.
 *
 * Returns null when there is nothing to do, which is the ordinary case between rounds. The caller
 * persists `attempt.publication` with the rest of the document.
 */
export async function publishOnce(
  publication: LivePublication,
  client: QbliveClient,
  currentSnapshot: QbliveSnapshot | null,
  at = new Date(),
): Promise<PublishAttempt | null> {
  const item = nextOutboxItem(publication, at);
  if (!item) return null;

  try {
    const acknowledged = await send(client, item);
    return {
      item,
      outcome: 'published',
      publication: acknowledgeOutboxItem(publication, item.id, acknowledged, at),
    };
  } catch (reason) {
    return {
      item,
      outcome: 'failed',
      publication: recordOutboxFailure(publication, item.id, classifyFailure(reason), currentSnapshot, at),
    };
  }
}

async function send(client: QbliveClient, item: LiveOutboxItem): Promise<number> {
  const payload = item.payload as Record<string, unknown>;
  switch (item.kind) {
    case 'snapshot':
      return (await client.publishSnapshot(payload.snapshot as QbliveSnapshot)).revision;
    case 'sections':
      return (await client.publishSections(payload)).revision;
    case 'announcement':
      return (await client.publishAnnouncement(payload)).revision;
    case 'finalize':
      return (await client.finalize(item.revision, payload.snapshot as QbliveSnapshot)).revision;
    case 'delete':
      return (await client.destroy()).revision;
  }
}

export interface WorkerHooks {
  /** Read the current publication and cached snapshot. Called before every attempt. */
  read(): { publication: LivePublication | null; snapshot: QbliveSnapshot | null };
  /** Persist the publication. The caller writes it into the tournament document. */
  write(publication: LivePublication): Promise<void>;
  /** Build a client for the current backend, or null when there is nothing to publish to. */
  client(publication: LivePublication): QbliveClient | null;
}

/**
 * The polling loop.
 *
 * One second between passes when idle. That is not a publication cadence — an idle pass is a map
 * lookup — it is how quickly the worker notices a new item. The *publication* cadence comes from
 * how often Director's projection changes, and from the transient coalescing in `collapseOutbox`.
 */
export function startPublicationWorker(hooks: WorkerHooks, intervalMs = 1000): () => void {
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const { publication, snapshot } = hooks.read();
      if (!publication || !publication.settings.enabled) return;
      const client = hooks.client(publication);
      if (!client) return;
      const attempt = await publishOnce(publication, client, snapshot);
      if (attempt) await hooks.write(attempt.publication);
    } catch {
      // A worker that throws is a worker that stops. Nothing here is allowed to be fatal: the
      // tournament continues either way, and the next tick tries again.
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
