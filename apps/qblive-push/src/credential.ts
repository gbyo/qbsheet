/**
 * The APNs provider-token coordinator.
 *
 * # Why one object
 *
 * Apple rate-limits provider-token *generation*, not use, and refuses a token older than one hour.
 * A Worker that minted a JWT per request would be signing thousands of times a minute during a busy
 * Saturday and would eventually be told to stop — at which point every Live Activity in every
 * tournament would stop updating at once.
 *
 * So exactly one Durable Object mints and caches the token, and every sender asks it. One signature
 * per rotation, for the whole service.
 *
 * # What it never does
 *
 * It never logs the key, the token, or any signing material, and it has no route that returns the
 * key. The `.p8` exists only in this Worker's secrets: not in Director, not in a tournament's
 * Cloudflare account, not in the app, not in the App Clip.
 */

import { DurableObject } from 'cloudflare:workers';

import { mintProviderToken } from './apns';

/**
 * How long a cached token is used for.
 *
 * Apple's limit is one hour. Rotating at forty minutes leaves twenty minutes of margin, so a token
 * cannot expire in flight behind a queue that is draining a burst — the failure that would look
 * like "the Lock Screen stopped updating for twenty minutes in the middle of the playoffs".
 */
const TOKEN_LIFETIME_MS = 40 * 60 * 1000;

interface CachedToken {
  token: string;
  mintedAt: number;
}

export class ApnsCredential extends DurableObject<Env> {
  /**
   * Held in an instance field, not storage.
   *
   * A provider token is derived data with a forty-minute life. Persisting it would put signing
   * output in a durable store for no benefit — an evicted object simply mints a new one, which is
   * one signature.
   */
  private cached: CachedToken | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/token') {
      const token = await this.token();
      if (!token) {
        return Response.json(
          { error: 'unconfigured', message: 'This push gateway has no APNs credential configured.' },
          { status: 503 },
        );
      }
      return Response.json({ token });
    }
    if (url.pathname === '/rotate') {
      // Called by a sender that got `ExpiredProviderToken`, so the next attempt does not reuse the
      // token Apple just refused.
      this.cached = null;
      return Response.json({ rotated: true });
    }
    return Response.json({ error: 'not-found', message: 'No such route.' }, { status: 404 });
  }

  /** The current token, minting one if the cache is empty or stale. */
  async token(now = Date.now()): Promise<string | null> {
    const { APNS_PRIVATE_KEY, APNS_KEY_ID, APNS_TEAM_ID } = this.env;
    if (!APNS_PRIVATE_KEY || !APNS_KEY_ID || !APNS_TEAM_ID) return null;
    if (this.cached && now - this.cached.mintedAt < TOKEN_LIFETIME_MS) return this.cached.token;
    const token = await mintProviderToken(
      { keyId: APNS_KEY_ID, teamId: APNS_TEAM_ID, privateKeyPem: APNS_PRIVATE_KEY },
      now,
    );
    this.cached = { token, mintedAt: now };
    return token;
  }
}

/** Ask the coordinator for the current token. */
export async function providerToken(env: Env): Promise<string> {
  const stub = env.APNS_CREDENTIAL.get(env.APNS_CREDENTIAL.idFromName('singleton'));
  const response = await stub.fetch('https://credential/token');
  if (!response.ok) {
    throw new Error('This push gateway has no APNs credential configured.');
  }
  const body = (await response.json()) as { token: string };
  return body.token;
}

/** Discard the cached token after Apple reported it expired. */
export async function rotateProviderToken(env: Env): Promise<void> {
  const stub = env.APNS_CREDENTIAL.get(env.APNS_CREDENTIAL.idFromName('singleton'));
  await stub.fetch('https://credential/rotate');
}
