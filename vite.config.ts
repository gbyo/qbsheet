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
 * 404. So there are no route paths, and no screen, game or connection is addressable — which screen
 * is on is decided from local storage. The one thing the URL ever carries is a QBTCP pairing launch
 * fragment, which is a bootstrap message consumed and removed before the application renders rather
 * than state anything reloads into. See `PairingLaunch`.
 */
import { defineConfig, type Plugin, type Rollup } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
// Build-time only. Nothing in the client graph imports these, so neither the wiki content nor the
// Markdown renderer reaches any bundle. See the note at the top of `wikiContent`.
import {
  editUrlFor,
  readWikiPage,
  readWikiSections,
  slugFor,
  wikiPageNames,
} from './src/about/wikiContent';
import { readFileSync } from 'node:fs';
import { posix, resolve, sep } from 'node:path';

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

/** The element in `about/index.html` that the rendered page is placed inside, and the only edit made to it. */
const aboutRootDiv = '<div id="about-root"></div>';

/** The product page's own copy of the screenshot, which nothing in the client bundle imports any more. */
const aboutScreenshot = 'src/assets/about-qbsheet-practice.webp';

/**
 * The assets the rendered markup names by their development URL.
 *
 * An ordinary Vite asset import inside a component — the screenshot in `About` — produces
 * `/src/assets/…` in a server-side render, and the build has to swap in the content-hashed file it
 * actually emitted.
 *
 * The wordmark used to be the other member of this list. It is now inline SVG in `BrandLogo` so that
 * it can take `currentColor` and follow the dark appearance, which means it is no longer an emitted
 * asset and no longer has a URL to rewrite.
 */
const aboutAssetSources = [aboutScreenshot];

/**
 * The documents rendered to static HTML at build time, and the component each one is.
 *
 * Adding an entry here and a matching `input` below is the whole of adding a page. The HTML path is
 * also the statement of how deep the document sits, because a relative asset URL has to be written
 * against the directory that names it: `about/index.html` and `about/self-host/index.html` need
 * different numbers of `../` for the same emitted file.
 */
interface IPrerenderedPage {
  html: string;
  module: string;
  /** Passed to the component when it is rendered. Only the wiki needs any. */
  props?: Record<string, unknown>;
}

/**
 * The wiki, which is content rather than a set of hand-written pages.
 *
 * Every article shares one component and differs only by the props computed here, so a page added to
 * the wiki on GitHub becomes a page on this site with nothing written in this repository beyond the
 * synced Markdown and the entry `scripts/generate-wiki-pages.mjs` writes for it.
 *
 * Read once, at module load, because `readWikiSections` is the same answer for all sixteen and the
 * config is evaluated once per build.
 */
function wikiPages(): IPrerenderedPage[] {
  const root = import.meta.dirname;
  const sections = readWikiSections(root);
  return wikiPageNames(root).map((name) => ({
    html: `about/wiki/${slugFor(name)}/index.html`,
    module: '/src/about/WikiPage.tsx',
    props: { page: readWikiPage(root, name), sections, editUrl: editUrlFor(name) },
  }));
}

const prerenderedPages: IPrerenderedPage[] = [
  { html: 'about/index.html', module: '/src/about/About.tsx' },
  { html: 'about/scoring/index.html', module: '/src/about/Scoring.tsx' },
  { html: 'about/tournaments/index.html', module: '/src/about/Tournaments.tsx' },
  { html: 'about/self-host/index.html', module: '/src/about/SelfHost.tsx' },
  { html: 'about/faq/index.html', module: '/src/about/Faq.tsx' },
  { html: 'about/privacy/index.html', module: '/src/about/Privacy.tsx' },
  ...wikiPages(),
];

/**
 * The name of the chunk every marketing page shares, which is the name of the module they all load.
 *
 * # Why a constant, and why the module is not called `main.ts`
 *
 * Rollup hoists a module imported by more than one entry into a chunk of its own and names that chunk
 * after the module. Vite then names the stylesheet it extracts after the chunk. That stylesheet is the
 * one output here that arrives at `assetFileNames` with an empty `originalFileNames`, so its name is
 * the only evidence connecting it to these pages — and an unrecognised name is written to `assets/`,
 * where `isScorerPrecacheAsset` sweeps it into the offline shell coordinated around an active game.
 *
 * With one page the chunk was the `about` entry and the name fell out for free. With two it did not:
 * the shared module was `src/about/main.ts`, so the chunk became `main`, and the page's CSS landed in
 * the scorer's precache list. Naming it here, once, is what ties the module, the chunk and the
 * stylesheet together. `ServiceWorkerIsolation.test.ts` asserts the pages still load it.
 */
const aboutChunkName = 'pages';

/** Path comparison that does not care which kind of slash the host uses. */
function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * Whether a source path is one of the marketing pages' own files.
 *
 * The leading slash is added so that this answers the same for an absolute module id and for the
 * repository-relative `originalFileNames` Rollup reports on an asset, which are the two forms the
 * same file arrives in below.
 */
