/**
 * Director's QBSheet Live publication pipeline.
 *
 * # The rule this module exists to enforce
 *
 * A local tournament mutation must never wait on, or fail because of, the internet. So publishing
 * is not a step in the mutation; it is a consequence recorded alongside it:
 *
 * ```
 * mutate DirectorState
 *      ↓
 * derive the public projection
 *      ↓
 * if the projection changed, append to state.live.outbox
 *      ↓
 * the same save() that persists the tournament persists the outbox
 *      ↓
 * a background worker drains it, later, with retries
 * ```
 *
 * Because the outbox lives inside `DirectorState`, the atomicity is free: the Tauri store already
 * writes the whole document in one SQLite transaction, so a tournament can never be saved with the
 * accepted result present and the knowledge that it needs publishing missing.
 *
 * See `docs/QBLIVE.md#8-the-durable-outbox`.
 */

import {
  isoNow,
  newDirectorId,
  type DirectorState,
  type LiveAnnouncement,
  type LiveOutboxItem,
  type LivePublication,
} from '../domain';
import {
  changedSections,
  isTransientOnly,
  pickSections,
  projectLiveSnapshot,
  type ProjectionInput,
} from '@qbsheet/qblive-projection';
import type { QbliveCapabilities, QbliveSectionName, QbliveSnapshot } from '@qbsheet/qblive-protocol';

/**
 * The capability set Director claims on behalf of its backend.
 *
 * Director does not know what the backend supports until it has talked to it, and the snapshot has
 * to carry something. Claiming the Cloudflare reference implementation's capabilities is right for
 * the recommended path; `applePush` is the one that is only true once push registration succeeds.
 */
export function directorCapabilities(publication: LivePublication | null): QbliveCapabilities {
  const local = publication?.backend?.kind === 'local';
  return {
    snapshot: true,
    events: !local,
    stream: true,
    applePush: publication?.push.status === 'enabled',
  };
}

/**
 * How many outbox items to keep before collapsing to a full snapshot.
 *
 * A Director that has been offline for two hours does not need to replay two hours of score ticks
 * when it reconnects; it needs the current state. Past this bound the queue is replaced with one
 * snapshot item, which is both smaller and exactly what a spectator wants to see.
 */
export const maxOutboxItems = 64;

export interface DeriveOptions {
  /** Passed in so the derivation stays a pure function of its inputs. */
  now?: Date;
  /** Set when the tournament is being finalized. */
  final?: boolean;
}

export interface DerivedPublication {
  /** The publication as it should be persisted, or null when nothing changed. */
  live: LivePublication | null;
  /** The new snapshot, for the caller to cache. Null when publication is off. */
  snapshot: QbliveSnapshot | null;
  /** Which sections changed. Empty when nothing did. */
  changed: QbliveSectionName[];
}

/**
 * Derive the next public state and queue what needs publishing.
 *
 * Pure: takes the state, the previously published snapshot, and the clock, and returns what to
 * store. The caller commits the result with the rest of the document.
 *
 * Returns `live: null` when nothing changed, which is the common case — most Director mutations do
 * not alter anything public, and a publication that re-queued on every keystroke would spend a
 * tournament's bandwidth on nothing.
 */
export function derivePublication(
  state: DirectorState,
  previous: QbliveSnapshot | null,
  options: DeriveOptions = {},
): DerivedPublication {
  const publication = state.live;
  if (!publication || !publication.settings.enabled || publication.lifecycle === 'unpublished') {
    return { live: null, snapshot: null, changed: [] };
  }
  const now = options.now ?? new Date();
  const input: ProjectionInput = {
    state,
    settings: publication.settings,
    publicationId: publication.publicationId,
    // A candidate revision. Only committed if something actually changed.
    revision: publication.sync.localRevision + 1,
    generatedAt: now,
    capabilities: directorCapabilities(publication),
    final: options.final ?? publication.lifecycle === 'final',
  };
  const snapshot = projectLiveSnapshot(input);
  const changed = changedSections(previous, snapshot);
  if (changed.length === 0) return { live: null, snapshot: previous, changed: [] };

  const item: LiveOutboxItem = {
    id: newDirectorId('liveout'),
    revision: snapshot.revision,
    // The first publication, and a finalization, must be a whole snapshot: the backend has nothing
    // to apply sections to, and a final page must not depend on replay history.
    kind: previous === null || input.final ? 'snapshot' : 'sections',
    payload:
      previous === null || input.final
        ? { snapshot }
        : {
            baseRevision: publication.sync.acknowledgedRevision,
            revision: snapshot.revision,
            generatedAt: snapshot.generatedAt,
            sections: pickSections(snapshot, changed),
          },
    state: 'pending',
    attempts: 0,
    createdAt: now.toISOString(),
    nextAttemptAt: now.toISOString(),
  };

  const outbox = collapseOutbox([...publication.outbox, item], snapshot, now);
  return {
    live: {
      ...publication,
      outbox,
      sync: {
        ...publication.sync,
        localRevision: snapshot.revision,
        pendingItems: outbox.filter((entry) => entry.state !== 'done').length,
      },
      updatedAt: now.toISOString(),
    },
    snapshot,
    changed,
  };
}

