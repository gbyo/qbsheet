/**
 * The scorer's preferred-transport policy: Internet relay first, LAN fallback, local last.
 *
 * # What this file is
 *
 * The product layer above the protocol contract in `./QbtcpStream.ts`. That file defines the
 * transport-neutral state machine (`http-only` through `offline-local`), the frame validators,
 * and the revision/dedup rules. This file answers the scorer-specific questions the contract
 * leaves to the implementation: which endpoint each transport uses, when to try the LAN, when
 * to come back, what a quota failure means, and what words the room reads while any of that
 * happens.
 *
 * Pure: no socket, no fetch, no React, no storage. The runtime in
 * `src/app/useConnectedRuntime.ts` owns effects; this file owns decisions, so every decision
 * below is unit-testable without a network.
 *
 * # Path order and stability
 *
 * Preferred order is Internet relay stream, Internet relay HTTP, LAN Director QBTCP, then
 * local-only continuation. Failover is conservative on purpose: a brief packet loss must not
 * flap a room between paths mid-game.
 *
 * - The stream disconnecting is not yet a failover. HTTP to the same primary covers while the
 *   stream reconnects with backoff and jitter.
 * - The LAN is tried only after repeated primary failures, and only when the tournament
 *   supplied a LAN address for the same room authority — never as a second pairing.
 * - Once the LAN is serving the active game it keeps serving it. The scorer heals the primary
 *   in the background (a low-frequency health check, then the stream) and migrates back only
 *   after the preferred path proves healthy and an explicit reconciliation converges state.
 *   Stability during an active game beats chasing the theoretically preferred route.
 * - A final submitted on one path carries its fingerprint and retry key onto the other, so a
 *   retry across transports is answered `duplicate: true` and retains exactly one result.
 *
 * # What this file is not
 *
 * It is not Director sync, deployment, quota measurement, or shared infrastructure — those are
 * #773, #774, #775, and #776. Quota appears here only as classification: a limit failure is a
 * transport failure, never a game failure.
 */

import type { ApiResult } from '../integrations/fruity/ServerTypes';
import {
  STREAM_HEALTHY_POLL_INTERVAL_MS,
  STANDARD_POLL_INTERVAL_MS,
  type TransportState,
} from './QbtcpStream';

/**
 * Where the scorer's connection currently lives, in endpoint terms.
 *
 * This sits underneath the user-facing connection state: the room reads "Connected" or
 * "Offline — keep scoring" while this records which path earned that word. No WebSocket or
 * HTTP jargon reaches the main scorer flow; diagnostics may record `describeTransport`.
 */
export type QbtcpTransport =
  /** Healthy realtime stream to the primary (usually Internet relay) endpoint. */
  | { kind: 'internet-stream'; endpoint: string }
  /** HTTP to the primary endpoint: no stream, stream healing, or no stream capability. */
  | { kind: 'internet-http'; endpoint: string }
  /** HTTP to the tournament-supplied LAN fallback under the same room authority. */
  | { kind: 'lan'; endpoint: string }
  /** Nothing answers. Scoring continues locally regardless. */
  | { kind: 'none' };

/** The primary address plus the optional LAN fallback for the same room authority. */
export interface IQbtcpEndpoints {
  /** Normalized, no trailing slash. The address scorers pair against and QR codes carry. */
  primary: string;
  /**
   * Normalized, no trailing slash. The same tournament/room authority on the venue network —
   * not a second pairing, so the same room and session credentials apply on either path.
   */
  lan?: string;
}

/**
 * Whether a string is a well-formed endpoint for either path.
 *
 * Mirrors `normalizeBaseUrl` in `src/integrations/fruity/FruityServerClient.ts` without
 * importing it: that module owns the network client, and this policy must stay usable from
 * pure contexts (pairing-link parsing, persisted-session validation) that cannot construct
 * one. The rules are the same on purpose — http(s) only, no query, no fragment — so a value
 * accepted here is accepted there.
 */
export function normalizeEndpoint(input: string): { ok: true; value: string } | { ok: false } {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false };
  // A non-HTTP scheme must be refused, not prefixed into a mangled http URL.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return { ok: false };
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false };
  if (url.search !== '' || url.hash !== '') return { ok: false };
  const path = url.pathname.replace(/\/+$/, '');
  return { ok: true, value: `${url.protocol}//${url.host}${path}` };
}

