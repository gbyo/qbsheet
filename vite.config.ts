/**
 * Build configuration for a site that has to work from a directory it does not know the name of.
 *
 * GitHub Pages serves a project repository at `https://user.github.io/repository/`, so every asset
 * URL the build emits has to resolve from there rather than from `/`. The default `base` is
 * therefore `./` — relative — which resolves correctly at the root, at `/repository/`, at a
 * deep-linked `/repository/index.html`, and from a `file://` copy on a USB stick. `BASE_PATH` is
 * available for a deployment that genuinely needs an absolute prefix, and `npm run build` is
 * verified at a non-root base in the test suite.
 *
 * The consequence is that the application must never rely on path-based routing: there is no server
 * to rewrite `/repository/game/42` back onto `index.html`, and a reload of such a URL is a Pages
 * 404. Application state lives in the URL fragment (see `Routing`), which no server ever sees.
 */
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Which build this is, in a form somebody can read out loud over a radio.
 *
 * # Why it is deliberately not the build time
 *
 * The obvious identifier is a timestamp, and it is the wrong one. Anything injected into the bundle
 * changes the bundle's content hash, the hash changes the precache list, and the precache list is
 * what the service worker's cache name is derived from — so a timestamp would mean that rebuilding
 * identical source ships an update to every device in the venue. On a Saturday that is a room full
 * of "Update available" notices for a build that changed nothing.
 *
 * The commit is the identity, and the commit's own date is the timestamp. Both are properties of the
 * source, so two builds of the same source are the same build and no device is told otherwise.
 *
 * A build with no git available — a tarball, a vendored copy on a tournament laptop — reports
 * `unknown` rather than inventing something. `QBSHEET_COMMIT` and `QBSHEET_BUILT_AT` override, which
 * is how a CI runner that has the SHA in the environment but no full checkout gets a real answer.
 */
function gitOutput(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // No git, no repository, or a checkout with no commits. None of those is a build failure.
    return null;
  }
}

interface IBuildIdentity {
  version: string;
  commit: string;
  builtAt: string;
}

function buildIdentity(): IBuildIdentity {
  const manifest = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')) as {
    version?: string;
  };
  const commit = process.env.QBSHEET_COMMIT ?? process.env.GITHUB_SHA ?? gitOutput(['rev-parse', 'HEAD']);
  const committedAt = process.env.QBSHEET_BUILT_AT ?? gitOutput(['show', '-s', '--format=%cI', 'HEAD']);
  return {
    version: manifest.version ?? '0.0.0',
    // Seven characters is what a person can read out and what a director can paste into an issue.
    commit: commit === null ? 'unknown' : commit.slice(0, 7),
    builtAt: committedAt ?? '',
  };
}

/** Marketing-page output is deployed beside the scorer, but is not part of its offline shell. */
export function isScorerPrecacheAsset(fileName: string): boolean {
  return !fileName.endsWith('.map') && fileName !== 'about/index.html' && !fileName.startsWith('about/');
}

/**
 * Emit the service worker with the exact asset list this build produced.
 *
 * Written as a plugin rather than shipped as a static file because a precache list has to name the
 * content-hashed bundles, and those names are not known until the bundle exists. The cache name
 * carries a digest of that same list, so a build that changes anything gets a new cache and the
 * previous one is deleted on activation — which is what keeps a stale worker from pinning an old
 * application on a Chromebook that has been open all season.
 */
function serviceWorkerPlugin(identity: IBuildIdentity): Plugin {
  return {
    name: 'qbsheet-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const emitted = Object.keys(bundle).filter(isScorerPrecacheAsset);
      // Files copied straight from `public/` are not part of the bundle and have to be named. They
      // are also not content-hashed, which is why the cache name is derived from the whole list.
      const staticFiles = [
        'index.html',
        'manifest.webmanifest',
        'favicon.ico',
        'apple-touch-icon.png',
        'icon.svg',
        'icon-maskable.svg',
        'icon-192.png',
        'icon-512.png',
        'icon-maskable-512.png',
      ];
      const precache = [...new Set([...staticFiles, ...emitted])].sort();
      const buildId = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 16);
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: serviceWorkerSource(buildId, precache, identity),
      });
    },
  };
}

