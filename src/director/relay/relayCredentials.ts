/**
 * The Internet QBTCP management credential: claim, storage, and rotation.
 *
 * # Where a secret lives
 *
 * Mirrors the QBLive credential design (`src/director/live/credentials.ts`): the tournament
 * document carries only a pointer (keychain account = tournament id) and the secret goes to the
 * operating system's credential store through Tauri. The browser preview has no OS keychain, so
 * it refuses a remote one-time claim — spending a single-use setup token with nowhere durable
 * to keep the resulting credential would burn the claim and strand the relay unmanageable.
 *
 * # Claim flow
 *
 * 1. Director probes the keychain (`ensureRelayCredentialStore`). If it cannot persist, the
 *    claim never starts and the setup secret stays valid.
 * 2. Director POSTs `{ setupToken, tournamentId }` to `/qbtcp/v1/manage/claim`.
 * 3. The relay answers once with `{ managementToken }` and consumes the setup secret.
 * 4. Director stores the management credential in the keychain before reporting success.
 *
 * Rotation (`rotateRelayCredential`) needs the current credential instead of the setup secret;
 * recovery after losing the credential is destroy-and-reclaim, documented in `relayConfig.ts`.
 */

import { isRelayTournamentId, relayKeychainService } from './relayConfig';

interface NativeBridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

function native(): NativeBridge | null {
  if (typeof window === 'undefined') return null;
  return window.__TAURI_INTERNALS__ ?? null;
}

export class RelayClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayClaimError';
  }
}

/** Refuse a one-time relay claim until the native secure store proves it can persist secrets. */
export async function ensureRelayCredentialStore(): Promise<void> {
  const bridge = native();
  if (!bridge) {
    throw new RelayClaimError(
      'Internet QBTCP setup requires the Director desktop app and its operating-system credential store.',
    );
  }
  await bridge.invoke('director_probe_relay_credential_store');
}

export async function storeRelayCredential(tournamentId: string, token: string): Promise<void> {
  const bridge = native();
  if (!bridge) {
    throw new RelayClaimError(
      'Relay credentials can only be stored by the Director desktop app and its operating-system credential store.',
    );
  }
  await bridge.invoke('director_store_relay_credential', { tournamentId, token });
}

export async function readRelayCredential(tournamentId: string): Promise<string | null> {
  const bridge = native();
  if (!bridge) {
    throw new RelayClaimError(
      'Relay credentials are unavailable outside the Director desktop app and its operating-system credential store.',
    );
  }
  const value = await bridge.invoke('director_read_relay_credential', { tournamentId });
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function forgetRelayCredential(tournamentId: string): Promise<void> {
  const bridge = native();
  if (!bridge) {
    throw new RelayClaimError(
      'Relay credentials can only be removed by the Director desktop app and its operating-system credential store.',
    );
  }
  await bridge.invoke('director_forget_relay_credential', { tournamentId });
}

/** True when this build can keep a credential across restarts. Drives what the UI promises. */
export function hasDurableRelayCredentialStore(): boolean {
  return native() !== null;
}

export function relayCredentialKeychainAccount(tournamentId: string): string {
  if (!isRelayTournamentId(tournamentId)) {
    throw new RelayClaimError('That tournament id is not valid.');
  }
  return tournamentId;
}

export { relayKeychainService };

function claimUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/qbtcp/v1/manage/claim`;
}

function rotateUrl(baseUrl: string, tournamentId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/qbtcp/v1/manage/tournaments/${tournamentId}/rotate`;
}

interface ClaimResponse {
  managementToken?: string;
  tournamentId?: string;
}

/**
 * Exchange a one-time setup secret for a durable management credential.
 *
 * Returns the plaintext credential once; the caller must store it in the keychain before doing
 * anything else. Never logs, renders, or persists the setup secret or the credential.
 */
export async function claimRelayBackend(options: {
  baseUrl: string;
  tournamentId: string;
  setupToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{ managementToken: string; tournamentId: string }> {
  // The guard belongs here as well as in the caller: nothing may spend a one-time setup secret
  // through this helper unless the resulting credential has a durable destination.
  await ensureRelayCredentialStore();
  if (!isRelayTournamentId(options.tournamentId)) {
    throw new RelayClaimError('That tournament id is not valid.');
  }
  if (!options.setupToken.trim()) {
    throw new RelayClaimError('Enter the one-time setup secret from deployment.');
  }
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(claimUrl(options.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken: options.setupToken, tournamentId: options.tournamentId }),
    });
  } catch {
    throw new RelayClaimError('That tournament relay could not be reached.');
  }
  if (response.status === 401) {
    throw new RelayClaimError('That setup secret is not valid for this relay.');
  }
  if (response.status === 403) {
    throw new RelayClaimError('This relay has already been claimed. Reset it before claiming again.');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new RelayClaimError(body.message ?? `That tournament relay answered ${response.status}.`);
  }
  const body = (await response.json()) as ClaimResponse;
  if (typeof body.managementToken !== 'string' || body.managementToken.length === 0) {
    throw new RelayClaimError('That tournament relay did not return a management credential.');
  }
  return { managementToken: body.managementToken, tournamentId: options.tournamentId };
}

/**
 * Rotate the management credential, then persist the replacement.
 *
 * Stores the new credential in the keychain before resolving. Ordering matters: the old
 * credential stops working the moment the relay answers, so a rotation that answered but was
 * not persisted would leave Director holding a dead credential. On store failure this throws,
 * and the caller must treat the relay as credential-lost (destroy-and-reclaim recovery)
 * rather than silently continuing with the dead credential.
 */
export async function rotateRelayCredential(options: {
  baseUrl: string;
  tournamentId: string;
  currentToken: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  await ensureRelayCredentialStore();
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(rotateUrl(options.baseUrl, options.tournamentId), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.currentToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
  } catch {
    throw new RelayClaimError('That tournament relay could not be reached.');
  }
  if (response.status === 401) {
    throw new RelayClaimError('The stored management credential is not valid for this relay.');
  }
  if (!response.ok) {
    throw new RelayClaimError(`That tournament relay answered ${response.status}.`);
  }
  const body = (await response.json()) as ClaimResponse;
  if (typeof body.managementToken !== 'string' || body.managementToken.length === 0) {
    throw new RelayClaimError('That tournament relay did not return a management credential.');
  }
  await storeRelayCredential(options.tournamentId, body.managementToken);
  return body.managementToken;
}