function isAboutSource(path: string | null | undefined): boolean {
  return typeof path === 'string' && `/${toPosix(path)}`.includes('/src/about/');
}

/**
 * Whether a chunk is marketing-page output rather than scorer output.
 *
 * # Why this is not `chunk.name === 'about'`
 *
 * It was, and one entry is all that held it up. Two pages share `src/about/main.ts`, so Rollup hoists
 * that module out of both entries into a single shared chunk of its own — named after the module,
 * `main`, and routed by `chunkFileNames` rather than `entryFileNames`. A name comparison misses it,
 * the chunk lands in the scorer's `assets/`, and `isScorerPrecacheAsset` then sweeps the marketing
 * page's JavaScript and stylesheet into the offline shell that is coordinated around an active game.
 *
 * So the question is asked of the modules a chunk actually contains. An HTML entry has none of them,
 * because its facade is the document, which is why the pages are checked by name as well.
 */
function isAboutChunk(chunk: Rollup.PreRenderedChunk): boolean {
  if (chunk.moduleIds.some(isAboutSource)) return true;
  const facade = chunk.facadeModuleId;
  if (typeof facade !== 'string') return false;
  return prerenderedPages.some((page) => toPosix(facade).endsWith(`/${page.html}`));
}

/**
 * Render the product page to static HTML at build time.
 *
 * # Why this page is not a single-page application
 *
 * `about/index.html` used to ship an empty `<div id="about-root">` and mount React into it, which meant
 * a static marketing page — no state, no interactivity beyond links — could not show a word of itself
 * until a JavaScript bundle had downloaded, parsed and run. That cost is paid by exactly the readers
 * least able to afford it, it hides the copy from anything that does not execute scripts, and it keeps
 * the largest image on the page out of the HTML where the preload scanner would have found it.
 *
 * So the component is rendered here instead, once, and the deployment serves the result. The page needs
 * React at build time and none at run time.
 *
 * # Why it is still a React component
 *
 * Because the alternative is a hand-written HTML file holding a second copy of the wordmark, the type
 * scale, the tokens and the button, with nothing keeping that copy in step with the scorer it advertises.
 * Rendering the real component costs one build step and makes the drift impossible.
 *
 * # How the module is loaded
 *
 * Through a throwaway Vite development server, which is the supported way to load a `.tsx` module in
 * Node using the project's own resolution, and which resolves the asset imports to development URLs
 * that `transformIndexHtml` then rewrites against the real bundle. `configFile: false` is what stops it
 * loading this file and recursing.
 */
