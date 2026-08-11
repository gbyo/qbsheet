/**
 * Making the site openable when the network is not.
 *
 * # What is cached, and what is emphatically not
 *
 * The application shell: the HTML, the JavaScript, the stylesheet, the manifest, the icon. Those
 * are content-hashed by the build and are the same bytes for everybody, so serving them from a
 * cache is serving the right file.
 *
 * Nothing from tournament control is cached, ever. An assignment, a session state, a submission
 * verdict — these are answers about a tournament that is changing while the room is standing in it,
 * and a cached one is a confident lie. The worker declines to touch any cross-origin request at
 * all, which is the version of that rule that cannot be got wrong by accident.
 *
 * Games are not cached either. They live in this device's own storage, which is a different
 * mechanism with different guarantees; see `GameStore`.
 *
 * # Why registration is deferred and why failure is silent
 *
 * The scoresheet works without a service worker. It will not survive a cold start with no network,
 * but every other property — local persistence, recovery after reload, QBJ export — holds. So
 * registration waits until the page has loaded rather than competing with it, and a browser that
 * refuses (no support, an insecure context, a locked-down profile) gets no error and no degraded
 * mode: it gets an application that simply needs the network to open.
 *
 * # Updates are detected here and applied nowhere
 *
 * Registration is also where the update watcher is attached, because that is where the registration
 * object exists. Attaching it does not give anything permission to replace the running application:
 * see `AppUpdate` for why the swap needs both a waiting worker and a screen that has declared itself
 * safe to reload.
 */

import { appUpdates } from './AppUpdate';

/** Whether this browser will let a page install one at all. */
export function serviceWorkerSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined';
}

export function registerServiceWorker(): void {
  if (!serviceWorkerSupported()) return;
  // Vite rewrites `import.meta.env.DEV`; a worker precaching a dev server's module graph would
  // serve a room yesterday's code from a cache nobody asked for.
  if (import.meta.env?.DEV) return;

  window.addEventListener('load', () => {
    // Relative to the document, so the worker's scope is whatever directory the site is deployed
    // in — `/` on a user site, `/repository/` on a project one — with nothing to configure.
    navigator.serviceWorker
      .register(new URL('sw.js', window.location.href), { scope: './' })
      .then((registration) => {
        appUpdates.observe(registration, navigator.serviceWorker);
      })
      .catch(() => {
        // Nothing to tell the scorekeeper. The application works; it just will not open cold offline.
      });
  });
}
