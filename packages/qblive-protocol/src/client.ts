/**
 * A QBLive client, shared by Live Web, Director's publication worker, and the conformance suite.
 *
 * # Untrusted by construction
 *
 * A QBLive backend is somebody else's server. Every response is size-capped before it is parsed and
 * validated before it is returned, and every request carries a timeout. The failure this prevents
 * is not exotic: a Live Web tab left open on a school Chromebook, pointed at a backend that has
 * started returning a gigabyte of JSON.
 */

import {
  parseEventPage,
  parseManifest,
  parseSnapshot,
  QbliveValidationError,
  qbliveLimits,
} from './validate.js';
import { qbliveUrl } from './bootstrap.js';
import type {
  QbliveError,
  QbliveErrorCode,
  QbliveEventPage,
  QbliveManifest,
  QbliveSnapshot,
} from './types.js';

export class QbliveClientError extends Error {
  constructor(
    readonly code: QbliveErrorCode | 'network' | 'too-large' | 'invalid',
    message: string,
    readonly status?: number,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = 'QbliveClientError';
  }
}

export interface QbliveClientOptions {
  backendOrigin: string;
  publicationId: string;
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout. A spectator on hotel WiFi should get an error, not a spinner forever. */
  timeoutMs?: number;
  /** Bearer credential. Set only by a publisher; never by a spectator client. */
  managementToken?: string;
}

const defaultTimeoutMs = 15_000;

export class QbliveClient {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: QbliveClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get origin(): string {
    return this.options.backendOrigin;
  }

  get publicationId(): string {
    return this.options.publicationId;
  }

  async manifest(signal?: AbortSignal): Promise<QbliveManifest> {
    return parseManifest(await this.getJson('manifest', signal));
  }

  async snapshot(signal?: AbortSignal): Promise<QbliveSnapshot> {
    return parseSnapshot(await this.getJson('snapshot', signal));
  }

  async events(after: number, limit = 64, signal?: AbortSignal): Promise<QbliveEventPage> {
    return parseEventPage(
      await this.getJson(`events?after=${encodeURIComponent(String(after))}&limit=${limit}`, signal),
    );
  }

  /** The WebSocket URL, or null when the backend does not advertise a stream. */
  streamUrl(manifest: QbliveManifest): string | null {
    if (!manifest.capabilities.stream) return null;
    const url = new URL(qbliveUrl(this.options.backendOrigin, this.options.publicationId, 'stream'));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  // -------------------------------------------------------------------------
  // Management
  // -------------------------------------------------------------------------

  async publishSnapshot(snapshot: QbliveSnapshot, signal?: AbortSignal): Promise<{ revision: number }> {
    return this.manage('PUT', 'snapshot', { snapshot }, signal);
  }

  async publishSections(body: unknown, signal?: AbortSignal): Promise<{ revision: number }> {
    return this.manage('POST', 'sections', body, signal);
  }

  async publishAnnouncement(body: unknown, signal?: AbortSignal): Promise<{ revision: number }> {
    return this.manage('POST', 'announcements', body, signal);
  }

  async finalize(
    revision: number,
    snapshot: QbliveSnapshot,
    signal?: AbortSignal,
  ): Promise<{ revision: number }> {
    return this.manage('POST', 'finalize', { revision, snapshot }, signal);
  }

  async unpublish(signal?: AbortSignal): Promise<{ revision: number }> {
    return this.manage('POST', 'unpublish', undefined, signal);
  }

  async destroy(signal?: AbortSignal): Promise<{ revision: number }> {
    return this.manage('DELETE', '', undefined, signal);
  }

  // -------------------------------------------------------------------------

  private managementBase(): string {
    const base = this.options.backendOrigin.replace(/\/$/, '');
    return `${base}/qblive/v1/manage/tournaments/${encodeURIComponent(this.options.publicationId)}`;
  }

  private async manage(
    method: string,
    action: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ revision: number }> {
    if (!this.options.managementToken) {
      throw new QbliveClientError('unauthorized', 'This QBLive client has no management credential.');
    }
    const url = action ? `${this.managementBase()}/${action}` : this.managementBase();
    const response = await this.request(url, {
      method,
      headers: {
        authorization: `Bearer ${this.options.managementToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const parsed = (await this.readJson(response)) as { revision?: number };
    if (typeof parsed.revision !== 'number') {
      throw new QbliveClientError('invalid', 'The backend did not report a revision.');
    }
    return { revision: parsed.revision };
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const url = qbliveUrl(this.options.backendOrigin, this.options.publicationId, path);
    return this.readJson(await this.request(url, { method: 'GET', signal }));
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? defaultTimeoutMs);
    // Both the caller's signal and the timeout must be able to cancel. `AbortSignal.any` is not
    // available everywhere QBSheet runs, so the caller's signal is forwarded by hand.
    const forward = () => controller.abort();
    init.signal?.addEventListener('abort', forward, { once: true });
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) throw await this.toError(response);
      return response;
    } catch (reason) {
      if (reason instanceof QbliveClientError) throw reason;
      throw new QbliveClientError(
        'network',
        reason instanceof Error && reason.name === 'AbortError'
          ? 'The tournament server did not respond in time.'
          : 'The tournament server could not be reached.',
      );
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', forward);
    }
  }

  private async toError(response: Response): Promise<QbliveClientError> {
    let body: Partial<QbliveError> = {};
    try {
      body = (await response.json()) as Partial<QbliveError>;
    } catch {
      // A backend that answers an error with something that is not JSON is still an error.
    }
    return new QbliveClientError(
      (body.error as QbliveErrorCode) ?? 'internal',
      body.message ?? `The tournament server answered ${response.status}.`,
      response.status,
      body.currentRevision,
    );
  }

  /**
   * Read a bounded response body.
   *
   * `content-length` is a hint a hostile server can lie about, so the body is also measured as it
   * is read. Reading through the stream rather than calling `.json()` is the only way to stop
   * before a response that never ends has filled memory.
   */
  private async readJson(response: Response): Promise<unknown> {
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > qbliveLimits.maxBodyBytes) {
      throw new QbliveClientError('too-large', 'That tournament document is too large.');
    }
    const body = response.body;
    let text: string;
    if (!body) {
      text = await response.text();
      if (text.length > qbliveLimits.maxBodyBytes) {
        throw new QbliveClientError('too-large', 'That tournament document is too large.');
      }
    } else {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let received = 0;
      let accumulated = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > qbliveLimits.maxBodyBytes) {
          await reader.cancel();
          throw new QbliveClientError('too-large', 'That tournament document is too large.');
        }
        accumulated += decoder.decode(value, { stream: true });
      }
      text = accumulated + decoder.decode();
    }
    if (text.length === 0) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new QbliveClientError('invalid', 'The tournament server sent something that is not JSON.');
    }
  }
}

export { QbliveValidationError };
