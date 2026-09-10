/**
 * The QBTCP v1 realtime/relay capability contract.
 *
 * # What this file is
 *
 * The normative TypeScript side of `docs/QBTCP-STREAM.md`: discovery of the optional `stream`
 * capability, validation of the versioned frame envelope, and the pure transport/session rules a
 * scorer needs to treat an Internet relay and a LAN QBTCP server as one logical room/session.
 * It owns no socket, performs no input/output, and names no relay vendor. The Rust mirror lives
 * in `crates/qbtcp-server/src/stream.rs`; the canonical wire fixtures live in
 * `tests/fixtures/qbtcp-stream/`.
 *
 * # What this file is not
 *
 * It is not the scorer transport itself. Opening the WebSocket, polling less often while it is
 * healthy, and failing over between transports belong to the scorer runtime (see #772), which
 * consumes the predicates here. Nothing in this file changes what the scorer does today.
 */

import { IQbtcpDiscovery, supports } from './QbtcpRoutes';

/** The discovery capability that advertises the realtime stream. */
export const STREAM_CAPABILITY = 'stream';

/** The only stream frame envelope version this client speaks. */
export const STREAM_FRAME_VERSION = 1;

/**
 * The WebSocket subprotocol a client offers when opening the stream endpoint.
 *
 * A subprotocol names the framing and carries no credential. Credentials travel in the first
 * `authenticate` frame, never in the URL, so the upgrade request stays log-safe.
 */
export const STREAM_SUBPROTOCOL = 'qbtcp.stream.v1';

/** Default bound on one decoded stream frame, in bytes. A server may advertise less. */
export const DEFAULT_MAX_STREAM_FRAME_BYTES = 1_048_576;

/** Reconnect backoff: first retry waits up to this long, with full jitter. */
export const STREAM_RECONNECT_BASE_MS = 500;
/** Reconnect backoff never exceeds this, however many attempts have failed. */
export const STREAM_RECONNECT_MAX_MS = 30_000;

/**
 * How often a scorer may reconcile assignment state over HTTP while the stream is healthy.
 *
 * The stream pushes assignment changes, so the normal polling cadence is suspended; this
 * low-frequency reconciliation exists only to catch a silently dropped push, and its interval
 * is the documented reason it may keep running.
 */
export const STREAM_HEALTHY_POLL_INTERVAL_MS = 60_000;

/**
 * The normal assignment polling cadence without a healthy stream.
 *
 * This mirrors `assignmentPollIntervalMs` in `src/app/useConnectedRuntime.ts`, which remains
 * the value the runtime uses. It is repeated here so the relaxed interval above can be chosen
 * by comparison without importing the runtime (and React) into pure protocol code.
 */
export const STANDARD_POLL_INTERVAL_MS = 10_000;

/** Frame types a server may send to a scorer. Unknown types are ignored, never fatal. */
export const SERVER_FRAME_TYPES = [
  'hello',
  'assignment-changed',
  'session-changed',
  'help-changed',
  'resync-required',
  'shutdown',
  'receipt',
  'recovery',
  'error',
] as const;

/** Frame types a scorer may send to a server. */
export const SCORER_FRAME_TYPES = [
  'authenticate',
  'progress',
  'presence',
  'help-open',
  'help-cancel',
  'final',
  'recover',
] as const;

export type ServerFrameType = (typeof SERVER_FRAME_TYPES)[number];
export type ScorerFrameType = (typeof SCORER_FRAME_TYPES)[number];

/** Replay features a stream descriptor may advertise. */
export const STREAM_REPLAY_FEATURES = ['sequence', 'resync'] as const;
export type StreamReplayFeature = (typeof STREAM_REPLAY_FEATURES)[number];

/**
 * The realtime endpoint and its properties, as advertised by discovery.
 *
 * This is operational metadata, not authority: it carries no token, no pairing code, and no
 * session identifier. A descriptor that smuggles one in is rejected outright.
 */
export interface IQbtcpStreamDescriptor {
  /** Relative path of the WebSocket endpoint, e.g. `/qbtcp/v1/stream`. Never a full URL. */
  endpoint: string;
  /** Frame envelope version the server speaks. */
  frames: number;
  /** Whether the relay durably retains finals while Director is disconnected. */
  retainsFinals: boolean;
  /** Whether the relay mirrors Director-published assignment/session state. */
  mirrorsAssignment: boolean;
  /** Reconnect/replay features the server supports. */
  replay: StreamReplayFeature[];
  /** Bound on one decoded frame, in bytes. */
  maxFrameBytes: number;
  /** Whether the server additionally offers a narrow pre-auth ticket exchange. */
  ticket: boolean;
}