/** The endpoint a transport actually talks to, or null when it talks to none. */
export function endpointForTransport(transport: QbtcpTransport): string | null {
  return transport.kind === 'none' ? null : transport.endpoint;
}

/** True when the transport is one of the two primary-endpoint paths. */
export function isPrimaryTransport(transport: QbtcpTransport): boolean {
  return transport.kind === 'internet-stream' || transport.kind === 'internet-http';
}

/**
 * How many consecutive primary failures before the LAN is tried.
 *
 * Two, not one: a single failed poll is a dropped packet or a slow laptop, and failing a
 * whole room over to the LAN on that evidence would flap on every venue hiccup. Credential
 * refusals (401/403/409) never count — those are answers, not outages, and the LAN shares
 * the same authority so retrying there cannot fix them.
 */
export const LAN_FAILOVER_CONSECUTIVE_FAILURES = 2;

/**
 * How often the primary is health-checked while the LAN serves the game.
 *
 * One cheap request a minute, deliberately the same cadence as stream-healthy
 * reconciliation: often enough to notice a restored uplink within a round, rare enough to
 * stay background noise on a metered connection.
 */
export const PRIMARY_HEALTH_CHECK_INTERVAL_MS = 60_000;

/**
 * Map the contract transport state onto the endpoint-aware transport.
 *
 * `stream-live` is the Internet stream. The two healing states keep HTTP on whichever
 * endpoint is serving the game, because a gap is exactly when a push may have been missed
 * and HTTP is what covers it. `offline-local` is local-only even when a LAN address is
 * configured — configured is not the same as answering.
 */
export function transportForContractState(
  state: TransportState,
  endpoints: IQbtcpEndpoints,
  lanActive: boolean,
): QbtcpTransport {
  if (state === 'offline-local') return { kind: 'none' };
  if (state === 'stream-live' && !lanActive) return { kind: 'internet-stream', endpoint: endpoints.primary };
  if (lanActive && endpoints.lan) return { kind: 'lan', endpoint: endpoints.lan };
  return { kind: 'internet-http', endpoint: endpoints.primary };
}

/**
 * Which assignment polling cadence applies right now.
 *
 * Re-exported in endpoint terms so the runtime asks one module: the relaxed reconciliation
 * interval only while the Internet stream is healthy, the normal cadence everywhere else —
 * including while degraded, when a push may have been missed.
 */
export function selectTransportPollIntervalMs(transport: QbtcpTransport): number {
  return transport.kind === 'internet-stream' ? STREAM_HEALTHY_POLL_INTERVAL_MS : STANDARD_POLL_INTERVAL_MS;
}

export { STANDARD_POLL_INTERVAL_MS, STREAM_HEALTHY_POLL_INTERVAL_MS };

/**
 * The operational words for each transport, for the main scorer flow.
 *
 * Calm and scorekeeper-oriented. The healthy line does not name the path at all — a room
 * that is working should not be taught the network topology mid-round — while the degraded
 * lines say what to do rather than what broke.
 */
export function transportStatusCopy(transport: QbtcpTransport): string {
  switch (transport.kind) {
    case 'internet-stream':
    case 'internet-http':
      return 'Connected to tournament control';
    case 'lan':
      return 'Connected over the local network';
    case 'none':
      return 'Tournament control is unavailable. Keep scoring — this game is saved on this device.';
  }
}

/**
 * The troubleshooting words for each transport, for diagnostics and the timeline.
 *
 * This is the one place that names the path: "internet relay", "local network", "this
 * device". Never a credential, never a token — endpoints here are already normalized
 * addresses with no query or fragment to leak.
 */
export function describeTransport(transport: QbtcpTransport): string {
  switch (transport.kind) {
    case 'internet-stream':
      return `internet relay stream (${transport.endpoint})`;
    case 'internet-http':
      return `internet relay HTTP (${transport.endpoint})`;
    case 'lan':
      return `local network (${transport.endpoint})`;
    case 'none':
      return 'this device only';
  }
}

/**
 * What a relay durable receipt means to the room, said plainly.
 *
 * Shown when the relay retained the result while Director is absent. It promises receipt,
 * not standings acceptance — the relay never accepts on Director's behalf.
 */
export const RELAY_RECEIPT_COPY =
  'Result safely received. Tournament control will pick it up when it reconnects.';

