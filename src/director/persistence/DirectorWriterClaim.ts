/**
 * Coordinates browser Director writers for one tournament document.
 *
 * Native Director is single-instance, but a browser can open the same document in more than one
 * tab. Web Locks is authoritative when it exists. BroadcastChannel is the fallback: a live holder
 * answers probes and sends heartbeats, while a stopped holder can be reclaimed after the response
 * window expires.
 */

export const directorWriterResponseTimeoutMs = 500;
export const directorWriterHeartbeatMs = 2_000;

export interface DirectorWriterChannel {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

interface DirectorWriterLock {
  readonly name: string;
}

interface DirectorWriterLocks {
  request(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: DirectorWriterLock | null) => Promise<void> | void,
  ): Promise<void>;
}

export type DirectorWriterClaimMode = 'web-lock' | 'broadcast-channel' | 'unavailable';

export interface DirectorWriterClaim {
  /** False means this tab must remain read-only. */
  readonly held: boolean;
  /** Aborted when a live fallback claim loses an election to another tab. */
  readonly lost: AbortSignal;
  readonly mode: DirectorWriterClaimMode;
  release(): void;
}

export interface DirectorWriterClaimOptions {
  tournamentId: string;
  documentId: string;
  tabId?: string;
  signal?: AbortSignal;
  /** Inject null to force the BroadcastChannel fallback in tests. */
  locks?: DirectorWriterLocks | null;
  /** Inject null to exercise unavailable-browser behavior or a test channel. */
  channel?: DirectorWriterChannel | null;
  responseTimeoutMs?: number;
  heartbeatMs?: number;
}

type WriterMessage =
  | { kind: 'probe'; scope: string; tabId: string }
  | { kind: 'candidate'; scope: string; tabId: string }
  | { kind: 'claim'; scope: string; tabId: string; claimIssuedAt: number }
  | { kind: 'heartbeat'; scope: string; tabId: string; claimIssuedAt: number };

function scopeFor(tournamentId: string, documentId: string): string {
  return `${encodeURIComponent(tournamentId)}:${encodeURIComponent(documentId)}`;
}

export function directorWriterChannelName(tournamentId: string, documentId: string): string {
  return `qbsheet.director-writer.${scopeFor(tournamentId, documentId)}`;
}

function defaultChannel(tournamentId: string, documentId: string): DirectorWriterChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(directorWriterChannelName(tournamentId, documentId));
  } catch {
    return null;
  }
}

function defaultLocks(): DirectorWriterLocks | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator & { locks?: DirectorWriterLocks }).locks ?? null;
}

function newTabId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  }
  const clock = typeof performance !== 'undefined' ? performance.now().toFixed(0) : Date.now().toString();
  return `director-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}-${clock}`;
}

function unavailable(mode: DirectorWriterClaimMode = 'unavailable'): DirectorWriterClaim {
  return { held: false, lost: new AbortController().signal, mode, release: () => undefined };
}

async function claimWithWebLock(
  lockManager: DirectorWriterLocks,
  lockName: string,
): Promise<DirectorWriterClaim | null> {
  let acquiredResolve: (value: boolean) => void = () => undefined;
  let acquiredReject: (error: unknown) => void = () => undefined;
  const acquired = new Promise<boolean>((resolve, reject) => {
    acquiredResolve = resolve;
    acquiredReject = reject;
  });
  let releaseLock: (() => void) | undefined;
  let released = false;
  let callbackStarted = false;

  try {
    void lockManager
      .request(lockName, { ifAvailable: true }, async (lock) => {
        callbackStarted = true;
        if (!lock) {
          acquiredResolve(false);
          return;
        }
        const untilRelease = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
        acquiredResolve(true);
        await untilRelease;
      })
      .catch((error) => {
        if (!callbackStarted) acquiredReject(error);
      });
  } catch {
    return null;
  }

  try {
    if (!(await acquired)) return unavailable('web-lock');
    const lost = new AbortController();
    return {
      held: true,
      lost: lost.signal,
      mode: 'web-lock',
      release: () => {
        if (released) return;
        released = true;
        releaseLock?.();
      },
    };
  } catch {
    return null;
  }
}