/** One validated stream frame, in client vocabulary. */
export interface IQbtcpStreamFrame {
  version: number;
  type: string;
  sequence?: number;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

export type StreamFrameError =
  | { code: 'malformed'; detail: string }
  | { code: 'unsupported-version'; version: unknown }
  | { code: 'too-large'; size: number; maxBytes: number };

export type ValidatedStreamFrame =
  { ok: true; frame: IQbtcpStreamFrame; ignored: boolean } | { ok: false; error: StreamFrameError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanBoundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  let cleaned = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) cleaned += character;
  }
  cleaned = cleaned.trim();
  if (cleaned === '' || cleaned.length > maxLength) return null;
  return cleaned;
}

/** Whether discovery advertises the realtime stream capability. */
export function supportsStream(discovery: IQbtcpDiscovery | null): boolean {
  return supports(discovery, STREAM_CAPABILITY);
}

const CREDENTIAL_KEY_PATTERN = /token|code|secret|password|credential|bearer/i;

/**
 * Read the stream descriptor from a discovery document.
 *
 * Strict about the fields the client acts on (endpoint shape, frame version, bounds) and
 * forgiving about the rest: unknown descriptor fields are ignored so a future relay does not
 * break this client. Returns null when the server does not advertise the stream, and also
 * null — rather than a half-understood descriptor — when the advertisement is malformed or
 * carries anything credential-shaped.
 */
