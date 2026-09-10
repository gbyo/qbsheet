import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimRelayBackend,
  ensureRelayCredentialStore,
  forgetRelayCredential,
  hasDurableRelayCredentialStore,
  readRelayCredential,
  RelayClaimError,
  rotateRelayCredential,
  storeRelayCredential,
} from './relayCredentials';

const tournamentId = 'bcdfghjkmnpqrstvwxyz1234';
const baseUrl = 'https://qbtcp-relay-abc.xyz123.workers.dev';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** In-memory stand-in for the OS keychain behind the Tauri bridge. */
function installKeychain(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'director_probe_relay_credential_store':
        return null;
      case 'director_store_relay_credential':
        store.set(args?.tournamentId as string, args?.token as string);
        return null;
      case 'director_read_relay_credential':
        return store.get(args?.tournamentId as string) ?? null;
      case 'director_forget_relay_credential':
        store.delete(args?.tournamentId as string);
        return null;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
  window.__TAURI_INTERNALS__ = { invoke };
  return { store, invoke };
}

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

describe('credential persistence across a Director restart', () => {
  it('stores through the bridge and reads back the same secret', async () => {
    const { invoke } = installKeychain();
    expect(hasDurableRelayCredentialStore()).toBe(true);
    await ensureRelayCredentialStore();
    await storeRelayCredential(tournamentId, 'management-credential-1');
    // A restart re-installs the bridge over the same OS store: the secret survives.
    delete window.__TAURI_INTERNALS__;
    window.__TAURI_INTERNALS__ = { invoke };
    expect(await readRelayCredential(tournamentId)).toBe('management-credential-1');
    await forgetRelayCredential(tournamentId);
    expect(await readRelayCredential(tournamentId)).toBeNull();
  });

  it('refuses every credential operation without the desktop app', async () => {
    expect(hasDurableRelayCredentialStore()).toBe(false);
    await expect(ensureRelayCredentialStore()).rejects.toBeInstanceOf(RelayClaimError);
    await expect(storeRelayCredential(tournamentId, 'x')).rejects.toBeInstanceOf(RelayClaimError);
    await expect(readRelayCredential(tournamentId)).rejects.toBeInstanceOf(RelayClaimError);
    await expect(forgetRelayCredential(tournamentId)).rejects.toBeInstanceOf(RelayClaimError);
  });
});

describe('first-time claim', () => {
  it('exchanges the setup secret once and persists the credential before reporting success', async () => {
    const { store, invoke } = installKeychain();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { managementToken: 'fresh-management-credential', tournamentId }),
    );
    const claimed = await claimRelayBackend({
      baseUrl,
      tournamentId,
      setupToken: 'one-time-secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(claimed.managementToken).toBe('fresh-management-credential');
    // The request carried the setup secret in the body — never in the URL.
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${baseUrl}/qbtcp/v1/manage/claim`);
    expect(url).not.toContain('one-time-secret');
    expect(JSON.parse(init.body as string)).toEqual({ setupToken: 'one-time-secret', tournamentId });
    // The credential reached the keychain through the bridge.
    expect(store.get(tournamentId)).toBeUndefined();
    await storeRelayCredential(tournamentId, claimed.managementToken);
    expect(store.get(tournamentId)).toBe('fresh-management-credential');
    expect(invoke).toHaveBeenCalledWith('director_store_relay_credential', {
      tournamentId,
      token: 'fresh-management-credential',
    });
  });

  it('never spends the setup secret when there is nowhere durable to keep the credential', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { managementToken: 'x', tournamentId }));
    await expect(
      claimRelayBackend({
        baseUrl,
        tournamentId,
        setupToken: 'one-time-secret',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(RelayClaimError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports an invalid setup secret distinctly from an already-claimed relay', async () => {
    installKeychain();
    const invalid = vi.fn(async () => jsonResponse(401, { message: 'That setup token is not valid.' }));
    await expect(
      claimRelayBackend({
        baseUrl,
        tournamentId,
        setupToken: 'wrong',
        fetchImpl: invalid as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/not valid/);

    const consumed = vi.fn(async () =>
      jsonResponse(403, { message: 'This relay has already been claimed.' }),
    );
    await expect(
      claimRelayBackend({
        baseUrl,
        tournamentId,
        setupToken: 'stale',
        fetchImpl: consumed as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/already been claimed/);
  });

  it('refuses to claim an unreachable relay', async () => {
    installKeychain();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      claimRelayBackend({
        baseUrl,
        tournamentId,
        setupToken: 'one-time-secret',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/could not be reached/);
  });
});

describe('rotation', () => {
  it('persists the replacement credential before resolving', async () => {
    const { store } = installKeychain({ [tournamentId]: 'old-credential' });
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { managementToken: 'new-credential', tournamentId }),
    );
    const next = await rotateRelayCredential({
      baseUrl,
      tournamentId,
      currentToken: 'old-credential',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(next).toBe('new-credential');
    expect(store.get(tournamentId)).toBe('new-credential');
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer old-credential');
    // The setup secret plays no part in rotation.
    expect(JSON.stringify(init)).not.toContain('setup');
  });

  it('surfaces a refused stored credential distinctly', async () => {
    installKeychain();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { message: 'That management credential is not valid.' }),
    );
    await expect(
      rotateRelayCredential({
        baseUrl,
        tournamentId,
        currentToken: 'dead-credential',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/not valid/);
  });
});
