/**
 * The scorer's realtime stream: one WebSocket speaking the contract in `./QbtcpStream.ts`.
 *
 * # What this file is
 *
 * The socket layer the contract deliberately leaves out. `QbtcpStream.ts` validates frames
 * and reduces them into a view without touching the network; this client opens the endpoint
 * the discovery descriptor advertises, sends `authenticate` first, routes server pushes to
 * callbacks, and reconnects with backoff and jitter. It names no vendor: the URL comes from
 * discovery, the subprotocol from the contract, and the first frame carries the capability.
 *
 * The runtime owns what anything *means* — whether an assignment push refetches, whether a
 * receipt completes a final, whether a gap fails over. This client reports; it never clears
 * a game, never takes a writer lock, and never marks a final sent. An unacknowledged final
 * stays unacknowledged no matter what the socket does.
 *
 * # Authentication without URL credentials
 *
 * The upgrade carries no credential: the subprotocol names the framing and nothing else.
 * The first frame is `authenticate` with the room/session capability in its payload, exactly
 * as the fixtures show (`room_token`, `session_token`, `device_id`), plus the frame-level
 * `session_id` and the client's last server sequence for resume. A server that cannot see
 * tokens inside the connection offers the ticket exchange instead; that narrow HTTP call
 * stays the runtime's business, and the resulting ticket arrives here as the session token.
 *
 * # Sending
 *
 * Progress is coalesced: offers collapse to the newest and a stale queued offer never
 * overwrites a newer one, mirroring `ProgressSender` on the HTTP path. Finals allow one
 * in-flight submission; the next `receipt` frame answers it, and anything else (an `error`,
 * a close) answers it as unsent so the runtime can retry over HTTP with the same retry key
 * and fingerprint. The stream never replays missed progress — on reconnect the runtime
 * offers the current state, not the backlog.
 *
 * # Testability
 *
 * The socket is injected (`SocketFactory`), so unit tests drive a fake and the production
 * factory is three lines over the global `WebSocket`. There is deliberately no reconnection
 * inside a test that does not ask for one: `close()` stops everything, and every timer the
 * client arms is cleared by it.
 */

import {
  STREAM_SUBPROTOCOL,
  applyServerFrame,
  initialStreamView,
  validateStreamFrame,
  reconnectDelayMs,
  type IQbtcpStreamFrame,
  type IQbtcpStreamView,
  type TransportEvent,
} from './QbtcpStream';

/** The smallest socket surface this client needs. Satisfied by the browser WebSocket. */
export interface IQbtcpSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type QbtcpSocketFactory = (url: string, protocols: string[]) => IQbtcpSocket;

/** Credentials for the opening `authenticate` frame. Never logged, never in the URL. */
export interface IStreamCredentials {
  roomToken?: string;
  sessionToken?: string;
  sessionId?: string;
  deviceId?: string;
}

/** A refusal or degradation the server named, in client vocabulary. */
export interface IStreamError {
  /** The server's `code`: `unauthorized`, `conflict`, `storage-unavailable`, etc. */
  code: string;
  message: string;
  retryable: boolean;
  /**
   * Whether the server offers this device the writer lock on request.
   *
   * Read from the conflict frame; never acted on here. A person takes over explicitly,
   * over either transport — the stream never takes it.
   */
  canTakeOver?: boolean;
}

/** Life of the stream, for the runtime to fold into its transport state. */
export type StreamClientState = 'connecting' | 'live' | 'closed';

export interface IQbtcpStreamClientEvents {
  /** The socket authenticated and the server said hello. Carries the contract event too. */
  onOpen?: () => void;
  /** A validated, non-ignored server frame arrived. The view is already advanced. */
  onFrame?: (frame: IQbtcpStreamFrame, view: IQbtcpStreamView) => void;
  /** The server demands an HTTP refetch: the stream is no longer whole. */
  onResync?: (reason: string) => void;
  /** The server is draining or degraded. HTTP covers; scoring continues. */
  onDegraded?: (reason: string) => void;
  /** The pending final got its exactly-one answer. */
  onReceipt?: (payload: Record<string, unknown>, sessionId?: string) => void;
  /** The pending final went unanswered (error frame or close). Retry elsewhere. */
  onFinalUnanswered?: (error: IStreamError | null) => void;
  /** The server refused the authentication. Same repairs as an HTTP 401. */
  onUnauthorized?: (error: IStreamError) => void;
  /** Another device holds the writer lock. Never an auto-takeover. */
  onWriterConflict?: (error: IStreamError) => void;
  /** A frame failed safely: malformed, too large, or an unknown version. */
  onProtocolError?: (detail: string) => void;
  /** State changes for connection bookkeeping. Never game state. */
  onStateChange?: (state: StreamClientState, event: TransportEvent) => void;
}