export function serviceWorkerSource(buildId: string, precache: string[], identity: IBuildIdentity): string {
  return `/* Generated by vite.config.ts. Do not edit. */
const CACHE = 'qbsheet-shell-${buildId}';
/**
 * What this worker is, so a page can ask the thing serving it rather than guess.
 *
 * A device can be running new application code delivered straight off the network while an older
 * worker still owns the cache. That is a real state, it is invisible from inside the page, and it is
 * the first thing worth knowing when a room is behaving like it is running last week's build.
 */
const BUILD = ${JSON.stringify({ ...identity, cache: `qbsheet-shell-${buildId}` })};
const PRECACHE = ${JSON.stringify(precache, null, 2)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Relative to the worker's own URL, so the same file works at any base path. One asset that
      // will not cache must not fail the install and leave the room with no offline shell at all.
      Promise.all(
        PRECACHE.map((asset) =>
          cache.add(new Request(new URL(asset, self.registration.scope), { cache: 'reload' })).catch(() => undefined),
        ),
      ),
    ),
  );
  // Deliberately no \`skipWaiting()\` here.
  //
  // A new worker that takes over the moment it installs deletes the old cache on activation, and the
  // page still on screen is mid-game and still lazily fetching assets out of it. Waiting is the whole
  // safety property: the new build sits installed and idle, the running game keeps the shell it
  // started with, and the swap happens when somebody who knows the round is over presses a button.
  // See \`AppUpdate\`.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  // The page has decided it is safe to swap: no game is on screen, or the one that was has finished.
  if (event.data === 'qbsheet:skip-waiting') {
    self.skipWaiting();
    return;
  }
  // A diagnostics or readiness screen asking which build is actually serving this page. Answered over
  // the port the caller supplied, so nothing has to be broadcast to every tab.
  if (event.data === 'qbsheet:build' && event.ports[0]) {
    event.ports[0].postMessage(BUILD);
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Tournament control is a different origin and its answers are never authoritative from a cache:
  // a stale assignment or a replayed submission verdict is worse than an honest network error.
  if (url.origin !== self.location.origin) return;
  // Same-origin non-shell requests (there are none today) are left alone for the same reason.
  if (!url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;

  const scopeUrl = new URL(self.registration.scope);
  const relativePath = url.pathname.slice(scopeUrl.pathname.length);
  // The product page is a separate Vite entry. It is deliberately network-owned: it must never be
  // stored as the scorer shell, served the scorer's offline fallback, or put its own assets in the
  // cache whose activation is coordinated around an active game.
  if (relativePath === 'about' || relativePath.startsWith('about/')) return;

  if (request.mode === 'navigate') {
    // The application has no path routes. Only the scope root (and an explicit index.html) is a
    // scorer-shell navigation; every other document in the static deployment is outside its PWA.
    const scorerIndexPath = new URL('index.html', scopeUrl).pathname;
    if (url.pathname !== scopeUrl.pathname && url.pathname !== scorerIndexPath) return;
    // Network first, so a deployed update is picked up the moment the room is online, with the
    // cached shell behind it so a dead network still opens the scoresheet.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(new URL('index.html', self.registration.scope), copy));
          return response;
        })
        .catch(() =>
          caches
            .match(new URL('index.html', self.registration.scope))
            .then((cached) => cached ?? Response.error()),
        ),
    );
    return;
  }

  // Built assets are content-hashed, so a hit is the right file by construction.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
`;
}

const identity = buildIdentity();

export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  plugins: [react(), serviceWorkerPlugin(identity)],
  // Added to `import.meta.env` rather than as a bare global so that a context which never went
  // through this config — the library build, a unit test — reads `undefined` instead of throwing a
  // ReferenceError. See `BuildVersion`.
  define: { 'import.meta.env.QBSHEET_BUILD': JSON.stringify(identity) },
  build: {
    rollupOptions: {
      input: {
        scorer: resolve(import.meta.dirname, 'index.html'),
        about: resolve(import.meta.dirname, 'about/index.html'),
      },
      output: {
        // Keeping page-only assets below /about/ lets the scorer worker ignore the entire surface
        // with one path rule. Shared assets, such as the real wordmark, remain ordinary scorer
        // assets and keep their usual content-hashed location.
        entryFileNames: (chunk) =>
          chunk.name === 'about' ? 'about/assets/[name]-[hash].js' : 'assets/[name]-[hash].js',
        assetFileNames: (asset) => {
          const sourceNames = asset.originalFileNames ?? [];
          const belongsToAbout =
            asset.name === 'about.css' ||
            sourceNames.some(
              (name) => name.includes('/src/about/') || name.includes('about-qbsheet-practice.webp'),
            );
          return belongsToAbout ? 'about/assets/[name]-[hash][extname]' : 'assets/[name]-[hash][extname]';
        },
      },
    },
    // A room's Chromebook is not a phone on a train; a slightly larger single chunk that is
    // guaranteed present offline beats several that might not all have been cached.
    chunkSizeWarningLimit: 1500,
  },
});
