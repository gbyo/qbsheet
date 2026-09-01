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
import RenderErrorBoundary from './app/RenderErrorBoundary';
import { registerServiceWorker } from './pwa/registerServiceWorker';
import { watchForErrors } from './app/ErrorLog';
import { startDisplayPreferences } from './app/displayPreference';
import { capturePairingLaunch } from './app/PairingLaunch';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import './app/app-shell.css';
import './app/readiness.css';
/*
 * The scorer's stylesheets, in cascade order.
 *
 * They were one 3,200-line file. The order below is the order they appeared in it and has to stay
 * that way; a new one belongs at the end of this list rather than in the middle. See `scorer.css`.
 */
import './scorer/scorer.css';
import './scorer/scorer-dialogs.css';
import './scorer/scorer-procedure.css';
import './scorer/scorer-review.css';
import './scorer/print.css';
import './scorer/scorer-table.css';
import './practice/practice.css';
import './app/motion.css';
// Last, because both of the modes it handles are corrections to what everything above decided.
import './app/contrast.css';

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

// Before the first paint, not in an effect. An effect would show one frame of the device's own
// appearance before switching to the scorekeeper's, and a flash of white is the exact thing somebody
// who chose dark chose dark to avoid. See `displayPreference`.
startDisplayPreferences();

// Outside the application, so that whatever throws inside it has somewhere to land. A boundary
// rendered by `App` could not catch a throw from `App` itself, which is the case that produces the
// blank screen this exists to replace. See `RenderErrorBoundary`.
const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <RenderErrorBoundary>
      <App />
    </RenderErrorBoundary>,
  );
}

registerServiceWorker();
