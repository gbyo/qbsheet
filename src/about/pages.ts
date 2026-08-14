/**
 * Everything the marketing pages need at runtime, which is not much.
 *
 * The markup is rendered to static HTML at build time (see `aboutPrerenderPlugin` in `vite.config.ts`),
 * so no React reaches the browser here and none of the pages' content depends on this file loading.
 * What is left is the webfont, the stylesheet, and the scroll reveals. Every page under `about/` loads
 * this one file, which is why it is not named for any of them.
 *
 * # The filename is load-bearing
 *
 * It was `main.ts`, and could not stay that once a second page imported it. Rollup hoists a module
 * shared by two entries into a chunk of its own and names that chunk after the module; Vite then
 * names the stylesheet it extracts after the chunk. That stylesheet arrives at `assetFileNames` with
 * no `originalFileNames` to identify it by, so the chunk's name is the only thing marking the page CSS
 * as page CSS rather than scorer CSS — and anything unmarked lands in `assets/`, which is what
 * `isScorerPrecacheAsset` sweeps into the offline shell coordinated around an active game.
 *
 * So renaming this file renames the chunk, renames the stylesheet, and puts the marketing pages' CSS
 * inside the scorer's precache. `aboutChunkName` in `vite.config.ts` is the other half of the name,
 * and `ServiceWorkerIsolation.test.ts` asserts that every page still loads this module.
 */
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import './about.css';
import startReveals from './reveal';

startReveals();
