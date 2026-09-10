/**
 * Failure degradation language for Internet QBTCP (#775).
 *
 * # Why this is a separate module
 *
 * A scorekeeper mid-game must get one calm instruction, never a provider error. Cloudflare
 * shape (`1027`, `workers.dev`, `Durable Object`, `cursor`) belongs in diagnostics
 * (`relayDiagnostics.ts`), never in the main scorekeeper message. This module maps the small
 * set of sync/send outcomes onto that language. Every string here is transport- and
 * provider-neutral: the same outage reads the same whether the relay, the venue internet,
 * or the LAN path failed.
 *
 * # The states
 *
 * - `connected` — tournament control is reachable; quiet.
 * - `local` — relay unreachable but LAN QBTCP serves; scoring continues, no action needed.
 * - `reconnecting` — a retryable failure; keep scoring, the device holds the game.
 * - `unavailable` — nothing reachable; the game is saved on this device, retry when connected.
 * - `received` — the result reached durable relay receipt.
 * - `saved-local` — the result is durable on this device only; retry or export when connected.
 */

export type DegradationState =
  'connected' | 'local' | 'reconnecting' | 'unavailable' | 'received' | 'saved-local';

export interface DegradationCopy {
  state: DegradationState;
  title: string;
  detail: string;
}

export interface DegradationInput {
  /** What was attempted: a background sync, or sending one result. */
  kind: 'sync' | 'result-send';
  /** Whether the failure is retryable (quota refusal, 429/5xx, network loss). */
  retryable: boolean;
  /** Whether the Director LAN QBTCP path is currently serving. */
  lanAvailable: boolean;
  /** Whether a final/result is durably held on this device regardless. */
  localDurable: boolean;
}

/**
 * Collapse any transport failure into one meaningful state.
 *
 * Non-retryable failures (refused credential, unsupported version, stale mirror) need a
 * director action, so they read as unavailable-with-next-step rather than as
 * keep-waiting: retrying a refused credential helps nobody. Retryable failures with LAN
 * up read as local; without LAN they read as reconnecting while the outcome is still
 * open, and settle to saved-on-device once the result itself is durable locally.
 */
export function describeRelayDegradation(input: DegradationInput): DegradationCopy {
  if (input.kind === 'result-send') {
    if (input.retryable && input.lanAvailable) {
      return {
        state: 'local',
        title: 'Connected over local network',
        detail: 'The result will go through the local connection. Keep scoring.',
      };
    }
    if (input.retryable && !input.localDurable) {
      return {
        state: 'reconnecting',
        title: 'Reconnecting — keep scoring',
        detail: 'The connection dropped. Keep scoring; nothing is lost.',
      };
    }
    if (input.retryable) {
      return {
        state: 'saved-local',
        title: 'Result saved on this device — retry when connected',
        detail: 'This game is saved here. It will send when a connection returns.',
      };
    }
    return {
      state: 'unavailable',
      title: 'Tournament control unavailable — this game is saved on this device',
      detail: 'Ask the director to check the relay connection. This game is saved here.',
    };
  }
  if (input.retryable && input.lanAvailable) {
    return {
      state: 'local',
      title: 'Connected over local network',
      detail: 'Tournament control is reachable locally. Keep scoring.',
    };
  }
  if (input.retryable) {
    return {
      state: 'reconnecting',
      title: 'Reconnecting — keep scoring',
      detail: 'The connection dropped. Keep scoring; this game is saved on this device.',
    };
  }
  return {
    state: 'unavailable',
    title: 'Tournament control unavailable — this game is saved on this device',
    detail: 'Ask the director to check the relay connection. Scoring continues locally.',
  };
}

/** Result-delivery confirmation copy: durable receipt vs saved-local. */
export function describeResultDelivery(durablyReceived: boolean): DegradationCopy {
  if (durablyReceived) {
    return {
      state: 'received',
      title: 'Result safely received',
      detail: 'The result reached tournament control.',
    };
  }
  return {
    state: 'saved-local',
    title: 'Result saved on this device — retry when connected',
    detail: 'This game is saved here. It will send when a connection returns.',
  };
}