export interface IQbtcpStreamClientOptions {
  url: string;
  credentials: IStreamCredentials;
  /** Bound from the discovery descriptor. Neither direction exceeds it. */
  maxFrameBytes: number;
  socketFactory: QbtcpSocketFactory;
  /** Uniform draw in [0, 1) for reconnect jitter. Defaults to `Math.random()`. */
  random?: () => number;
  events?: IQbtcpStreamClientEvents;
}

function readErrorPayload(payload: Record<string, unknown> | undefined): IStreamError {
  const record = payload ?? {};
  const code = typeof record.code === 'string' && record.code !== '' ? record.code : 'internal';
  const message =
    typeof record.message === 'string' && record.message !== ''
      ? record.message
      : 'The relay refused this request.';
  const canTakeOver = record.can_take_over === true || record.canTakeOver === true;
  return {
    code,
    message,
    retryable: record.retryable === true,
    ...(canTakeOver ? { canTakeOver: true as const } : {}),
  };
}

/** Error codes that mean the path is down rather than the game is wrong. */
const TRANSIENT_ERROR_CODES = new Set([
  'storage-unavailable',
  'rate-limited',
  'internal',
  'too-large',
  'not-found',
]);

/**
 * One realtime stream, from `authenticate` to `close()`.
 *
 * Construct, then `start()`. Reconnects on its own after an interruption until `close()`
 * is called; every reconnect re-authenticates and resumes from the client's last server
 * sequence, and the runtime reconciles over HTTP whenever a gap is possible.
 */
export class QbtcpStreamClient {
  private socket: IQbtcpSocket | null = null;
  private state: StreamClientState = 'closed';
  private started = false;
  private authenticated = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private view: IQbtcpStreamView = { ...initialStreamView };
  private pendingProgress: { sequence: number; match: unknown } | null = null;
  private pendingFinal = false;
  private readonly random: () => number;

  constructor(private readonly options: IQbtcpStreamClientOptions) {
    this.random = options.random ?? Math.random;
  }

  /** The client-side view the validated server frames have built. A copy. */
  get streamView(): IQbtcpStreamView {
    return { ...this.view };
  }

  get connectionState(): StreamClientState {
    return this.state;
  }

  /** True once `hello` arrived: pushes are flowing and polling may relax. */
  get isLive(): boolean {
    return this.state === 'live';
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.reconnectAttempt = 0;
    this.open();
  }

  close(): void {
    this.started = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPendingFinal(null);
    try {
      this.socket?.close(1000, 'scorer leaving');
    } catch {
      // A closing socket owes nothing.
    }
    this.socket = null;
    this.authenticated = false;
    this.setState('closed', 'stream-closed');
  }

  /**
   * Offer the newest progress snapshot. Coalesced: replaces whatever is held.
   *
   * Sent at once when the stream is live, otherwise held as the single pending offer and
   * flushed on the next `hello`. Older offers are dropped, never queued.
   */
  offerProgress(sequence: number, match: unknown): void {
    this.pendingProgress = { sequence, match };
    this.flushProgress();
  }

  /**
   * Submit one final over the stream. Answers exactly once: `true` with the receipt
   * payload, `false` when the stream cannot deliver it (error frame, close, timeout of
   * trust). A `false` answer is not a refusal — the runtime retries over HTTP with the
   * same retry key, and the server dedupes.
   */
  submitFinal(retryKey: string, qbj: unknown): Promise<{ delivered: boolean; receipt?: Record<string, unknown> }> {
    if (this.pendingFinal) {
      return Promise.resolve({ delivered: false });
    }
    const frame = {
      version: 1,
      type: 'final',
      ...(this.options.credentials.sessionId ? { session_id: this.options.credentials.sessionId } : {}),
      payload: { retry_key: retryKey, qbj },
    };
    if (!this.sendFrame(frame)) {
      return Promise.resolve({ delivered: false });
    }
    this.pendingFinal = true;
    return new Promise((resolve) => {
      this.resolveFinal = resolve;
    });
  }