export function readStreamDescriptor(discovery: IQbtcpDiscovery | null): IQbtcpStreamDescriptor | null {
  if (!supportsStream(discovery)) return null;
  const raw = (discovery as unknown as Record<string, unknown>).stream;
  if (!isRecord(raw)) return null;
  for (const key of Object.keys(raw)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) return null;
  }
  const endpoint = cleanBoundedText(raw.endpoint, 200);
  if (!endpoint || !endpoint.startsWith('/') || /[?#@]/.test(endpoint)) return null;
  if (typeof raw.frames !== 'number' || !Number.isInteger(raw.frames) || raw.frames !== STREAM_FRAME_VERSION)
    return null;
  if (typeof raw.retains_finals !== 'boolean' || typeof raw.mirrors_assignment !== 'boolean') return null;
  const replay = Array.isArray(raw.replay)
    ? raw.replay.filter(
        (entry): entry is StreamReplayFeature =>
          typeof entry === 'string' && (STREAM_REPLAY_FEATURES as readonly string[]).includes(entry),
      )
    : null;
  if (replay === null) return null;
  const maxFrameBytes =
    typeof raw.max_frame_bytes === 'number' &&
    Number.isInteger(raw.max_frame_bytes) &&
    raw.max_frame_bytes > 0 &&
    raw.max_frame_bytes <= 64 * 1024 * 1024
      ? raw.max_frame_bytes
      : null;
  if (maxFrameBytes === null) return null;
  return {
    endpoint,
    frames: STREAM_FRAME_VERSION,
    retainsFinals: raw.retains_finals,
    mirrorsAssignment: raw.mirrors_assignment,
    replay,
    maxFrameBytes,
    ticket: raw.ticket === true,
  };
}

/**
 * The WebSocket URL for the stream, or null when the client must stay on HTTP.
 *
 * The descriptor endpoint is always relative, so joining is unambiguous and there is nowhere
 * for a credential to hide. An absolute endpoint is refused rather than followed.
 */
export function streamUrl(baseUrl: string, descriptor: IQbtcpStreamDescriptor | null): string | null {
  if (!descriptor) return null;
  const trimmed = baseUrl.replace(/\/+$/, '');
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(url);
    const ws = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${ws}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}${descriptor.endpoint}`;
  } catch {
    return null;
  }
}

/**
 * Validate one decoded stream frame without touching any session state.
 *
 * Unknown frame types are reported as ignored so the caller can drop them: forward
 * compatibility means a future server must not break this client. Anything structurally
 * wrong — including a frame version this client does not speak and any oversize frame —
 * is an error the caller must answer without mutating the game.
 */
export function validateStreamFrame(
  value: unknown,
  options: { maxBytes?: number } = {},
): ValidatedStreamFrame {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_STREAM_FRAME_BYTES;
  let size = 0;
  try {
    size = JSON.stringify(value)?.length ?? 0;
  } catch {
    return { ok: false, error: { code: 'malformed', detail: 'A stream frame must be a JSON object.' } };
  }
  if (size > maxBytes) return { ok: false, error: { code: 'too-large', size, maxBytes } };
  if (!isRecord(value))
    return { ok: false, error: { code: 'malformed', detail: 'A stream frame must be a JSON object.' } };
  if (value.version !== STREAM_FRAME_VERSION)
    return { ok: false, error: { code: 'unsupported-version', version: value.version } };
  const type = cleanBoundedText(value.type, 64);
  if (!type) return { ok: false, error: { code: 'malformed', detail: 'A stream frame needs a type.' } };
  const known =
    (SERVER_FRAME_TYPES as readonly string[]).includes(type) ||
    (SCORER_FRAME_TYPES as readonly string[]).includes(type);
  if (!known) {
    return {
      ok: true,
      frame: { version: STREAM_FRAME_VERSION, type },
      ignored: true,
    };
  }
  let sequence: number | undefined;
  if (value.sequence !== undefined) {
    if (typeof value.sequence !== 'number' || !Number.isInteger(value.sequence) || value.sequence < 0)
      return {
        ok: false,
        error: { code: 'malformed', detail: 'A frame sequence must be a non-negative integer.' },
      };
    sequence = value.sequence;
  }
  let sessionId: string | undefined;
  if (value.session_id !== undefined) {
    const cleaned = cleanBoundedText(value.session_id, 200);
    if (!cleaned)
      return { ok: false, error: { code: 'malformed', detail: 'A frame session id must be bounded text.' } };
    sessionId = cleaned;
  }
  // The authenticate frame is the one frame whose payload carries bearer-equivalent
  // material; it is validated for shape here and must be handled before any other
  // scorer frame is honored. See docs/QBTCP-STREAM.md.
  let payload: Record<string, unknown> | undefined;
  if (value.payload !== undefined) {
    if (!isRecord(value.payload))
      return { ok: false, error: { code: 'malformed', detail: 'A frame payload must be an object.' } };
    payload = value.payload;
  }
  return {
    ok: true,
    frame: {
      version: STREAM_FRAME_VERSION,
      type,
      ...(sequence !== undefined ? { sequence } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(payload !== undefined ? { payload } : {}),
    },
    ignored: false,
  };
}

/** The smallest client-side view a stream frame can update. */
export interface IQbtcpStreamView {
  serverSeq: number;
  roundRevision: number | null;
  assignmentRevision: number | null;
  sessionStatus: 'open' | 'final-received' | 'abandoned' | null;
  helpOpen: boolean;
  resyncRequired: boolean;
  degraded: string | null;
}

export const initialStreamView: IQbtcpStreamView = {
  serverSeq: 0,
  roundRevision: null,
  assignmentRevision: null,
  sessionStatus: null,
  helpOpen: false,
  resyncRequired: false,
  degraded: null,
};

function readRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Whether an incoming assignment revision supersedes the one the scorer holds.
 *
 * Round revision wins first; within a round, assignment revision wins. A stale transport —
 * a relay that has not yet seen Director's latest publication — must never overwrite newer
 * state, on either transport.
 */
export function isAssignmentNewer(
  current: { roundRevision: number | null; assignmentRevision: number | null },
  incoming: { roundRevision: number | null; assignmentRevision: number | null },
): boolean {
  if (incoming.roundRevision === null || incoming.assignmentRevision === null) return false;
  if (current.roundRevision === null || current.assignmentRevision === null) return true;
  if (incoming.roundRevision !== current.roundRevision) return incoming.roundRevision > current.roundRevision;
  return incoming.assignmentRevision > current.assignmentRevision;
}

/**
 * Fold one validated server frame into the client view, returning a new view.
 *
 * Never mutates its input, never throws, and never lets a stale or malformed frame move
 * the view backwards. A sequenced frame whose `sequence` is at or behind the stored
 * `serverSeq` cursor is ignored entirely — it advances nothing and mutates nothing — so a
 * delayed, replayed, or duplicate delivery cannot overwrite newer state while the cursor
 * still claims the newer sequence is current. Frames without a `sequence` carry no ordering
 * information and are still applied. Malformed frames are the validator's job to reject;
 * this reducer additionally ignores anything it cannot understand, so a bad frame cannot
 * corrupt state even if it arrives here unchecked. Assignment adoption keeps its own
 * (round revision, assignment revision) comparison on top of this transport-level guard.
 */
export function applyServerFrame(view: IQbtcpStreamView, frame: IQbtcpStreamFrame): IQbtcpStreamView {
  const next: IQbtcpStreamView = { ...view };
  if (typeof frame.sequence === 'number') {
    if (frame.sequence <= next.serverSeq) return next;
    next.serverSeq = frame.sequence;
  }
  const payload = frame.payload ?? {};
  switch (frame.type) {
    case 'hello': {
      next.resyncRequired = false;
      next.degraded = null;
      return next;
    }
    case 'assignment-changed': {
      const incoming = {
        roundRevision: readRevision(payload.round_revision),
        assignmentRevision: readRevision(payload.assignment_revision),
      };
      if (isAssignmentNewer(next, incoming)) {
        next.roundRevision = incoming.roundRevision;
        next.assignmentRevision = incoming.assignmentRevision;
      }
      return next;
    }
    case 'session-changed': {
      const status = payload.status;
      if (status === 'open' || status === 'final-received' || status === 'abandoned') {
        next.sessionStatus = status;
      }
      return next;
    }
    case 'help-changed': {
      const request = isRecord(payload.request) ? payload.request : null;
      next.helpOpen = request !== null && request.status === 'open';
      return next;
    }
    case 'resync-required': {
      next.resyncRequired = true;
      return next;
    }
    case 'shutdown': {
      const reason = cleanBoundedText(payload.reason, 100) ?? 'unavailable';
      next.degraded = reason;
      return next;
    }
    default: {
      return next;
    }
  }
}

/** One coalescible progress offer: the current game state plus its session sequence. */
export interface IProgressOffer {
  sequence: number;
  match: unknown;
}

/**
 * Keep the newest progress offer, discarding a stale one.
 *
 * Progress is a snapshot, not a delta: each offer replaces the last, offers coalesce
 * freely, and a stale queued offer must never overwrite a newer accepted one. Equal
 * sequences keep the held offer — the first arrival wins a tie.
 */
export function coalesceProgress(held: IProgressOffer | null, next: IProgressOffer): IProgressOffer {
  if (!held || next.sequence > held.sequence) return next;
  return held;
}

/** Identity that makes one final submission idempotent across both transports. */
export interface IFinalIdentity {
  sessionId: string;
  tournamentId: string | null;
  matchId: string | null;
  fingerprint: string;
  retryKey: string | null;
}

/** A durable receipt, as retained by a relay or by Director. */
export interface IRelayReceipt {
  received: boolean;
  reviewRequired: boolean;
  /** False until Director itself accepts the result into standings. A relay never sets this. */
  acceptedByDirector: boolean;
  duplicate: boolean;
  resultId: string | null;
}

/**
 * Decide whether a final arriving over either transport is a duplicate.
 *
 * Ordering follows the canonical ingest path: tournament scopes the comparison, match
 * identity is compared first (same identity plus same fingerprint is a duplicate; same
 * identity plus a different fingerprint is a correction candidate retained for review),
 * and a supplied retry key makes a transport retry idempotent without replacing result
 * identity. The first retained result wins a cross-transport race; the loser is answered
 * `duplicate: true` and keeps exactly one semantic result.
 */
export function isDuplicateFinal(
  known: Pick<IFinalIdentity, 'tournamentId' | 'matchId' | 'fingerprint' | 'retryKey'> | null,
  incoming: Pick<IFinalIdentity, 'tournamentId' | 'matchId' | 'fingerprint' | 'retryKey'>,
): boolean {
  if (!known) return false;
  // The tournament scopes the comparison, before anything else.
  if (incoming.tournamentId !== known.tournamentId) return false;
  if (incoming.matchId && known.matchId) {
    if (incoming.matchId !== known.matchId) return false;
    return incoming.fingerprint === known.fingerprint;
  }
  // Identity is absent on at least one side. A retry key makes a transport retry idempotent,
  // but it is not a replacement for result identity: key reuse across different bytes is a
  // new submission, not a retry.
  if (incoming.retryKey && known.retryKey) {
    return incoming.retryKey === known.retryKey && incoming.fingerprint === known.fingerprint;
  }
  return incoming.fingerprint === known.fingerprint;
}

/**
 * Backoff before a stream reconnect attempt, with full jitter.
 *
 * Doubles from the base per attempt up to the cap, then samples uniformly below it, so a
 * roomful of devices dropping together does not reconnect in lockstep. `sample` is an
 * injectable uniform draw in [0, 1) — the production caller passes `Math.random()`.
 */
export function reconnectDelayMs(attempt: number, sample: number): number {
  const safeAttempt = Number.isInteger(attempt) ? Math.min(Math.max(attempt, 0), 10) : 0;
  const capped = Math.min(STREAM_RECONNECT_BASE_MS * 2 ** safeAttempt, STREAM_RECONNECT_MAX_MS);
  const draw = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 0.999999) : 0;
  return Math.floor(draw * capped);
}

/** Where the scorer's connection currently lives. */
export type TransportState =
  'http-only' | 'stream-connecting' | 'stream-live' | 'stream-degraded' | 'offline-local';

/** What can happen to the connection. */
export type TransportEvent =
  | 'stream-available'
  | 'stream-open'
  | 'stream-gap'
  | 'stream-closed'
  | 'http-ok'
  | 'http-failed'
  | 'resync-required'
  | 'shutdown';

/**
 * The transport-state transition table for scorer behavior.
 *
 * The scorer holds one logical room/session across both transports: a stream disconnect
 * never unmounts the game, HTTP keeps working while the stream reconnects, and recovery
 * converges rather than replays. `offline-local` still scores — the network is optional
 * once the assignment is persisted.
 */
export const TRANSPORT_TRANSITIONS: Record<TransportState, Record<TransportEvent, TransportState>> = {
  'http-only': {
    'stream-available': 'stream-connecting',
    'stream-open': 'stream-live',
    'stream-gap': 'http-only',
    'stream-closed': 'http-only',
    'http-ok': 'http-only',
    'http-failed': 'offline-local',
    'resync-required': 'http-only',
    shutdown: 'http-only',
  },
  'stream-connecting': {
    'stream-available': 'stream-connecting',
    'stream-open': 'stream-live',
    'stream-gap': 'stream-connecting',
    'stream-closed': 'http-only',
    'http-ok': 'stream-connecting',
    'http-failed': 'offline-local',
    'resync-required': 'stream-connecting',
    shutdown: 'http-only',
  },
  'stream-live': {
    'stream-available': 'stream-live',
    'stream-open': 'stream-live',
    'stream-gap': 'stream-degraded',
    'stream-closed': 'http-only',
    'http-ok': 'stream-live',
    'http-failed': 'stream-live',
    'resync-required': 'stream-degraded',
    shutdown: 'stream-degraded',
  },
  'stream-degraded': {
    'stream-available': 'stream-connecting',
    'stream-open': 'stream-live',
    'stream-gap': 'stream-degraded',
    'stream-closed': 'http-only',
    'http-ok': 'stream-degraded',
    'http-failed': 'offline-local',
    'resync-required': 'stream-degraded',
    shutdown: 'stream-degraded',
  },
  'offline-local': {
    'stream-available': 'stream-connecting',
    'stream-open': 'stream-live',
    'stream-gap': 'offline-local',
    'stream-closed': 'offline-local',
    'http-ok': 'http-only',
    'http-failed': 'offline-local',
    'resync-required': 'offline-local',
    shutdown: 'offline-local',
  },
};

export function nextTransportState(state: TransportState, event: TransportEvent): TransportState {
  return TRANSPORT_TRANSITIONS[state][event];
}

/**
 * Which assignment polling cadence applies right now.
 *
 * A healthy stream pushes assignment changes, so polling relaxes to the documented
 * reconciliation interval. Everywhere else the scorer keeps its normal cadence — in
 * particular a degraded stream still polls, because a gap is exactly when a push may
 * have been missed.
 */
export function selectAssignmentPollIntervalMs(state: TransportState): number {
  return state === 'stream-live' ? STREAM_HEALTHY_POLL_INTERVAL_MS : STANDARD_POLL_INTERVAL_MS;
}
