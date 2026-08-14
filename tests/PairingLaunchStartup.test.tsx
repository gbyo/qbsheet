/**
 * @vitest-environment jsdom
 */

/**
 * The order of the first three things this application does.
 *
 * A pairing code in the address bar is acceptable for exactly as long as it takes to read it, and
 * "before the app starts" is not a comment somebody can be trusted to preserve — it is an ordering
 * between statements in `main.tsx` that a well-meaning import sort would happily break. So the order
 * is asserted: by the time the error logger is installed, the fragment is gone, and by the time React
 * is handed a tree, it is still gone.
 *
 * The error logger matters specifically because of what it records. It stamps `event.filename` on an
 * uncaught exception, and on a document that threw during startup that filename is the page URL —
 * which, for the few milliseconds before this ordering was made explicit, was a URL with a live
 * pairing code in it, on its way into a diagnostics file somebody emails to a stranger.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const code = '48213906';
const launchFragment = `#qbtcp-pair?v=1&server=${encodeURIComponent('http://192.168.1.24:3000')}&code=${code}`;

/** What the URL looked like at each step of startup, in the order the steps ran. */
const timeline: { step: string; href: string }[] = [];

vi.mock('../src/app/ErrorLog', () => ({
  watchForErrors: () => {
    timeline.push({ step: 'watchForErrors', href: window.location.href });
    return () => undefined;
  },
}));

vi.mock('../src/pwa/registerServiceWorker', () => ({
  registerServiceWorker: () => {
    timeline.push({ step: 'registerServiceWorker', href: window.location.href });
  },
}));

vi.mock('../src/app/App', () => ({
  default: () => {
    timeline.push({ step: 'render', href: window.location.href });
    return null;
  },
}));

vi.mock('react-dom/client', () => ({
  createRoot: () => ({
    render: () => {
      timeline.push({ step: 'createRoot.render', href: window.location.href });
    },
    unmount: () => undefined,
  }),
}));

beforeEach(() => {
  timeline.length = 0;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
});

afterEach(() => {
  window.history.replaceState(null, '', '/scoresheet/');
});

test('the pairing fragment is consumed before the error logger and before React', async () => {
  window.history.replaceState(null, '', `/scoresheet/${launchFragment}`);

  await import('../src/main');

  // Every step of startup ran on a URL with nothing secret in it.
  expect(timeline.map((entry) => entry.step)).toEqual([
    'watchForErrors',
    'createRoot.render',
    'registerServiceWorker',
  ]);
  for (const entry of timeline) {
    expect(entry.href).not.toContain(code);
    expect(entry.href).not.toContain('qbtcp-pair');
  }
  expect(window.location.pathname).toBe('/scoresheet/');
  expect(window.location.hash).toBe('');
});

test('a URL with no pairing fragment starts up exactly as it always did', async () => {
  window.history.replaceState(null, '', '/scoresheet/#anchor');

  await import('../src/main');

  expect(timeline.map((entry) => entry.step)).toEqual([
    'watchForErrors',
    'createRoot.render',
    'registerServiceWorker',
  ]);
  expect(window.location.hash).toBe('#anchor');
});