  private resolveFinal: ((answer: { delivered: boolean; receipt?: Record<string, unknown> }) => void) | null =
    null;

  private setState(state: StreamClientState, event: TransportEvent): void {
    this.state = state;
    this.options.events?.onStateChange?.(state, event);
    if (event === 'stream-open') this.options.events?.onOpen?.();
  }

  private open(): void {
    if (!this.started) return;
    this.setState('connecting', 'stream-available');
    let socket: IQbtcpSocket;
    try {
      socket = this.options.socketFactory(this.options.url, [STREAM_SUBPROTOCOL]);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.authenticated = false;
    socket.onopen = () => {
      if (this.socket !== socket || !this.started) return;
      this.sendAuthenticate(socket);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || !this.started) return;
      this.handleMessage(typeof event.data === 'string' ? event.data : null);
    };
    socket.onclose = () => {
      if (this.socket !== socket || !this.started) return;
      this.socket = null;
      this.authenticated = false;
      this.failPendingFinal(null);
      this.options.events?.onStateChange?.('connecting', 'stream-closed');
      this.state = 'connecting';
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // The close event carries the outcome; an error alone changes nothing.
    };
  }

  private sendAuthenticate(socket: IQbtcpSocket): void {
    const credentials = this.options.credentials;
    const payload: Record<string, unknown> = {
      ...(credentials.roomToken ? { room_token: credentials.roomToken } : {}),
      ...(credentials.sessionToken ? { session_token: credentials.sessionToken } : {}),
      ...(credentials.deviceId ? { device_id: credentials.deviceId } : {}),
      ...(this.view.serverSeq > 0 ? { last_sequence: this.view.serverSeq } : {}),
    };
    const frame: Record<string, unknown> = {
      version: 1,
      type: 'authenticate',
      ...(credentials.sessionId ? { session_id: credentials.sessionId } : {}),
      ...(this.view.serverSeq > 0 ? { sequence: this.view.serverSeq } : {}),
      payload,
    };
    let encoded: string;
    try {
      encoded = JSON.stringify(frame);
    } catch {
      return;
    }
    if (encoded.length > this.options.maxFrameBytes) return;
    try {
      socket.send(encoded);
    } catch {
      // The close handler schedules the retry.
    }
  }

  private sendFrame(frame: Record<string, unknown>): boolean {
    if (this.socket === null || !this.authenticated || this.state !== 'live') return false;
    let encoded: string;
    try {
      encoded = JSON.stringify(frame);
    } catch {
      return false;
    }
    if (encoded.length > this.options.maxFrameBytes) {
      this.options.events?.onProtocolError?.('A progress snapshot exceeded the relay frame bound.');
      return false;
    }
    try {
      this.socket.send(encoded);
      return true;
    } catch {
      return false;
    }
  }

  private flushProgress(): void {
    const pending = this.pendingProgress;
    if (!pending) return;
    const sent = this.sendFrame({
      version: 1,
      type: 'progress',
      ...(this.options.credentials.sessionId ? { session_id: this.options.credentials.sessionId } : {}),
      sequence: pending.sequence,
      payload: { sequence: pending.sequence, match: pending.match },
    });
    if (sent) this.pendingProgress = null;
  }

  private failPendingFinal(error: IStreamError | null): void {
    if (!this.pendingFinal) return;
    this.pendingFinal = false;
    this.resolveFinal?.({ delivered: false });
    this.resolveFinal = null;
    this.options.events?.onFinalUnanswered?.(error);
  }

