/**
 * The entry point.
 *
 * Deliberately thin, and deliberately not wrapped in `StrictMode`. The scorer's state lives in refs
 * that are the authority for what has been scored (see `useGameEvents`), and double-invoking
 * effects in development to find missing cleanups is not worth a development-only behaviour
 * difference in the one part of this application where being wrong costs a room its game.
 */
import { createRoot } from 'react-dom/client';
import { lazy, Suspense } from 'react';
import RenderErrorBoundary from './app/RenderErrorBoundary';
import { registerServiceWorker } from './pwa/registerServiceWorker';
import { watchForErrors } from './app/ErrorLog';
import { startDisplayPreferences } from './app/displayPreference';
import { capturePairingLaunch } from './app/PairingLaunch';
// This is the only stylesheet loaded before the bootstrap chooses a mode. It contains the standalone
// Recovery Mode and crash fallback rules; the normal shell/scorer styles are loaded only below.
import './app/recovery.css';
import { isRecoveryModeRequested } from './app/recoveryModeRequest';

async function loadNormalApplication() {
  // Keep the ordinary cascade in its existing order. Sequential CSS imports matter here: parallel
  // stylesheet requests would let network timing change which normal rule wins. None of these
  // imports is evaluated when the recovery query selects the safe-mode branch.
  await import('@fontsource/ibm-plex-sans/latin-400.css');
  await import('@fontsource/ibm-plex-sans/latin-500.css');
  await import('@fontsource/ibm-plex-sans/latin-600.css');
  await import('@fontsource/ibm-plex-sans/latin-700.css');
  await import('./app/app-shell.css');
  await import('./app/readiness.css');
  await import('./scorer/scorer.css');
  await import('./scorer/scorer-dialogs.css');
  await import('./scorer/scorer-procedure.css');
  await import('./scorer/scorer-review.css');
  await import('./scorer/print.css');
  await import('./scorer/scorer-table.css');
  await import('./practice/practice.css');
  await import('./app/motion.css');
  await import('./app/contrast.css');
  return import('./app/App');
}

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
//
// `App` is intentionally not imported above. Recovery Mode is a safe-mode bundle selected before
// the normal application is loaded; a scorer/render crash must not immediately recreate the tree
// that just failed.
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  if (isRecoveryModeRequested()) {
    void import('./app/RecoveryMode').then(({ default: RecoveryMode }) => {
      root.render(
        <RenderErrorBoundary>
          <RecoveryMode />
        </RenderErrorBoundary>,
      );
    });
  } else {
    // Keep the ordinary root handoff synchronous for startup ordering and let React load the normal
    // app only in the non-recovery branch. The recovery branch above never evaluates this lazy
    // importer, so it cannot request or mount the scorer tree.
    const App = lazy(loadNormalApplication);
    root.render(
      <RenderErrorBoundary>
        <Suspense fallback={null}>
          <App />
        </Suspense>
      </RenderErrorBoundary>,
    );
  }
}

registerServiceWorker();
