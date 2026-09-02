/**
 * A minimal APNs client, written to be run from a Cloudflare Worker.
 *
 * # What this prototype is for
 *
 * QBSheet Live's remote Live Activity updates need two different APNs surfaces, and they have
 * different transport requirements:
 *
 * | Operation | Host | Port |
 * | --- | --- | --- |
 * | Send a broadcast | `api.push.apple.com` | **443** |
 * | Create / read / delete a channel | `api-manage-broadcast.push.apple.com` | **2196** |
 *
 * The high-volume path is ordinary HTTPS. Only channel lifecycle — rare, a handful of calls per
 * tournament — uses a non-standard port. Cloudflare Workers gained custom outbound ports with the
 * `allow_custom_ports` compatibility flag (on by default since 2024-09-02) for hosts that are not
 * themselves behind Cloudflare, which `api-manage-broadcast.push.apple.com` is not.
 *
 * Whether that actually works end to end against Apple, from workerd, is a question about two
 * production systems and cannot be settled by reading documentation. `src/index.ts` exposes this
 * client as a probe so the answer is measured. See `docs/QBLIVE_PUSH_PROTOTYPE.md`.
 *
 * If it turns out Cloudflare cannot reach the channel-management endpoint, the fallback is narrow:
 * move *only* channel create/delete to another serverless platform. Everything else — the QBLive
 * backends, Director, the clients, and even broadcast sending — is unaffected, because sending is
 * on port 443.
 */

export interface ApnsEnvironmentHosts {
  /** Broadcast sending. Standard HTTPS. */
  send: string;
  /** Channel lifecycle. Non-standard port. */
  manage: string;
}

export const apnsHosts: Record<'production' | 'sandbox', ApnsEnvironmentHosts> = {
  production: {
    send: 'https://api.push.apple.com',
    manage: 'https://api-manage-broadcast.push.apple.com:2196',
  },
  sandbox: {
    send: 'https://api.sandbox.push.apple.com',
    manage: 'https://api-manage-broadcast.sandbox.push.apple.com:2195',
  },
};

export type ApnsEnvironment = keyof typeof apnsHosts;

export interface ApnsCredential {
  /** The 10-character Key ID from App Store Connect. */
  keyId: string;
  /** The 10-character Team ID. */
  teamId: string;
  /** The contents of the `.p8` file, PEM-encoded, including the BEGIN/END lines. */
  privateKeyPem: string;
}

export interface ApnsResult<T> {
  ok: boolean;
  status: number;
  /** Apple's `apns-request-id`, which is what a support conversation with Apple is keyed on. */
  requestId: string | null;
  body: T | null;
  /** Apple's error reason string, e.g. `BadDeviceToken`, `ExpiredProviderToken`. */
  reason: string | null;
  /** Set when the request never reached Apple at all: DNS, TLS, a blocked port. */
  transportError: string | null;
  /** Round-trip milliseconds, measured for the prototype report. */
  elapsedMs: number;
}

/**
 * Message storage policy for a broadcast channel.
 *
 * `NoMessageStored` gets a higher publishing budget from Apple and is right for anything that
 * updates often, which is what a live score is. `MostRecentMessageStored` keeps the newest update
 * for up to eight hours so a device that was off comes back to current state.
 *
 * QBSheet Live uses `MostRecentMessageStored`: a phone in a pocket during a round should show the
 * current score when it comes out, not a blank Activity. Score updates are coalesced to roughly one
 * per fifteen seconds, which is well inside the budget that policy allows.
 */
export const MessageStoragePolicy = {
  NoMessageStored: 0,
  MostRecentMessageStored: 1,
} as const;

// ---------------------------------------------------------------------------
// Provider tokens
// ---------------------------------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Mint an APNs provider JWT (ES256 over the P-256 curve).
 *
 * Apple rate-limits provider-token *generation*, not use, and refuses tokens older than one hour.
 * Nothing here caches; the caching is the `ApnsCredential` Durable Object's job in the production
 * gateway, and keeping this function pure makes that cache testable.
 */
export async function createProviderToken(
  credential: ApnsCredential,
  issuedAt = Date.now(),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(credential.privateKeyPem),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: 'ES256', kid: credential.keyId })));
  const claims = base64Url(
    new TextEncoder().encode(JSON.stringify({ iss: credential.teamId, iat: Math.floor(issuedAt / 1000) })),
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

async function apnsFetch<T>(url: string, init: RequestInit): Promise<ApnsResult<T>> {
  const started = Date.now();
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    let body: T | null = null;
    let reason: string | null = null;
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text) as T & { reason?: string };
        body = parsed;
        reason = typeof parsed.reason === 'string' ? parsed.reason : null;
      } catch {
        // Apple answers with an empty body on success and JSON on failure. Anything else is
        // interesting enough to surface verbatim in the prototype report.
        reason = text.slice(0, 512);
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      requestId: response.headers.get('apns-request-id'),
      body,
      reason,
      transportError: null,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    // This is the branch that answers the architectural question: a failure here means the request
    // never reached Apple, which for the management host means the port or the protocol was the
    // problem rather than the credential.
    return {
      ok: false,
      status: 0,
      requestId: null,
      body: null,
      reason: null,
      transportError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      elapsedMs: Date.now() - started,
    };
  }
}