  private handleMessage(data: string | null): void {
    if (data === null) {
      this.options.events?.onProtocolError?.('A stream frame was not text.');
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(data);
    } catch {
      this.options.events?.onProtocolError?.('A stream frame was not JSON.');
      return;
    }
    const validated = validateStreamFrame(decoded, { maxBytes: this.options.maxFrameBytes });
    if (!validated.ok) {
      if (validated.error.code === 'unsupported-version') {
        // The server speaks frames this client cannot interpret. Stop the stream and let
        // the runtime fall back to HTTP rather than retrying something hopeless.
        this.options.events?.onProtocolError?.('The relay speaks a frame version this build does not.');
        this.close();
        return;
      }
      this.options.events?.onProtocolError?.(
        validated.error.code === 'too-large' ? 'A stream frame exceeded the bound.' : 'A stream frame was malformed.',
      );
      return;
    }
    if (validated.ignored) return;
    const frame = validated.frame;
    this.view = applyServerFrame(this.view, frame);
    this.options.events?.onFrame?.(frame, { ...this.view });

    switch (frame.type) {
      case 'hello': {
        this.authenticated = true;
        this.reconnectAttempt = 0;
        this.setState('live', 'stream-open');
        this.flushProgress();
        return;
      }
      case 'resync-required': {
        const reason =
          typeof frame.payload?.reason === 'string' && frame.payload.reason !== ''
            ? frame.payload.reason
            : 'resync';
        this.options.events?.onStateChange?.('live', 'resync-required');
        this.options.events?.onResync?.(reason);
        return;
      }
      case 'shutdown': {
        const reason =
          typeof frame.payload?.reason === 'string' && frame.payload.reason !== ''
            ? frame.payload.reason
            : 'unavailable';
        this.options.events?.onStateChange?.('live', 'shutdown');
        this.options.events?.onDegraded?.(reason);
        return;
      }
      case 'receipt': {
        if (this.pendingFinal) {
          this.pendingFinal = false;
          const receipt = frame.payload ?? {};
          this.resolveFinal?.({ delivered: true, receipt });
          this.resolveFinal = null;
          this.options.events?.onReceipt?.(receipt, frame.sessionId);
        }
        return;
      }
      case 'recovery': {
        // Recovery over the stream answers a `recover` frame the runtime sends over HTTP
        // today; surfaced as a frame so the runtime can use it when it stops being
        // HTTP-only. Never game state by itself.
        return;
      }
      case 'error': {
        this.handleErrorFrame(readErrorPayload(frame.payload));
        return;
      }
      default: {
        // assignment-changed, session-changed, help-changed: the view already advanced and
        // onFrame already fired. The runtime reconciles over HTTP from there.
        return;
      }
    }
  }

  private handleErrorFrame(error: IStreamError): void {
    if (error.code === 'unauthorized') {
      this.failPendingFinal(error);
      this.options.events?.onUnauthorized?.(error);
      // Do not reconnect-loop on refused credentials: every attempt would fail the same
      // way. The runtime repairs (new pairing / reopened session) and restarts the stream.
      try {
        this.socket?.close(1000, 'unauthorized');
      } catch {
        // The close handler is guarded by `started`; disarm first.
      }
      this.started = false;
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.socket = null;
      this.authenticated = false;
      this.state = 'connecting';
      return;
    }
    if (error.code === 'conflict') {
      // Writer ownership never transfers on a frame. Surface it; keep the stream.
      this.failPendingFinal(error);
      this.options.events?.onWriterConflict?.(error);
      return;
    }
    if (TRANSIENT_ERROR_CODES.has(error.code) || error.retryable) {
      this.failPendingFinal(error);
      this.options.events?.onStateChange?.(this.state, 'stream-gap');
      return;
    }
    // forbidden, origin-not-allowed, superseded, and anything unknown: named, kept, and
    // left to the runtime. The stream stays open — a refusal of one frame is not proof the
    // path is down.
    this.failPendingFinal(error);
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer !== null) return;
    const delay = reconnectDelayMs(this.reconnectAttempt, this.random());
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}

class BrowserSocket implements IQbtcpSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(private readonly socket: WebSocket) {
    socket.onopen = (event) => this.onopen?.(event);
    socket.onmessage = (event) => this.onmessage?.({ data: event.data });
    socket.onclose = (event) => this.onclose?.({ code: event.code, reason: event.reason });
    socket.onerror = (event) => this.onerror?.(event);
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}

/** Build the default socket factory over the global WebSocket, or null where absent. */
export function browserSocketFactory(): QbtcpSocketFactory | null {
  const globalWebSocket = (globalThis as Record<string, unknown>).WebSocket;
  if (typeof globalWebSocket !== 'function') return null;
  const Native = globalWebSocket as new (url: string, protocols: string[]) => WebSocket;
  return (url, protocols) => new BrowserSocket(new Native(url, protocols));
}