async function claimWithBroadcastChannel(
  channel: DirectorWriterChannel,
  scope: string,
  tabId: string,
  responseTimeoutMs: number,
  heartbeatMs: number,
  signal?: AbortSignal,
): Promise<DirectorWriterClaim> {
  const lost = new AbortController();
  const candidates = new Set<string>([tabId]);
  let holderResponded = false;
  let claimed = false;
  let closed = false;
  let broken = false;
  let claimIssuedAt: number | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // A fallback holder is leased, rather than immortal. The default heartbeat is deliberately
  // longer than the election response window, so use a lease at least two heartbeat periods long
  // or a healthy tab could be reclaimed between heartbeats. A suspended tab that resumes after
  // this lease must yield even if its tab id would otherwise win the deterministic election.
  const leaseTimeoutMs = Math.max(responseTimeoutMs, heartbeatMs * 2);

  const post = (message: WriterMessage) => {
    try {
      channel.postMessage(message);
    } catch {
      broken = true;
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    channel.removeEventListener('message', listener);
    try {
      channel.close();
    } catch {
      // Closing during browser teardown is best effort.
    }
  };

  const lose = () => {
    if (!claimed || lost.signal.aborted) return;
    claimed = false;
    close();
    lost.abort();
  };

  const listener = (event: MessageEvent) => {
    const message = event.data as WriterMessage | undefined;
    if (!message || message.scope !== scope || message.tabId === tabId) return;
    if (message.kind === 'probe') {
      if (claimed && claimIssuedAt !== null) post({ kind: 'heartbeat', scope, tabId, claimIssuedAt });
      return;
    }
    if (message.kind === 'candidate') {
      candidates.add(message.tabId);
      if (claimed && claimIssuedAt !== null) post({ kind: 'heartbeat', scope, tabId, claimIssuedAt });
      return;
    }
    if (message.kind === 'claim' || message.kind === 'heartbeat') {
      candidates.add(message.tabId);
      const incomingAge = Math.max(0, Date.now() - message.claimIssuedAt);
      if (claimed && claimIssuedAt !== null) {
        const ownLeaseExpired = Date.now() - claimIssuedAt >= leaseTimeoutMs;
        // Within one election, the lowest tab id remains the deterministic winner even if the
        // contenders' timers fired a few milliseconds apart. Once our lease has expired, however,
        // the resumed tab must yield to the new claim regardless of tab-id ordering.
        if (ownLeaseExpired || message.tabId < tabId) lose();
        else if (claimIssuedAt !== null) post({ kind: 'heartbeat', scope, tabId, claimIssuedAt });
      } else if (incomingAge < leaseTimeoutMs) {
        holderResponded = true;
      }
    }
  };

  channel.addEventListener('message', listener);
  if (signal?.aborted) {
    close();
    return unavailable();
  }
  post({ kind: 'probe', scope, tabId });
  post({ kind: 'candidate', scope, tabId });
  await new Promise<void>((resolve) => {
    // A live holder answers the probe immediately; the longer lease is only for deciding whether
    // an already-held claim is stale when a suspended tab resumes.
    const timer = setTimeout(resolve, responseTimeoutMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

  if (signal?.aborted) {
    close();
    return unavailable();
  }

  if (broken) {
    close();
    return unavailable();
  }
  if (holderResponded || [...candidates].some((candidate) => candidate < tabId)) {
    close();
    return unavailable('broadcast-channel');
  }

  claimed = true;
  claimIssuedAt = Date.now();
  post({ kind: 'claim', scope, tabId, claimIssuedAt });
  post({ kind: 'heartbeat', scope, tabId, claimIssuedAt });
  heartbeat = setInterval(() => {
    if (claimIssuedAt !== null) post({ kind: 'heartbeat', scope, tabId, claimIssuedAt });
  }, heartbeatMs);
  return {
    held: true,
    lost: lost.signal,
    mode: 'broadcast-channel',
    release: () => {
      if (closed) return;
      claimed = false;
      close();
    },
  };
}

/** Try to become the sole browser Director writer for one tournament document. */
export async function claimDirectorWriter(options: DirectorWriterClaimOptions): Promise<DirectorWriterClaim> {
  const scope = scopeFor(options.tournamentId, options.documentId);
  const tabId = options.tabId ?? newTabId();
  const locks = options.locks === undefined ? defaultLocks() : options.locks;
  if (locks) {
    const webLockClaim = await claimWithWebLock(locks, `qbsheet.director-writer.${scope}`);
    if (webLockClaim) return webLockClaim;
  }

  const channel =
    options.channel === undefined
      ? defaultChannel(options.tournamentId, options.documentId)
      : options.channel;
  if (!channel) return unavailable();
  return claimWithBroadcastChannel(
    channel,
    scope,
    tabId,
    options.responseTimeoutMs ?? directorWriterResponseTimeoutMs,
    options.heartbeatMs ?? directorWriterHeartbeatMs,
    options.signal,
  );
}
