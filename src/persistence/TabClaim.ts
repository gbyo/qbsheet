/**
 * Noticing that the same game is open twice on the same device.
 *
 * # What this is for, and what it is not
 *
 * Two tabs on one Chromebook scoring the same game is a real thing that happens — a scorekeeper
 * restores a closed tab, or opens the site again rather than switching windows — and the failure is
 * quiet: both tabs write to the same journal, the last write wins, and half the questions vanish
 * without anybody seeing an error.
 *
 * This is a convenience guard against that, and it is deliberately not the integrity mechanism.
 * `BroadcastChannel` only reaches tabs that are running right now, in the same browser, on the same
 * origin; it says nothing after a crash, it says nothing across profiles, and a message can simply
 * not arrive. Local persistence remains the authority on what was scored, and recovery remains the
 * thing that actually protects a room. This just stops the honest mistake before it costs anything.
 *
 * # Why a heartbeat rather than a lock
 *
 * A lock needs releasing, and the case that matters most — a tab that was closed without ceremony,
 * or a browser that was killed — is exactly the case where nothing gets released. So the holder
 * announces itself while it is alive and a new tab asks whether anybody answers. Silence means the
 * game is free, which is the safe way round: the worst outcome of a missed answer is a second tab
 * that opens a game it could have opened anyway.
 */

export const claimChannelName = 'qbsheet.game-claims';

/** How long a new tab waits for an existing holder to answer before deciding there is none. */
export const claimResponseTimeoutMs = 300;

/** How often a holder re-announces, so a claim cannot outlive the tab holding it by much. */
export const claimHeartbeatMs = 2000;

type ClaimMessage =
  | { kind: 'who-holds'; gameId: string; from: string }
  | { kind: 'candidate'; gameId: string; from: string }
  | { kind: 'claim'; gameId: string; from: string }
  | { kind: 'holding'; gameId: string; from: string };

export interface IChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

function defaultChannel(): IChannelLike | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(claimChannelName);
  } catch {
    return null;
  }
}

/**
 * Prefer the browser's actual writer lock. The promise returned by `locks.request` stays pending for
 * the lifetime of the claim, so acquisition and release are deliberately split into two promises.
 */
async function claimWithWebLock(gameId: string): Promise<IGameClaim | null> {
  if (typeof navigator === 'undefined' || !('locks' in navigator) || !navigator.locks) return null;

  let resolveAcquired: (held: boolean) => void = () => undefined;
  const acquired = new Promise<boolean>((resolve) => {
    resolveAcquired = resolve;
  });
  let releaseLock: () => void = () => undefined;
  let released = false;

  try {
    void navigator.locks
      .request(`qbsheet.game.${gameId}`, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolveAcquired(false);
          return undefined;
        }
        const heldUntilReleased = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
        resolveAcquired(true);
        await heldUntilReleased;
        return undefined;
      })
      .catch(() => resolveAcquired(false));
  } catch {
    // A partial Web Locks implementation is no better than no Web Locks. The caller can use the
    // BroadcastChannel election below instead.
    return null;
  }

  const held = await acquired;
  const lost = new AbortController();
  if (!held) return { held: false, lost: lost.signal, release: () => undefined };
  return {
    held: true,
    lost: lost.signal,
    release: () => {
      if (released) return;
      released = true;
      releaseLock();
    },
  };
}

export interface IGameClaim {
  /** False when another live tab answered that it already holds this game. */
  readonly held: boolean;
  /** Aborted if a fallback election later discovers that this tab is not the owner. */
  readonly lost: AbortSignal;
  release(): void;
}

/**
 * Try to become the tab that is scoring this game.
 *
 * @returns a claim. `held === false` means somebody else answered; the caller should offer to go
 * home rather than opening a second scoresheet. A browser with no `BroadcastChannel` always
 * succeeds, because an unavailable guard must not be a reason a room cannot score.
 */
export async function claimGame(
  gameId: string,
  tabId: string,
  channel?: IChannelLike | null,
  timeoutMs: number = claimResponseTimeoutMs,
): Promise<IGameClaim> {
  const webLockClaim = await claimWithWebLock(gameId);
  if (webLockClaim) return webLockClaim;

  const claimChannel = channel === undefined ? defaultChannel() : channel;
  const lost = new AbortController();
  if (!claimChannel) return { held: true, lost: lost.signal, release: () => undefined };

  let heldByAnother = false;
  let lostElection = false;
  const candidates = new Set([tabId]);
  const heartbeat: { handle?: ReturnType<typeof setInterval> } = {};
  let claimed = false;
  let closed = false;

  const post = (message: ClaimMessage) => {
    try {
      claimChannel.postMessage(message);
    } catch {
      // A channel that closes while a tab is being torn down is not a claim conflict.
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat.handle !== undefined) clearInterval(heartbeat.handle);
    claimChannel.removeEventListener('message', listener);
    claimChannel.close();
  };

  const lose = () => {
    if (!claimed || lost.signal.aborted) return;
    claimed = false;
    close();
    // Abort listeners run synchronously, so the host can remove the scorer before another user
    // action is handled. Closing the election channel alone is not enough: the tab may already have
    // rendered writable scoring controls after the initial response timeout.
    lost.abort();
  };

  const listener = (event: MessageEvent) => {
    const message = event.data as ClaimMessage | undefined;
    if (!message || message.gameId !== gameId || message.from === tabId) return;
    if (message.kind === 'candidate') {
      candidates.add(message.from);
      if (!claimed && message.from < tabId) lostElection = true;
      return;
    }
    if (message.kind === 'holding') {
      if (!claimed) {
        heldByAnother = true;
      } else if (message.from < tabId) {
        // Two tabs that crossed the election boundary still converge on one deterministic winner.
        lose();
      } else {
        post({ kind: 'holding', gameId, from: tabId });
      }
      return;
    }
    if (message.kind === 'claim') {
      candidates.add(message.from);
      if (message.from < tabId) {
        lostElection = true;
        if (claimed) lose();
      } else if (claimed) {
        post({ kind: 'holding', gameId, from: tabId });
      }
      return;
    }
    // Somebody new is asking and we are the holder: answer, so they stand down.
    if (message.kind === 'who-holds' && claimed) {
      post({ kind: 'holding', gameId, from: tabId });
    }
  };

  claimChannel.addEventListener('message', listener);

  post({ kind: 'who-holds', gameId, from: tabId });
  // Every contender announces itself before waiting. If two tabs start in the same response window,
  // both hear the other candidate and the lexical tab id chooses one of them before either writes.
  post({ kind: 'candidate', gameId, from: tabId });
  await new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });

  if (heldByAnother || lostElection || [...candidates].some((candidate) => candidate < tabId)) {
    close();
    return { held: false, lost: lost.signal, release: () => undefined };
  }

  claimed = true;
  post({ kind: 'claim', gameId, from: tabId });
  post({ kind: 'holding', gameId, from: tabId });
  heartbeat.handle = setInterval(() => {
    post({ kind: 'holding', gameId, from: tabId });
  }, claimHeartbeatMs);

  return {
    held: true,
    lost: lost.signal,
    release: () => {
      if (closed) return;
      claimed = false;
      close();
    },
  };
}

/** A label for this tab. Not an identity and not persisted; it only has to be different. */
export function newTabId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  }
  return `tab-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}-${performance.now().toFixed(0)}`;
}
