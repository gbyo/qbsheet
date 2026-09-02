/**
 * The APNs client.
 *
 * Grown from the prototype in `apps/qblive-push-prototype`, whose measurements are recorded in
 * `docs/QBLIVE_PUSH_PROTOTYPE.md`. The two facts that shape it:
 *
 * 1. **Sending is on port 443.** `api.push.apple.com/4/broadcasts/apps/{bundleId}` is ordinary
 *    HTTPS, so the high-volume path has no transport risk.
 * 2. **Channel lifecycle is on port 2196.** `api-manage-broadcast.push.apple.com:2196` is a
 *    non-standard port, used a handful of times per tournament. If the deployed edge cannot reach
 *    it, `ChannelManager` gets a second implementation and nothing else changes.
 *
 * Apple advertises only `h2` in ALPN and drops anything speaking HTTP/1.1, which is why this cannot
 * be integration-tested in local `workerd`. Everything here is therefore written so the interesting
 * logic — dedup, coalescing, budget, payload construction — is testable without a network.
 */

export const apnsHosts = {
  production: {
    send: 'https://api.push.apple.com',
    manage: 'https://api-manage-broadcast.push.apple.com:2196',
  },
  sandbox: {
    send: 'https://api.sandbox.push.apple.com',
    manage: 'https://api-manage-broadcast.sandbox.push.apple.com:2195',
  },
} as const;

export type ApnsEnvironment = keyof typeof apnsHosts;

/** Apple's ceiling for a broadcast payload. */
export const BROADCAST_PAYLOAD_LIMIT = 5120;

export const MessageStoragePolicy = {
  NoMessageStored: 0,
  /**
   * The newest message is kept for up to eight hours.
   *
   * Chosen over `NoMessageStored` — which has a higher publishing budget — because a phone in a
   * pocket during a round should show the current score when it comes out, not a blank Activity.
   * Score updates are coalesced to roughly one per fifteen seconds, well inside what this allows.
   * The policy is fixed at channel creation and cannot be changed afterwards.
   */
  MostRecentMessageStored: 1,
} as const;

export interface ApnsCredentialMaterial {
  keyId: string;
  teamId: string;
  privateKeyPem: string;
}

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
 * Mint an APNs provider JWT (ES256 over P-256).
 *
 * Nothing here caches; the caching is `ApnsCredential`'s job, and keeping this pure makes the cache
 * testable. Apple refuses tokens older than one hour and rate-limits generation, which is exactly
 * why generation is centralised rather than done per request.
 */
export async function mintProviderToken(
  credential: ApnsCredentialMaterial,
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

export interface BroadcastPayloadOptions {
  state: unknown;
  event: 'update' | 'end';
  /** Unix seconds. ActivityKit discards an update older than one it already applied. */
  timestamp: number;
  alert?: { title: string; body: string };
}

/**
 * Build the APNs body for a broadcast Live Activity update.
 *
 * A function rather than inline construction, so the size test in `test/` measures exactly what the
 * sender transmits. A payload over Apple's limit is rejected wholesale, which during a tournament
 * would look like the Lock Screen silently freezing.
 */
export function broadcastPayload(options: BroadcastPayloadOptions): string {
  return JSON.stringify({
    aps: {
      timestamp: options.timestamp,
      event: options.event,
      'content-state': options.state,
      ...(options.alert ? { alert: options.alert } : {}),
    },
  });
}

export function payloadBytes(body: string): number {
  return new TextEncoder().encode(body).length;
}

export interface ApnsOutcome {
  ok: boolean;
  status: number;
  reason: string | null;
  requestId: string | null;
  /** Set when the request never reached Apple. Distinguished from a rejection on purpose. */
  transportError: string | null;
}

/** Send a broadcast Live Activity update. Standard HTTPS; no transport risk. */
export async function sendBroadcast(options: {
  environment: ApnsEnvironment;
  bundleId: string;
  providerToken: string;
  channelId: string;
  body: string;
  priority: 1 | 5 | 10;
  /** Unix seconds, or 0 for "do not store". Non-zero is required by MostRecentMessageStored. */
  expiration: number;
  fetchImpl?: typeof fetch;
}): Promise<ApnsOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${apnsHosts[options.environment].send}/4/broadcasts/apps/${encodeURIComponent(options.bundleId)}`;
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        authorization: `bearer ${options.providerToken}`,
        'apns-request-id': crypto.randomUUID(),
        'apns-channel-id': options.channelId,
        'apns-push-type': 'liveactivity',
        'apns-priority': String(options.priority),
        'apns-expiration': String(options.expiration),
        'content-type': 'application/json',
      },
      body: options.body,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      reason: text ? (safeReason(text) ?? text.slice(0, 256)) : null,
      requestId: response.headers.get('apns-request-id'),
      transportError: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      reason: null,
      requestId: null,
      transportError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

/** Send an ordinary notification to one device token. Used for announcements. */
export async function sendNotification(options: {
  environment: ApnsEnvironment;
  bundleId: string;
  providerToken: string;
  deviceToken: string;
  title: string;
  body: string;
  /** Urgent announcements interrupt; the rest do not. */
  interruptionLevel: 'passive' | 'active' | 'time-sensitive';
  publicationId: string;
  fetchImpl?: typeof fetch;
}): Promise<ApnsOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${apnsHosts[options.environment].send}/3/device/${encodeURIComponent(options.deviceToken)}`;
  const payload = JSON.stringify({
    aps: {
      alert: { title: options.title, body: options.body },
      sound: 'default',
      'interruption-level': options.interruptionLevel,
      'relevance-score': options.interruptionLevel === 'time-sensitive' ? 1 : 0.5,
    },
    // So a tap reopens the right tournament even when the launch carries no invocation URL.
    // See `docs/QBLIVE_IOS.md#app-clip-notifications`.
    publicationId: options.publicationId,
  });
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        authorization: `bearer ${options.providerToken}`,
        'apns-request-id': crypto.randomUUID(),
        'apns-topic': options.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': options.interruptionLevel === 'passive' ? '5' : '10',
        'content-type': 'application/json',
      },
      body: payload,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      reason: text ? (safeReason(text) ?? text.slice(0, 256)) : null,
      requestId: response.headers.get('apns-request-id'),
      transportError: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      reason: null,
      requestId: null,
      transportError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

function safeReason(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { reason?: string };
    return typeof parsed.reason === 'string' ? parsed.reason : null;
  } catch {
    return null;
  }
}

/**
 * A device token APNs has told us to stop using.
 *
 * `410 Unregistered` and `400 BadDeviceToken` mean the token will never work again. Retrying either
 * is how a push service ends up spending a tournament's budget on phones that have been wiped.
 */
export function tokenIsDead(outcome: ApnsOutcome): boolean {
  if (outcome.status === 410) return true;
  return outcome.status === 400 && outcome.reason === 'BadDeviceToken';
}

/** Whether a failure is worth retrying. */
export function isRetryable(outcome: ApnsOutcome): boolean {
  if (outcome.transportError) return true;
  if (outcome.status === 429) return true;
  if (outcome.status >= 500) return true;
  // 403 ExpiredProviderToken is retryable exactly once, after the coordinator rotates.
  return outcome.status === 403 && outcome.reason === 'ExpiredProviderToken';
}