/**
 * Whether a failure body smells like account/quota exhaustion rather than a game problem.
 *
 * Cloudflare answers an exhausted Workers account with Error 1027, and the relay surfaces
 * storage pressure as retryable `storage-unavailable`. Either way the scorer's duty is the
 * same: treat the path as down, keep scoring, fail over — and never present it as a
 * refusal of the game itself.
 */
export function isQuotaStyleFailure(detail?: string): boolean {
  if (!detail) return false;
  return /(1027|quota|storage-unavailable|storage unavailable|daily limit|limit exceeded|over (the )?(daily|account) limit|retryable)/i.test(
    detail,
  );
}

export type TransportFailureClass =
  /** Nothing answered, timed out, or failed server-side/quota-side. Try another path. */
  | 'transport-unavailable'
  /** The credential is not accepted. A person repairs this; another path cannot. */
  | 'credential'
  /** Control answered and refused. A person resolves this; retrying cannot. */
  | 'refused';

/**
 * Classify one HTTP result for failover purposes.
 *
 * The order matters: quota-style bodies ride on retryable statuses, so they are checked
 * first and classified as transport failures even when a status code is present. A 401 is
 * a credential problem on both transports (same authority), and 403/409 are refusals —
 * none of these may trigger LAN failover, because the LAN would answer the same way.
 */
export function classifyTransportFailure(result: ApiResult<unknown>): TransportFailureClass | null {
  if (result.ok) return null;
  if (isQuotaStyleFailure(result.detail ?? result.error)) return 'transport-unavailable';
  if (result.status === undefined) return 'transport-unavailable';
  if (result.status === 401) return 'credential';
  if (result.status === 403 || result.status === 409) return 'refused';
  if (result.status === 408 || result.status === 429 || (result.status >= 500 && result.status <= 599))
    return 'transport-unavailable';
  return 'refused';
}

/**
 * The sticky failover memory for one mounted game.
 *
 * `consecutivePrimaryFailures` counts transport-unavailable answers from the primary while
 * it serves the game. `lanActive` latches once the LAN takes over and unlatches only when
 * the preferred path proves healthy again (stream live plus an explicit reconciliation),
 * so a single lucky poll cannot yank a working game back mid-round.
 */
export interface IFailoverMemory {
  consecutivePrimaryFailures: number;
  lanActive: boolean;
}

export const initialFailoverMemory: IFailoverMemory = {
  consecutivePrimaryFailures: 0,
  lanActive: false,
};

/**
 * Fold one primary-endpoint answer into failover memory.
 *
 * Success resets the counter but never unlatches the LAN by itself: coming home requires
 * proof of health plus reconciliation, which `notePreferredPathHealed` records. Failure
 * counts only transport outages; credential and refusal answers leave memory untouched
 * because failing over cannot fix them.
 */
export function notePrimaryResult(
  memory: IFailoverMemory,
  classification: TransportFailureClass | null,
  lanAvailable: boolean,
): IFailoverMemory {
  if (classification !== 'transport-unavailable') return memory;
  const consecutivePrimaryFailures = memory.consecutivePrimaryFailures + 1;
  const lanActive =
    memory.lanActive || (lanAvailable && consecutivePrimaryFailures >= LAN_FAILOVER_CONSECUTIVE_FAILURES);
  return { consecutivePrimaryFailures, lanActive };
}

/** A primary success clears the outage counter. It does not by itself move the game home. */
export function notePrimarySuccess(memory: IFailoverMemory): IFailoverMemory {
  if (memory.consecutivePrimaryFailures === 0) return memory;
  return { ...memory, consecutivePrimaryFailures: 0 };
}

/**
 * Record that the preferred path proved healthy and state was reconciled onto it.
 *
 * Called only after the stream is live and an HTTP refetch converged assignment and
 * session state — the explicit reconciliation the contract requires after a reconnect —
 * so migration back is a converged handoff rather than a blind cutover.
 */
export function notePreferredPathHealed(memory: IFailoverMemory): IFailoverMemory {
  if (!memory.lanActive && memory.consecutivePrimaryFailures === 0) return memory;
  return { consecutivePrimaryFailures: 0, lanActive: false };
}

/**
 * A stable retry key for one final submission, travelling with it across transports.
 *
 * Random per final, minted once by the scorer and reused on every retry of that final on
 * either path. The server answers an identical retry `duplicate: true` and retains exactly
 * one result; a key is transport metadata, not result identity, so it never replaces the
 * fingerprint comparison. Carries no authority and needs none.
 */
export function newFinalRetryKey(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return `retry-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
