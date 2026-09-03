// @vitest-environment node
import { readFileSync } from 'node:fs';
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
    // Every marketing page, however deep. The rule is the `about/` prefix and not a list of files,
    // so a page added below it is outside the scorer's shell without anybody remembering to say so.
    expect(isScorerPrecacheAsset('about/self-host/index.html')).toBe(false);
    // The two product pages are ordinary marketing pages and are covered by the same prefix. There
    // is no longer a Director entry beside the scorer for a second rule to exclude.
    expect(isScorerPrecacheAsset('about/director/index.html')).toBe(false);
    expect(isScorerPrecacheAsset('about/qblive/index.html')).toBe(false);
  });

  /**
   * The isolation above is a path rule, and the path is decided by a filename.
   *
   * Rollup hoists a module shared by two entries into its own chunk and names that chunk after the
   * module. Vite names the extracted stylesheet after the chunk, and that stylesheet reaches
   * `assetFileNames` carrying no `originalFileNames`, so the chunk's name is the only evidence that
   * the CSS belongs to the marketing pages. Named anything but `about`, it is written to `assets/`,
   * `isScorerPrecacheAsset` returns true for it, and the page's stylesheet is precached into the
   * offline shell whose activation is coordinated around an active game.
   *
   * This is not hypothetical: adding the second page renamed the chunk from `about` to `main` and did
   * exactly that. So the shared entry module's name is asserted, not assumed.
   */
  test('every marketing page loads the one entry module the chunk is named for', () => {
    for (const page of [
      'about/index.html',
      'about/scoring/index.html',
      'about/tournaments/index.html',
      'about/director/index.html',
      'about/qblive/index.html',
      'about/self-host/index.html',
      'about/faq/index.html',
      'about/privacy/index.html',
    ]) {
      const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
      expect(html).toContain('src="/src/about/pages.ts"');
    }
  });

  test('leaves /about/ navigation and assets entirely to the network', () => {
    const harness = workerHarness({ scope: 'https://qbsheet.com/qbsheet/' });

    const navigation = harness.dispatchFetch('https://qbsheet.com/qbsheet/about/');
    const nested = harness.dispatchFetch('https://qbsheet.com/qbsheet/about/self-host/');
    const asset = harness.dispatchFetch('https://qbsheet.com/qbsheet/about/assets/about-a1b2.js', 'cors');

    expect(navigation.respondWith).not.toHaveBeenCalled();
    expect(nested.respondWith).not.toHaveBeenCalled();
    expect(asset.respondWith).not.toHaveBeenCalled();
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.caches.open).not.toHaveBeenCalled();
    expect(harness.cache.put).not.toHaveBeenCalled();
  });

  /**
   * The product pages are marketing pages, and the worker has to leave them alone for the same
   * reason it leaves the rest of `about/` alone.
   *
   * This test used to be about `director.html`, the browser Director build that was deployed beside
   * the scorer. That entry is gone, and the surface it needed a rule of its own for now sits under
   * `about/` with every other document on the site — so what is asserted here is that the pages
   * which replaced it are covered by the prefix rule rather than by anything Director-specific.
   */
  test('leaves the Director and QBLive pages entirely to the network', () => {
    const harness = workerHarness({ scope: 'https://qbsheet.com/qbsheet/' });

    const director = harness.dispatchFetch('https://qbsheet.com/qbsheet/about/director/');
    const qblive = harness.dispatchFetch('https://qbsheet.com/qbsheet/about/qblive/');

    expect(director.respondWith).not.toHaveBeenCalled();
    expect(qblive.respondWith).not.toHaveBeenCalled();
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
