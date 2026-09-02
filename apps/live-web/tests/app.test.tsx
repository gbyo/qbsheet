/**
 * Live Web behaviour.
 *
 * The tests that matter here are the ones about what the page must *not* say: no invented times, no
 * scores the tournament did not publish, and no cached data presented as current.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { QbliveSnapshot } from '@qbsheet/qblive-protocol';
import defaultSnapshot from '@qbsheet/qblive-protocol/fixtures/snapshot-default.json';
import maximalSnapshot from '@qbsheet/qblive-protocol/fixtures/snapshot-maximal.json';
import manifestFixture from '@qbsheet/qblive-protocol/fixtures/manifest.json';
import App from '../src/App';

const publicationId = 'bcdfghjkmnpqrstvwxyz';
const backend = 'https://backend.example';

function bootstrapUrl(): string {
  return `https://live.qbsheet.com/t/${publicationId}?b=${encodeURIComponent(backend)}&v=1`;
}

/** A backend that answers manifest and snapshot, and never advertises a stream. */
function stubBackend(snapshot: unknown, options: { stream?: boolean; fail?: boolean } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (options.fail) throw new TypeError('Failed to fetch');
    if (url.endsWith('/manifest')) {
      return Response.json({
        ...manifestFixture,
        revision: (snapshot as QbliveSnapshot).revision,
        capabilities: { ...manifestFixture.capabilities, stream: options.stream ?? false },
      });
    }
    if (url.endsWith('/snapshot')) return Response.json(snapshot);
    return Response.json({ error: 'not-found', message: 'no' }, { status: 404 });
  });
}

/**
 * Point the address bar at a tournament.
 *
 * `history.replaceState` rather than a `location` spy: jsdom derives the document origin from
 * `location`, and replacing it takes `localStorage` with it — which is exactly the behaviour the
 * staleness tests need to be real.
 */
function navigateTo(href: string): void {
  const url = new URL(href);
  window.history.replaceState({}, '', `${url.pathname}${url.search}`);
}

beforeEach(() => {
  navigateTo(bootstrapUrl());
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function openFollowing(teamName = 'Ninety Six A') {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('button', { name: new RegExp(teamName) });
  await user.click(screen.getByRole('button', { name: new RegExp(teamName) }));
  // Player selection appears only when rosters are published; dismiss it when it does.
  const notNow = screen.queryByRole('button', { name: 'Not now' });
  if (notNow) await user.click(notNow);
  return user;
}

describe('bootstrapping', () => {
  test('loads the tournament from its own backend, not from live.qbsheet.com', async () => {
    const fetchStub = stubBackend(defaultSnapshot);
    vi.stubGlobal('fetch', fetchStub);
    render(<App />);
    await screen.findByText('Saturday Invitational');
    const requested = fetchStub.mock.calls.map((call) => String(call[0]));
    expect(requested.every((url) => url.startsWith(backend))).toBe(true);
    expect(requested.some((url) => url.includes('live.qbsheet.com'))).toBe(false);
  });

  test('a link with no tournament shows a plain problem page', async () => {
    navigateTo('https://live.qbsheet.com/nonsense');
    vi.stubGlobal('fetch', stubBackend(defaultSnapshot));
    render(<App />);
    await screen.findByText('This link did not open a tournament');
  });
});

describe('following a team', () => {
  test('asks for a team and then shows its next event, with no account of any kind', async () => {
    vi.stubGlobal('fetch', stubBackend(defaultSnapshot));
    await openFollowing();
    await screen.findByRole('navigation', { name: 'Sections' });
    // Nothing anywhere asked for an identity.
    expect(screen.queryByText(/sign in|sign up|password|email|account/i)).toBeNull();
  });

  test('remembers the followed team across a reload', async () => {
    vi.stubGlobal('fetch', stubBackend(defaultSnapshot));
    const { unmount } = render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Ninety Six A/ }));
    unmount();

    render(<App />);
    await screen.findByRole('navigation', { name: 'Sections' });
    expect(screen.queryByText('Follow a team to see its schedule, results, and updates.')).toBeNull();
  });
});

