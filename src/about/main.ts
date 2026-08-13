/**
 * Everything the product page needs at runtime, which is not much.
 *
 * The markup is rendered to static HTML at build time (see `aboutPrerenderPlugin` in `vite.config.ts`),
 * so no React reaches the browser here and none of the page's content depends on this file loading.
 * What is left is the webfont, the stylesheet, and the scroll reveals.
 */
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import './about.css';
import startReveals from './reveal';

startReveals();