export interface CreateChannelResult extends ApnsResult<unknown> {
  /** Base64 as Apple returns it. Opaque; never parsed, never assumed to be a fixed length. */
  channelId: string | null;
}

export async function createBroadcastChannel(options: {
  environment: ApnsEnvironment;
  bundleId: string;
  providerToken: string;
  messageStoragePolicy?: number;
  requestId?: string;
}): Promise<CreateChannelResult> {
  const host = apnsHosts[options.environment].manage;
  const started = Date.now();
  try {
    const response = await fetch(`${host}/1/apps/${encodeURIComponent(options.bundleId)}/channels`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${options.providerToken}`,
        'apns-request-id': options.requestId ?? crypto.randomUUID(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        'message-storage-policy':
          options.messageStoragePolicy ?? MessageStoragePolicy.MostRecentMessageStored,
        'push-type': 'LiveActivity',
      }),
    });
    const text = await response.text();
    return {
      ok: response.status === 201,
      status: response.status,
      requestId: response.headers.get('apns-request-id'),
      channelId: response.headers.get('apns-channel-id'),
      body: text.length > 0 ? safeJson(text) : null,
      reason:
        text.length > 0
          ? ((safeJson(text) as { reason?: string } | null)?.reason ?? text.slice(0, 512))
          : null,
      transportError: null,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      requestId: null,
      channelId: null,
      body: null,
      reason: null,
      transportError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      elapsedMs: Date.now() - started,
    };
  }
}

export async function readBroadcastChannel(options: {
  environment: ApnsEnvironment;
  bundleId: string;
  providerToken: string;
  channelId: string;
}): Promise<ApnsResult<{ 'message-storage-policy': number; 'push-type': string }>> {
  const host = apnsHosts[options.environment].manage;
  return apnsFetch(`${host}/1/apps/${encodeURIComponent(options.bundleId)}/channels`, {
    method: 'GET',
    headers: {
      authorization: `bearer ${options.providerToken}`,
      'apns-request-id': crypto.randomUUID(),
      'apns-channel-id': options.channelId,
    },
  });
}

export async function listBroadcastChannels(options: {
  environment: ApnsEnvironment;
  bundleId: string;
  providerToken: string;
}): Promise<ApnsResult<{ channels: string[] }>> {
  const host = apnsHosts[options.environment].manage;
  return apnsFetch(`${host}/1/apps/${encodeURIComponent(options.bundleId)}/all-channels`, {
    method: 'GET',
    headers: {
      authorization: `bearer ${options.providerToken}`,
      'apns-request-id': crypto.randomUUID(),
    },
  });
}

export async function deleteBroadcastChannel(options: {
  environment: ApnsEnvironment;
  bundleId: string;
  providerToken: string;
  channelId: string;
}): Promise<ApnsResult<unknown>> {
  const host = apnsHosts[options.environment].manage;
  return apnsFetch(`${host}/1/apps/${encodeURIComponent(options.bundleId)}/channels`, {
    method: 'DELETE',
    headers: {
      authorization: `bearer ${options.providerToken}`,
      'apns-request-id': crypto.randomUUID(),
      'apns-channel-id': options.channelId,
    },
  });
}

/**
 * Publish a broadcast Live Activity update.
 *
 * Standard HTTPS on port 443, so this path has none of the transport risk the management path has.
 * `apns-expiration: 0` is required for a `NoMessageStored` channel and rejected only there; for a
 * `MostRecentMessageStored` channel a non-zero expiration is what makes the update recoverable.
 */
export async function sendBroadcast(options: {
  environment: ApnsEnvironment;
  bundleId: string;
  providerToken: string;
  channelId: string;
  /** `update` or `end`. `start` is not valid on a broadcast channel. */
  event: 'update' | 'end';
  contentState: unknown;
  /** Seconds since the epoch. 0 means do not store. */
  expiration?: number;
  priority?: 1 | 5 | 10;
  /** Unix seconds. ActivityKit uses this to discard an update older than one it already applied. */
  timestamp?: number;
  alert?: unknown;
}): Promise<ApnsResult<unknown>> {
  const host = apnsHosts[options.environment].send;
  const payload = {
    aps: {
      timestamp: options.timestamp ?? Math.floor(Date.now() / 1000),
      event: options.event,
      'content-state': options.contentState,
      ...(options.alert ? { alert: options.alert } : {}),
    },
  };
  return apnsFetch(`${host}/4/broadcasts/apps/${encodeURIComponent(options.bundleId)}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${options.providerToken}`,
      'apns-request-id': crypto.randomUUID(),
      'apns-channel-id': options.channelId,
      'apns-push-type': 'liveactivity',
      'apns-priority': String(options.priority ?? 5),
      'apns-expiration': String(options.expiration ?? 0),
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

/**
 * The measured size of an encoded broadcast payload.
 *
 * Apple's documented ceiling for a broadcast payload is 5 120 bytes. Shard sizing is decided from
 * real measurements of this number rather than from an assumption about how many teams fit.
 */
export function broadcastPayloadBytes(contentState: unknown, alert?: unknown): number {
  const payload = {
    aps: {
      timestamp: Math.floor(Date.now() / 1000),
      event: 'update',
      'content-state': contentState,
      ...(alert ? { alert } : {}),
    },
  };
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

export const APNS_BROADCAST_PAYLOAD_LIMIT = 5120;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
