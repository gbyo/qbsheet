/**
 * The entry point.
 *
 * Deliberately thin, and deliberately not wrapped in `StrictMode`. The scorer's state lives in refs
 * that are the authority for what has been scored (see `useGameEvents`), and double-invoking
 * effects in development to find missing cleanups is not worth a development-only behaviour
 * difference in the one part of this application where being wrong costs a room its game.
 */
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { registerServiceWorker } from './pwa/registerServiceWorker';
import { watchForErrors } from './app/ErrorLog';
import { capturePairingLaunch } from './app/PairingLaunch';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import './app/app-shell.css';
import './app/readiness.css';
import './scorer/scorer.css';
import './practice/practice.css';
import './app/motion.css';

// First, before anything at all.
//
// A QBTCP pairing launch link carries a short pairing code in the URL fragment, and the whole of
// what makes that acceptable is that it stops being in the URL immediately. Immediately means here:
// ahead of the error logger, which records the page URL alongside anything thrown on the way up, and
// ahead of the first render, which is however many milliseconds of the code sitting in the address
// bar of a device somebody is holding up in a room. Nothing below this line ever sees the fragment.
// See `PairingLaunch`.
capturePairingLaunch();

// Installed before the application renders, so an error thrown on the way up is still recorded.
// This only writes things down; it never changes what the room sees. See `ErrorLog`.
watchForErrors();

const container = document.getElementById('root');
if (container) createRoot(container).render(<App />);

registerServiceWorker();