function aboutPrerenderPlugin(): Plugin {
  let base = './';
  let root = '';
  let building = false;
  const markup = new Map<string, string>();
  let loadModule: ((id: string) => Promise<Record<string, unknown>>) | null = null;

  async function render(page: IPrerenderedPage): Promise<string> {
    if (loadModule === null) throw new Error('The product page renderer is not available.');
    const loaded = await loadModule(page.module);
    // Props exist for the wiki, whose sixteen articles are one component and sixteen sets of content.
    // Every hand-written page takes none and is called with an empty object, which React treats the
    // same as no props at all.
    const Page = loaded.default as (props: Record<string, unknown>) => ReactElement;
    return renderToStaticMarkup(createElement(Page, page.props ?? {}));
  }

  /** An emitted file's URL as the document that names it, sitting in `directory`, has to write it. */
  function assetUrl(fileName: string, directory: string): string {
    if (!base.startsWith('.')) return `${base}${fileName}`;
    const url = posix.relative(directory, fileName);
    return url.startsWith('.') ? url : `./${url}`;
  }

  function emittedUrl(bundle: Rollup.OutputBundle, source: string, directory: string): string {
    for (const output of Object.values(bundle)) {
      if (output.type !== 'asset') continue;
      if ((output.originalFileNames ?? []).some((name) => toPosix(name).endsWith(source))) {
        return assetUrl(output.fileName, directory);
      }
    }
    // Shipping the page with a development URL in it would 404 the wordmark or the screenshot on a
    // deployed site, which is the one class of failure prerendering is supposed to make impossible.
    throw new Error(`The product page needs ${source}, and the build emitted no such asset.`);
  }

  return {
    name: 'qbsheet-about-prerender',
    configResolved(resolved) {
      base = resolved.base;
      root = resolved.root;
      building = resolved.command === 'build';
    },
    configureServer(server) {
      // Rendered per request in development, where the component's own asset URLs already resolve.
      loadModule = (id) => server.ssrLoadModule(id);
    },
    async buildStart() {
      if (!building) return;
      // Nothing in the client graph imports the screenshot now that no React reaches the browser, so
      // the asset is emitted here. `originalFileName` is what routes it below `about/` and what lets
      // the markup's development URL be matched to it.
      this.emitFile({
        type: 'asset',
        name: 'about-qbsheet-practice.webp',
        originalFileName: aboutScreenshot,
        source: readFileSync(new URL(aboutScreenshot, import.meta.url)),
      });
      const { createServer } = await import('vite');
      const server = await createServer({
        configFile: false,
        root,
        logLevel: 'warn',
        appType: 'custom',
        server: { middlewareMode: true, hmr: false },
        // Only `ssrLoadModule` is ever called on this server, and the client dependency scan it would
        // otherwise start reads both HTML entries and then reports being cancelled when the server is
        // closed a few milliseconds later. Nothing needs it.
        optimizeDeps: { noDiscovery: true, include: [] },
      });
      try {
        loadModule = (id) => server.ssrLoadModule(id);
        for (const page of prerenderedPages) {
          markup.set(page.html, await render(page));
        }
      } finally {
        loadModule = null;
        await server.close();
      }
    },
    async transformIndexHtml(html, ctx) {
      const filename = toPosix(ctx.filename);
      // A nested page's path — `about/self-host/index.html` — does not end with `about/index.html`,
      // so no page can be mistaken for another and the deeper ones need no priority in this search.
      const page = prerenderedPages.find((candidate) => filename.endsWith(`/${candidate.html}`));
      if (page === undefined) return;
      const rendered = building ? markup.get(page.html) : await render(page);
      if (rendered === undefined) throw new Error(`The ${page.html} page was not rendered.`);
      const bundle = ctx.bundle;
      const directory = posix.dirname(page.html);
      const resolved =
        bundle === undefined
          ? rendered
          : aboutAssetSources.reduce(
              // Only assets this page actually names. Resolving the others would demand that every
              // page emit every asset, and the self-hosting page has no screenshot.
              (current, source) =>
                current.includes(`/${source}`)
                  ? current.replaceAll(`/${source}`, emittedUrl(bundle, source, directory))
                  : current,
              rendered,
            );
      return html.replace(aboutRootDiv, `<div id="about-root">${resolved}</div>`);
    },
  };
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
  plugins: [react(), aboutPrerenderPlugin(), serviceWorkerPlugin(identity)],
  // Added to `import.meta.env` rather than as a bare global so that a context which never went
  // through this config — the library build, a unit test — reads `undefined` instead of throwing a
  // ReferenceError. See `BuildVersion`.
  define: { 'import.meta.env.QBSHEET_BUILD': JSON.stringify(identity) },
  build: {
    rollupOptions: {
      input: {
        scorer: resolve(import.meta.dirname, 'index.html'),
        about: resolve(import.meta.dirname, 'about/index.html'),
        'about-scoring': resolve(import.meta.dirname, 'about/scoring/index.html'),
        'about-tournaments': resolve(import.meta.dirname, 'about/tournaments/index.html'),
        'about-self-host': resolve(import.meta.dirname, 'about/self-host/index.html'),
        'about-faq': resolve(import.meta.dirname, 'about/faq/index.html'),
        'about-privacy': resolve(import.meta.dirname, 'about/privacy/index.html'),
        // Derived from the same list that produced the entries, so a page added to the wiki needs no
        // edit here. `generate-wiki-pages.mjs` writes the documents these names point at.
        ...Object.fromEntries(
          wikiPageNames(import.meta.dirname).map((name) => [
            `about-wiki-${slugFor(name)}`,
            resolve(import.meta.dirname, `about/wiki/${slugFor(name)}/index.html`),
          ]),
        ),
      },
      output: {
        // Keeping page-only output below /about/ lets the scorer worker ignore the entire surface
        // with one path rule. Shared assets, such as the real wordmark, remain ordinary scorer
        // assets and keep their usual content-hashed location.
        //
        // All three of these have to agree. The marketing pages' code reaches the bundle as an entry
        // chunk, as the shared chunk every page hoists between them, and as the stylesheet that
        // chunk carries, and a rule that catches two of the three still leaves the third inside the
        // scorer's precache list.
        entryFileNames: (chunk) =>
          isAboutChunk(chunk) ? 'about/assets/[name]-[hash].js' : 'assets/[name]-[hash].js',
        chunkFileNames: (chunk) =>
          isAboutChunk(chunk) ? 'about/assets/[name]-[hash].js' : 'assets/[name]-[hash].js',
        assetFileNames: (asset) => {
          const sourceNames = asset.originalFileNames ?? [];
          const belongsToAbout =
            // The extracted stylesheet, which has no sources to be recognised by. See `aboutChunkName`.
            asset.name === `${aboutChunkName}.css` ||
            sourceNames.some((name) => isAboutSource(name) || toPosix(name).endsWith(aboutScreenshot));
          return belongsToAbout ? 'about/assets/[name]-[hash][extname]' : 'assets/[name]-[hash][extname]';
        },
      },
    },
    // A room's Chromebook is not a phone on a train; a slightly larger single chunk that is
    // guaranteed present offline beats several that might not all have been cached.
    chunkSizeWarningLimit: 1500,
  },
});