/**
 * Keep the outbox bounded and free of superseded transient state.
 *
 * Two reductions, in order of how much they save:
 *
 * 1. **Transient coalescing.** Consecutive pending items that only touch transient sections —
 *    `liveGames` — are collapsed to the newest. A spectator who reconnects wants the current score,
 *    not the sequence that produced it. See `docs/QBLIVE.md#61-high-frequency-state`.
 * 2. **Snapshot collapse.** Past `maxOutboxItems`, everything pending is replaced by one snapshot.
 *    A long outage produces a queue whose contents are, together, exactly the current state; one
 *    snapshot says the same thing in one request.
 *
 * Items already in flight are never touched: the worker holds a reference to them and a
 * substitution underneath it would make the acknowledgement ambiguous.
 */
export function collapseOutbox(
  outbox: LiveOutboxItem[],
  snapshot: QbliveSnapshot,
  now: Date,
): LiveOutboxItem[] {
  const settled = outbox.filter((item) => item.state === 'in-flight');
  const pending = outbox.filter((item) => item.state === 'pending' || item.state === 'failed');

  if (settled.length + pending.length > maxOutboxItems) {
    return [
      ...settled,
      {
        id: newDirectorId('liveout'),
        revision: snapshot.revision,
        kind: 'snapshot',
        payload: { snapshot },
        state: 'pending',
        attempts: 0,
        createdAt: now.toISOString(),
        nextAttemptAt: now.toISOString(),
      },
    ];
  }

  const coalesced: LiveOutboxItem[] = [];
  for (const item of pending) {
    const previous = coalesced.at(-1);
    if (
      previous &&
      previous.kind === 'sections' &&
      item.kind === 'sections' &&
      isTransientOnly(sectionNamesOf(previous)) &&
      isTransientOnly(sectionNamesOf(item))
    ) {
      // Replace, but keep the earlier item's base revision: the newer payload still has to apply on
      // top of whatever the backend last acknowledged, not on top of the item it replaced.
      coalesced[coalesced.length - 1] = {
        ...item,
        id: previous.id,
        createdAt: previous.createdAt,
        payload: {
          ...(item.payload as Record<string, unknown>),
          baseRevision: basePayloadRevision(previous),
        },
      };
      continue;
    }
    coalesced.push(item);
  }
  return [...settled, ...coalesced];
}

function sectionNamesOf(item: LiveOutboxItem): QbliveSectionName[] {
  const payload = item.payload as { sections?: Record<string, unknown> } | null;
  return payload?.sections ? (Object.keys(payload.sections) as QbliveSectionName[]) : [];
}

function basePayloadRevision(item: LiveOutboxItem): number {
  const payload = item.payload as { baseRevision?: number } | null;
  return payload?.baseRevision ?? 0;
}

/**
 * Record a successful publish.
 *
 * The acknowledged revision moves to what the backend reported, not to what Director sent: a
 * backend that applied something different is the authority on where it now is, and the next
 * section update's `baseRevision` has to match it or be refused.
 */
export function acknowledgeOutboxItem(
  publication: LivePublication,
  itemId: string,
  acknowledgedRevision: number,
  at = new Date(),
): LivePublication {
  const outbox = publication.outbox.filter((item) => item.id !== itemId);
  return {
    ...publication,
    outbox,
    sync: {
      ...publication.sync,
      acknowledgedRevision,
      pendingItems: outbox.filter((item) => item.state !== 'done').length,
      lastSuccessAt: at.toISOString(),
      lastAttemptAt: at.toISOString(),
      lastError: null,
      retrying: false,
    },
    updatedAt: at.toISOString(),
  };
}

/** The retry schedule: exponential with jitter, capped so a long outage still retries every minute. */
export function backoffMilliseconds(attempts: number, random = Math.random): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
  // Full jitter. Several Directors that lost the same conference-centre WiFi must not all retry in
  // the same millisecond when it returns.
  return Math.round(base / 2 + random() * (base / 2));
}

export type PublishFailureKind =
  /** Transient: the network, a 5xx, a timeout. Retry with backoff. */
  | 'transient'
  /** The backend has moved on. Repair with a full snapshot rather than retrying the same update. */
  | 'conflict'
  /** The credential is wrong or the publication is gone. Retrying cannot help; stop and tell the Director. */
  | 'fatal';

