/** @vitest-environment jsdom */

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  claimLiveBackend,
  forgetLiveCredential,
  readLiveCredential,
  storeLiveCredential,
} from '../src/director/live/credentials';

function clearNativeBridge() {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

describe('QBSheet Live credential boundary', () => {
  afterEach(() => {
    clearNativeBridge();
  });

  test('browser builds never retain a credential in memory or browser storage', async () => {
    await expect(storeLiveCredential('bcdfghjkmnpqrstvwxyz', 'secret')).rejects.toThrow(
      /Director desktop app.*operating-system credential store/,
    );
    await expect(readLiveCredential('bcdfghjkmnpqrstvwxyz')).rejects.toThrow(/credentials are unavailable/);
    expect(localStorage.length).toBe(0);
  });

  test('a browser cannot spend a one-time setup token without durable storage', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      claimLiveBackend({
        origin: 'https://live.example',
        publicationId: 'bcdfghjkmnpqrstvwxyz',
        setupToken: 'one-time',
        fetchImpl,
      }),
    ).rejects.toThrow(/requires the Director desktop app/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('native bridge is the only credential storage path', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'director_read_live_credential') return 'secret';
      return undefined;
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });

    await expect(storeLiveCredential('bcdfghjkmnpqrstvwxyz', 'secret')).resolves.toMatchObject({
      keychainAccount: 'bcdfghjkmnpqrstvwxyz',
    });
    await expect(readLiveCredential('bcdfghjkmnpqrstvwxyz')).resolves.toBe('secret');
    await expect(forgetLiveCredential('bcdfghjkmnpqrstvwxyz')).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('director_store_live_credential', {
      publicationId: 'bcdfghjkmnpqrstvwxyz',
      token: 'secret',
    });
    expect(invoke).toHaveBeenCalledWith('director_forget_live_credential', {
      publicationId: 'bcdfghjkmnpqrstvwxyz',
    });
  });
});
