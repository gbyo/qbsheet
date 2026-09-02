/**
 * The QBLive management credential.
 *
 * # Where a secret lives
 *
 * Not in the tournament document. A Director file gets emailed, copied to a USB stick, and opened
 * on a co-director's laptop; a publisher credential inside it would be a credential that travels.
 * The document carries only a *pointer* — which keychain service and account — and the secret goes
 * to the operating system's credential store through Tauri.
 *
 * The browser preview has no OS keychain, so it refuses a remote one-time claim. A `localStorage`
 * fallback would put a publisher credential in a place any script on the origin can read, and an
 * in-memory credential would disappear after the setup token had already been consumed. See
 * `docs/QBLIVE.md#11-management-api`.
 */

import type { LivePublicationCredentialRef } from '../domain';

const keychainService = 'com.qbsheet.director.qblive';

interface NativeBridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

function native(): NativeBridge | null {
  if (typeof window === 'undefined') return null;
  return window.__TAURI_INTERNALS__ ?? null;
}

export function credentialRefFor(publicationId: string): LivePublicationCredentialRef {
  return { keychainService, keychainAccount: publicationId, verifiedAt: null };
}

export async function storeLiveCredential(
  publicationId: string,
  token: string,
): Promise<LivePublicationCredentialRef> {
  const bridge = native();
  if (!bridge) {
    throw new LiveClaimError(
      'QBSheet Live credentials can only be stored by the Director desktop app and its operating-system credential store.',
    );
  }
  await bridge.invoke('director_store_live_credential', { publicationId, token });
  return { ...credentialRefFor(publicationId), verifiedAt: new Date().toISOString() };
}

/** Refuse a one-time backend claim until the native secure store proves it can persist secrets. */
export async function ensureLiveCredentialStore(): Promise<void> {
  const bridge = native();
  if (!bridge) {
    throw new LiveClaimError(
      'Remote QBSheet Live setup requires the Director desktop app and its operating-system credential store.',
    );
  }
  await bridge.invoke('director_probe_live_credential_store');
}

export async function readLiveCredential(publicationId: string): Promise<string | null> {
  const bridge = native();
  if (bridge) {
    const value = await bridge.invoke('director_read_live_credential', { publicationId });
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
  throw new LiveClaimError(
    'QBSheet Live credentials are unavailable outside the Director desktop app and its operating-system credential store.',
  );
}

export async function forgetLiveCredential(publicationId: string): Promise<void> {
  const bridge = native();
  if (!bridge) {
    throw new LiveClaimError(
      'QBSheet Live credentials can only be removed by the Director desktop app and its operating-system credential store.',
    );
  }
  await bridge.invoke('director_forget_live_credential', { publicationId });
}

/** True when this build can keep a credential across restarts. Drives what the UI promises. */
export function hasDurableCredentialStore(): boolean {
  return native() !== null;
}

export class LiveClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveClaimError';
  }
}

/**
 * Exchange a one-time setup token for a durable management credential.
 *
 * The short-lived value is the one that travels through a browser address bar and a copy-paste; the
 * durable one never does. The exchange is single-use at the backend, so a setup token that leaks
 * after a successful claim is worth nothing.
 */
export async function claimLiveBackend(options: {
  origin: string;
  publicationId: string;
  setupToken: string;
  displayName?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ managementToken: string; origin: string }> {
  // This guard belongs here as well as in the controller: callers must not be able to spend a
  // one-time backend token through this helper unless the resulting credential has a durable
  // destination. The controller's earlier probe is an inexpensive UX improvement, not the
  // security boundary.
  await ensureLiveCredentialStore();
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${options.origin.replace(/\/$/, '')}/qblive/v1/manage/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        setupToken: options.setupToken,
        publicationId: options.publicationId,
        displayName: options.displayName,
      }),
    });
  } catch {
    throw new LiveClaimError('That tournament server could not be reached.');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new LiveClaimError(body.message ?? `That tournament server answered ${response.status}.`);
  }
  const body = (await response.json()) as { managementToken?: string; origin?: string };
  if (typeof body.managementToken !== 'string' || body.managementToken.length === 0) {
    throw new LiveClaimError('That tournament server did not return a management credential.');
  }
  return { managementToken: body.managementToken, origin: body.origin ?? options.origin };
}