export interface PublishFailure {
  kind: PublishFailureKind;
  message: string;
  /** Present on a conflict. */
  currentRevision?: number;
}

/**
 * Record a failed publish and decide what happens next.
 *
 * The three kinds behave differently on purpose. A transient failure backs off and stays queued. A
 * conflict discards the queued update — it can never apply — and queues a full snapshot instead. A
 * fatal failure stops the loop: a wrong credential retried every minute for eight hours is a
 * Director spending its battery on a problem only a human can fix.
 */
export function recordOutboxFailure(
  publication: LivePublication,
  itemId: string,
  failure: PublishFailure,
  snapshot: QbliveSnapshot | null,
  at = new Date(),
  random = Math.random,
): LivePublication {
  const now = at.toISOString();

  if (failure.kind === 'conflict' && snapshot) {
    const repaired: LiveOutboxItem = {
      id: newDirectorId('liveout'),
      revision: snapshot.revision,
      kind: 'snapshot',
      payload: { snapshot },
      state: 'pending',
      attempts: 0,
      createdAt: now,
      nextAttemptAt: now,
    };
    const outbox = [...publication.outbox.filter((item) => item.id !== itemId), repaired];
    return {
      ...publication,
      outbox,
      sync: {
        ...publication.sync,
        acknowledgedRevision: failure.currentRevision ?? publication.sync.acknowledgedRevision,
        pendingItems: outbox.length,
        lastAttemptAt: now,
        lastError: failure.message,
        retrying: true,
      },
      updatedAt: now,
    };
  }

  const outbox = publication.outbox.map((item) => {
    if (item.id !== itemId) return item;
    const attempts = item.attempts + 1;
    return {
      ...item,
      state: 'failed' as const,
      attempts,
      lastAttemptAt: now,
      lastError: failure.message,
      nextAttemptAt:
        failure.kind === 'fatal'
          ? null
          : new Date(at.getTime() + backoffMilliseconds(attempts, random)).toISOString(),
    };
  });

  return {
    ...publication,
    outbox,
    sync: {
      ...publication.sync,
      pendingItems: outbox.filter((item) => item.state !== 'done').length,
      lastAttemptAt: now,
      lastError: failure.message,
      retrying: failure.kind !== 'fatal',
    },
    updatedAt: now,
  };
}

/** The next item the worker should attempt, or null when nothing is due. */
export function nextOutboxItem(publication: LivePublication, at = new Date()): LiveOutboxItem | null {
  for (const item of publication.outbox) {
    if (item.state === 'in-flight' || item.state === 'done') continue;
    if (item.nextAttemptAt === null) continue;
    if (item.nextAttemptAt && Date.parse(item.nextAttemptAt) > at.getTime()) continue;
    return item;
  }
  return null;
}

export interface NewAnnouncementInput {
  title: string;
  body: string;
  severity: LiveAnnouncement['severity'];
  audienceTeamIds?: string[];
  expiresAt?: string | null;
}

/** Compose an announcement. Publication happens through the ordinary projection and outbox. */
export function composeAnnouncement(input: NewAnnouncementInput, at = new Date()): LiveAnnouncement {
  return {
    id: newDirectorId('announce'),
    title: input.title.trim(),
    body: input.body.trim(),
    severity: input.severity,
    audienceTeamIds: input.audienceTeamIds ? [...input.audienceTeamIds] : [],
    publishedAt: at.toISOString(),
    updatedAt: null,
    expiresAt: input.expiresAt ?? null,
  };
}

/** A human sentence for the Director's sync panel. Never a stack trace, never a URL with a token. */
export function syncSummary(publication: LivePublication | null): string {
  if (!publication || !publication.settings.enabled) return 'QBSheet Live is off.';
  if (publication.lifecycle === 'unpublished') return 'This tournament has been unpublished.';
  const pending = publication.sync.pendingItems;
  if (publication.sync.lastError && pending > 0) {
    return `Live backend unreachable. ${pending} ${pending === 1 ? 'update is' : 'updates are'} queued locally. Tournament operation is unaffected.`;
  }
  if (pending > 0) return `Publishing ${pending} ${pending === 1 ? 'update' : 'updates'}…`;
  if (publication.lifecycle === 'final') return 'Final results published.';
  if (!publication.sync.lastSuccessAt) return 'Not published yet.';
  return `Live · synced at revision ${publication.sync.acknowledgedRevision}.`;
}

/** Director's clock, isolated so tests can be deterministic. */
export function nowIso(): string {
  return isoNow();
}
