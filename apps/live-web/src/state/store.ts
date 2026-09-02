/**
 * Live Web's client state.
 *
 * # Why a hand-written store
 *
 * This bundle is loaded over a school's WiFi by a few hundred phones at once, from a link somebody
 * photographed. Every kilobyte is a person waiting. A state library would be most of the JavaScript
 * on the page, and what it would manage is one snapshot, two identifiers, and a connection status.
 *
 * # What persists
 *
 * The publication, the backend, the followed team, the selected player, and the last snapshot —
 * so that reopening the tab in a building with no signal still shows the tournament, marked stale.
 * Everything is per-device personalization. None of it authorizes anything.
 */

import {
  applyEvent,
  parseSnapshot,
  QbliveClient,
  QbliveClientError,
  type QbliveManifest,
  type QbliveSnapshot,
} from '@qbsheet/qblive-protocol';

export type ConnectionState =
  /** Nothing loaded yet. */
  | 'loading'
  /** A WebSocket is open and delivering events. */
  | 'live'
  /** No stream; refreshing on a timer or on demand. */
  | 'polling'
  /** Showing cached data. The age indicator is on. */
  | 'offline'
  /** Unrecoverable: a bad link, a deleted tournament. */
  | 'error';

export interface LiveWebState {
  publicationId: string | null;
  backendOrigin: string | null;
  snapshot: QbliveSnapshot | null;
  manifest: QbliveManifest | null;
  followedTeamId: string | null;
  selectedPlayerId: string | null;
  connection: ConnectionState;
  /** When the currently displayed snapshot was received by this device. */
  receivedAt: number | null;
  error: string | null;
}

const storageKey = 'qbsheet.live.v1';

/**
 * The browser's own `localStorage`.
 *
 * Reached through `window` rather than as a bare global because some JavaScript hosts — Node 26
 * among them — define a global `localStorage` that is not the document's, and a bare reference
 * silently picks the wrong one. Returns null wherever storage is unavailable: private browsing, a
 * disabled origin, or a non-browser host.
 */
function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

interface PersistedState {
  publicationId: string;
  backendOrigin: string;
  followedTeamId: string | null;
  selectedPlayerId: string | null;
  snapshot: unknown;
  receivedAt: number;
}

/**
 * Read the cached tournament.
 *
 * The cached snapshot is re-validated on the way in, not trusted. It was written by this origin,
 * but localStorage is editable and a corrupt entry should degrade to "no cache" rather than to a
 * crashed page in a gym with no signal.
 */
export function readCache(publicationId: string): Partial<LiveWebState> | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(`${storageKey}.${publicationId}`);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    return {
      publicationId: parsed.publicationId,
      backendOrigin: parsed.backendOrigin,
      followedTeamId: parsed.followedTeamId ?? null,
      selectedPlayerId: parsed.selectedPlayerId ?? null,
      snapshot: parsed.snapshot ? parseSnapshot(parsed.snapshot) : null,
      receivedAt: typeof parsed.receivedAt === 'number' ? parsed.receivedAt : null,
    };
  } catch {
    try {
      store.removeItem(`${storageKey}.${publicationId}`);
    } catch {
      // Private browsing. Nothing to clean up.
    }
    return null;
  }
}

export function writeCache(state: LiveWebState): void {
  if (!state.publicationId || !state.backendOrigin) return;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(
      `${storageKey}.${state.publicationId}`,
      JSON.stringify({
        publicationId: state.publicationId,
        backendOrigin: state.backendOrigin,
        followedTeamId: state.followedTeamId,
        selectedPlayerId: state.selectedPlayerId,
        snapshot: state.snapshot,
        receivedAt: state.receivedAt ?? Date.now(),
      } satisfies PersistedState),
    );
  } catch {
    // Quota, private mode, or a disabled origin. Caching is a convenience; the page still works.
  }
}

/** The most recently opened tournament, so a notification tap or a bare visit reopens it. */
export function rememberLastPublication(publicationId: string, backendOrigin: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(`${storageKey}.last`, JSON.stringify({ publicationId, backendOrigin }));
  } catch {
    // See above.
  }
}