describe('what the page must not invent', () => {
  test('a game with no scheduled time shows no time at all', async () => {
    const snapshot = structuredClone(defaultSnapshot) as unknown as QbliveSnapshot;
    for (const game of snapshot.schedule) game.scheduledStart = null;
    for (const event of snapshot.timeline) event.scheduledStart = null;
    vi.stubGlobal('fetch', stubBackend(snapshot));
    await openFollowing();
    // Scoped to the next-event card rather than the whole page: a Director's own announcement text
    // may legitimately contain a time they typed, and that is their sentence, not an estimate.
    const next = await screen.findByLabelText('Next');
    expect(next.textContent).not.toMatch(/\d{1,2}:\d{2}/);
    expect(next.textContent).not.toMatch(/estimat|probably|expected|approx/i);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Schedule/ }));
    const schedule = await screen.findByRole('main');
    expect(schedule.textContent).not.toMatch(/estimat|probably|expected|approx/i);
  });

  test('live scores stay hidden when the tournament does not publish them', async () => {
    vi.stubGlobal('fetch', stubBackend(defaultSnapshot));
    await openFollowing();
    const main = await screen.findByRole('main');
    expect(main.textContent).toContain('Game in progress');
    expect(main.textContent).not.toContain('180');
  });

  test('live scores appear when the tournament does publish them', async () => {
    vi.stubGlobal('fetch', stubBackend(maximalSnapshot));
    await openFollowing();
    const main = await screen.findByRole('main');
    expect(main.textContent).toContain('180');
    expect(main.textContent).toContain('135');
  });

  test('announcement bodies are rendered as text, never as markup', async () => {
    const snapshot = structuredClone(defaultSnapshot) as unknown as QbliveSnapshot;
    snapshot.announcements = [
      {
        id: 'a1',
        title: 'Careful',
        body: '<img src=x onerror="window.__pwned = true"> <b>bold</b>',
        severity: 'information',
        publishedAt: '2026-09-05T14:00:00-04:00',
        updatedAt: null,
        expiresAt: null,
        audienceTeamIds: [],
      },
    ];
    vi.stubGlobal('fetch', stubBackend(snapshot));
    const user = await openFollowing();
    await user.click(screen.getByRole('button', { name: /Updates/ }));
    const article = await screen.findByRole('article');
    expect(article.querySelector('img')).toBeNull();
    expect(article.querySelector('b')).toBeNull();
    expect(article.textContent).toContain('<b>bold</b>');
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });
});

describe('staleness', () => {
  test('cached data is shown with its age, never as current', async () => {
    vi.stubGlobal('fetch', stubBackend(defaultSnapshot));
    const { unmount } = render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Ninety Six A/ }));
    await screen.findByRole('navigation', { name: 'Sections' });
    unmount();

    // Now the backend is gone. The page still works, and says how old what it shows is.
    vi.stubGlobal('fetch', stubBackend(defaultSnapshot, { fail: true }));
    render(<App />);
    const status = await screen.findAllByRole('status');
    expect(status.map((node) => node.textContent).join(' ')).toMatch(/Updated|Last updated/);
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('status')
          .map((node) => node.textContent)
          .join(' '),
      ).toMatch(/reconnecting/),
    );
  });

  test('a finished tournament says so', async () => {
    const snapshot = structuredClone(defaultSnapshot) as unknown as QbliveSnapshot;
    snapshot.final = true;
    snapshot.tournament.status = 'complete';
    vi.stubGlobal('fetch', stubBackend(snapshot));
    await openFollowing();
    await screen.findByText(/Final results\. This tournament is over\./);
  });
});

describe('dynamic tables', () => {
  test('renders a column kind it has never heard of', async () => {
    const snapshot = structuredClone(defaultSnapshot) as unknown as QbliveSnapshot;
    snapshot.standings[0].columns.push({ id: 'future', label: 'Zing', kind: 'quantum-flux' as never });
    for (const row of snapshot.standings[0].rows) row.cells.push({ value: 7, display: 'seven' });
    vi.stubGlobal('fetch', stubBackend(snapshot));
    const user = await openFollowing();
    await user.click(screen.getByRole('button', { name: /Standings/ }));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Zing')).toBeTruthy();
    expect(within(table).getAllByText('seven').length).toBeGreaterThan(0);
  });

  test('highlights the followed team without knowing what any column means', async () => {
    vi.stubGlobal('fetch', stubBackend(defaultSnapshot));
    const user = await openFollowing();
    await user.click(screen.getByRole('button', { name: /Standings/ }));
    const table = await screen.findByRole('table');
    const highlighted = table.querySelectorAll('tr.is-followed');
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0].textContent).toContain('Ninety Six A');
  });

  test('player statistics are absent entirely when the tournament does not publish players', async () => {
    vi.stubGlobal('fetch', stubBackend(defaultSnapshot));
    const user = await openFollowing();
    await user.click(screen.getByRole('button', { name: /Stats/ }));
    await screen.findByText('Team statistics');
    expect(screen.queryByText('Individual statistics')).toBeNull();
  });

  test('player statistics appear, and a chosen player is highlighted, when they are published', async () => {
    vi.stubGlobal('fetch', stubBackend(maximalSnapshot));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Ninety Six A/ }));
    await user.click(await screen.findByRole('button', { name: /Player 0-0/ }));
    await user.click(screen.getByRole('button', { name: /Stats/ }));
    await screen.findByText('Individual statistics');
    await waitFor(() => expect(document.querySelectorAll('tr.is-followed').length).toBeGreaterThan(0));
  });
});
