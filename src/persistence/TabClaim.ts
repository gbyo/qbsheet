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

export interface IGameClaim {
  /** False when another live tab answered that it already holds this game. */
  readonly held: boolean;
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
  channel: IChannelLike | null = defaultChannel(),
  timeoutMs: number = claimResponseTimeoutMs,
): Promise<IGameClaim> {
  if (!channel) return { held: true, release: () => undefined };

  let heldByAnother = false;
  const listener = (event: MessageEvent) => {
    const message = event.data as ClaimMessage | undefined;
    if (!message || message.gameId !== gameId || message.from === tabId) return;
    if (message.kind === 'holding') heldByAnother = true;
    // Somebody new is asking and we are the holder: answer, so they stand down.
    if (message.kind === 'who-holds' && claimed) {
      channel.postMessage({ kind: 'holding', gameId, from: tabId } satisfies ClaimMessage);
    }
  };
  let claimed = false;
  channel.addEventListener('message', listener);

  channel.postMessage({ kind: 'who-holds', gameId, from: tabId } satisfies ClaimMessage);
  await new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });

  if (heldByAnother) {
    channel.removeEventListener('message', listener);
    channel.close();
    return { held: false, release: () => undefined };
  }

  claimed = true;
  channel.postMessage({ kind: 'holding', gameId, from: tabId } satisfies ClaimMessage);
  const heartbeat = setInterval(() => {
    channel.postMessage({ kind: 'holding', gameId, from: tabId } satisfies ClaimMessage);
  }, claimHeartbeatMs);

  return {
    held: true,
    release: () => {
      claimed = false;
      clearInterval(heartbeat);
      channel.removeEventListener('message', listener);
      channel.close();
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