export function readLastPublication(): { publicationId: string; backendOrigin: string } | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(`${storageKey}.last`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { publicationId?: string; backendOrigin?: string };
    if (!parsed.publicationId || !parsed.backendOrigin) return null;
    return { publicationId: parsed.publicationId, backendOrigin: parsed.backendOrigin };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

export interface ConnectionHooks {
  onSnapshot(snapshot: QbliveSnapshot): void;
  onConnection(connection: ConnectionState, error?: string): void;
}

/**
 * Keep a snapshot current, by whatever means the backend supports.
 *
 * The hierarchy is the one in `docs/QBLIVE.md`: a WebSocket while it is useful, event replay to
 * close a gap, and a full snapshot reload when replay cannot help. A backend that advertises
 * neither falls back to conservative polling.
 *
 * Polling is 30 seconds, not 3. Three hundred phones in one building polling every three seconds is
 * a hundred requests a second against a tournament director's own Cloudflare account, to show a
 * schedule that changes twice an hour. The tradeoff only makes sense the other way for live scores,
 * and live scores arrive over the socket when there is one.
 */
export class LiveConnection {
  private socket: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;
  private snapshot: QbliveSnapshot | null = null;

  constructor(
    private readonly client: QbliveClient,
    private readonly hooks: ConnectionHooks,
    private readonly pollIntervalMs = 30_000,
  ) {}

  async start(cached: QbliveSnapshot | null): Promise<void> {
    this.snapshot = cached;
    await this.loadSnapshot();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  /** Called on pull-to-refresh, on the Refresh button, and when the tab becomes visible again. */
  async refresh(): Promise<void> {
    await this.loadSnapshot();
  }

  private async loadSnapshot(): Promise<void> {
    if (this.stopped) return;
    try {
      const manifest = await this.client.manifest();
      const snapshot =
        this.snapshot && this.snapshot.revision === manifest.revision
          ? this.snapshot
          : await this.client.snapshot();
      this.snapshot = snapshot;
      this.attempts = 0;
      this.hooks.onSnapshot(snapshot);
      if (manifest.capabilities.stream) this.openStream(manifest);
      else {
        this.startPolling();
        this.hooks.onConnection('polling');
      }
    } catch (reason) {
      this.handleFailure(reason);
    }
  }

  private openStream(manifest: QbliveManifest): void {
    const url = this.client.streamUrl(manifest);
    if (!url) {
      this.startPolling();
      return;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.attempts = 0;
      this.hooks.onConnection('live');
    });
    socket.addEventListener('message', (event) => void this.onFrame(String(event.data)));
    socket.addEventListener('close', () => {
      if (this.stopped || this.socket !== socket) return;
      this.socket = null;
      // Fall back to polling immediately so the page keeps updating, and try the socket again with
      // backoff. A reconnect storm after a WiFi blip is the failure mode to avoid here.
      this.startPolling();
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => socket.close());
  }

  private async onFrame(data: string): Promise<void> {
    let frame: { type?: string; event?: unknown; revision?: number; currentRevision?: number };
    try {
      frame = JSON.parse(data) as typeof frame;
    } catch {
      return;
    }
    // Unknown frame types are ignored on purpose: a future server must be able to add one.
    if (frame.type === 'hello') {
      const revision = typeof frame.revision === 'number' ? frame.revision : 0;
      if (this.snapshot && revision > this.snapshot.revision) await this.catchUp(this.snapshot.revision);
      return;
    }
    if (frame.type === 'resync') {
      await this.loadSnapshot();
      return;
    }
    if (frame.type === 'final') {
      await this.loadSnapshot();
      return;
    }
    if (frame.type !== 'event' || !this.snapshot) return;
    const event = frame.event as { revision?: number };
    if (typeof event?.revision !== 'number') return;
    if (event.revision <= this.snapshot.revision) return;
    if (event.revision > this.snapshot.revision + 1) {
      await this.catchUp(this.snapshot.revision);
      return;
    }
    try {
      // Re-validated rather than trusted: this arrived over a socket to somebody else's server.
      const parsed = parseSnapshot(applyEvent(this.snapshot, event as never));
      this.snapshot = parsed;
      this.hooks.onSnapshot(parsed);
    } catch {
      await this.loadSnapshot();
    }
  }

  private async catchUp(after: number): Promise<void> {
    try {
      const page = await this.client.events(after);
      if (page.resyncRequired) {
        await this.loadSnapshot();
        return;
      }
      let snapshot = this.snapshot;
      if (!snapshot) {
        await this.loadSnapshot();
        return;
      }
      for (const event of page.events) snapshot = applyEvent(snapshot, event);
      this.snapshot = parseSnapshot(snapshot);
      this.hooks.onSnapshot(this.snapshot);
    } catch {
      await this.loadSnapshot();
    }
  }

  /**
   * Start the refresh timer.
   *
   * Deliberately silent about the connection state. Polling is started both after a successful load
   * and after a failure, and reporting `polling` here would overwrite the `offline` the failure
   * path just set — telling a spectator their stale data is current, which is the one thing the
   * staleness indicator exists to prevent.
   */
  private startPolling(): void {
    if (this.pollTimer || this.stopped) return;
    this.pollTimer = setInterval(() => {
      // A backgrounded tab is not looking at anything. Not polling it is both politeness to the
      // tournament's backend and battery on the spectator's phone.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void this.poll();
    }, this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    try {
      const manifest = await this.client.manifest();
      if (this.snapshot && manifest.revision === this.snapshot.revision) {
        // Reached the backend and there is nothing new. Say so, which also clears an earlier
        // `offline` once connectivity comes back without the revision having moved.
        this.hooks.onConnection('polling');
        this.attempts = 0;
        return;
      }
      const snapshot = await this.client.snapshot();
      this.snapshot = snapshot;
      this.attempts = 0;
      this.hooks.onSnapshot(snapshot);
      this.hooks.onConnection('polling');
    } catch (reason) {
      this.handleFailure(reason);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    this.attempts += 1;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(this.attempts, 6));
    // Full jitter, so a building's worth of phones does not reconnect in the same millisecond.
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        void this.loadSnapshot();
      },
      delay / 2 + Math.random() * (delay / 2),
    );
  }

  private handleFailure(reason: unknown): void {
    const fatal =
      reason instanceof QbliveClientError && (reason.code === 'not-found' || reason.code === 'gone');
    if (fatal) {
      this.hooks.onConnection('error', reason.message);
      return;
    }
    // Not fatal: keep showing what we have, say how old it is, and keep trying.
    this.hooks.onConnection(
      'offline',
      reason instanceof Error ? reason.message : 'The tournament server could not be reached.',
    );
    this.startPolling();
    this.scheduleReconnect();
  }
}
