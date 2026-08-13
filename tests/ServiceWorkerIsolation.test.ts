// @vitest-environment node
import { runInNewContext } from 'node:vm';
import { describe, expect, test, vi } from 'vitest';
import { isScorerPrecacheAsset, serviceWorkerSource } from '../vite.config';

interface IFetchEvent {
  request: { method: string; mode: string; url: string };
  respondWith: (response: Promise<Response>) => void;
}

function workerHarness(options?: {
  scope?: string;
  fetch?: (request: IFetchEvent['request']) => Promise<Response>;
  cachedShell?: Response;
}) {
  const scope = options?.scope ?? 'https://qbsheet.com/';
  const listeners = new Map<string, (event: IFetchEvent) => void>();
  const cache = {
    add: vi.fn(async (_request: Request) => undefined),
    put: vi.fn(async (_request: Request | URL, _response: Response) => undefined),
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
    match: vi.fn(async () => options?.cachedShell),
  };
  const fetch = vi.fn(options?.fetch ?? (async () => new Response('network')));
  const self = {
    location: { origin: new URL(scope).origin },
    registration: { scope },
    clients: { claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, listener: (event: IFetchEvent) => void) => listeners.set(type, listener),
  };

  runInNewContext(
    serviceWorkerSource('test-build', ['index.html', 'assets/scorer.js'], {
      version: '0.1.0',
      commit: 'test',
      builtAt: '',
    }),
    { caches, fetch, Promise, Request, Response, self, URL },
  );

  const dispatchFetch = (url: string, mode = 'navigate') => {
    let response: Promise<Response> | undefined;
    const respondWith = vi.fn((value: Promise<Response>) => {
      response = value;
    });
    listeners.get('fetch')?.({ request: { method: 'GET', mode, url }, respondWith });
    return { respondWith, response };
  };

  return { cache, caches, dispatchFetch, fetch };
}

describe('the generated scorer service worker', () => {
  test('does not precache the about document or its page-only assets', () => {
    expect(isScorerPrecacheAsset('index.html')).toBe(true);
    expect(isScorerPrecacheAsset('assets/scorer-a1b2.js')).toBe(true);
    expect(isScorerPrecacheAsset('about/index.html')).toBe(false);
    expect(isScorerPrecacheAsset('about/assets/about-a1b2.js')).toBe(false);
    expect(isScorerPrecacheAsset('about/assets/about-a1b2.css')).toBe(false);
  });

  test('leaves /about/ navigation and assets entirely to the network', () => {
    const harness = workerHarness({ scope: 'https://qbsheet.com/qbsheet/' });

    const navigation = harness.dispatchFetch('https://qbsheet.com/qbsheet/about/');
    const asset = harness.dispatchFetch('https://qbsheet.com/qbsheet/about/assets/about-a1b2.js', 'cors');

    expect(navigation.respondWith).not.toHaveBeenCalled();
    expect(asset.respondWith).not.toHaveBeenCalled();
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.caches.open).not.toHaveBeenCalled();
    expect(harness.cache.put).not.toHaveBeenCalled();
  });

  test('an about response cannot replace the cached scorer index', () => {
    const harness = workerHarness({
      fetch: async () => new Response('<html>about</html>', { headers: { 'content-type': 'text/html' } }),
    });

    harness.dispatchFetch('https://qbsheet.com/about/');

    expect(harness.cache.put).not.toHaveBeenCalled();
    expect(harness.caches.open).not.toHaveBeenCalled();
  });

  test('keeps the scorer root network-first with its existing offline fallback', async () => {
    const cachedShell = new Response('<html>scorer shell</html>');
    const harness = workerHarness({
      fetch: async () => Promise.reject(new TypeError('offline')),
      cachedShell,
    });

    const event = harness.dispatchFetch('https://qbsheet.com/');

    expect(event.respondWith).toHaveBeenCalledOnce();
    await expect(event.response).resolves.toBe(cachedShell);
    expect(harness.caches.match).toHaveBeenCalledOnce();
  });

  test('updates the cached scorer index after a successful root navigation', async () => {
    const response = new Response('<html>scorer</html>');
    const harness = workerHarness({ fetch: async () => response });

    const event = harness.dispatchFetch('https://qbsheet.com/');
    await expect(event.response).resolves.toBe(response);
    await vi.waitFor(() => expect(harness.cache.put).toHaveBeenCalledOnce());

    const cachedUrl = harness.cache.put.mock.calls[0]?.[0];
    expect(String(cachedUrl)).toBe('https://qbsheet.com/index.html');
  });
});
