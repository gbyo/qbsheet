/**
 * What the tournaments page must keep stating, and the claims it must not overstate.
 *
 * The structural claim is shared with every page here: `aboutPrerenderPlugin` renders the component to
 * static HTML, so it has to render completely from nothing. A `useEffect` filling in half of it would
 * look right in a dev server and ship a half-empty document.
 *
 * The documentation claims are specific to this reader. A director planning a schedule around QBSheet
 * can be misled in two ways. They can be left believing QBSheet replaces their tournament software, so
 * the division of responsibility and the requirement to be running QBTCP software of their own are
 * both asserted as text on the page. And they can be promised resilience the software does not have:
 * every statement in the failure section corresponds to a MUST in `docs/QBTCP.md`, so each is pinned
 * individually here.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import Tournaments from '../src/about/Tournaments';

/**
 * An element's words with the JSX line breaks taken out.
 *
 * A sentence written across two source lines carries the indentation between them into `textContent`,
 * so asserting on the sentence without this passes or fails on where Prettier happened to wrap it.
 */
function words(element: Element | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ');
}

describe('the tournaments page', () => {
  test('states what the page is about without selling it', () => {
    const { container } = render(<Tournaments />);

    expect(screen.getByRole('heading', { level: 1, name: 'QBSheet for tournaments' })).toBeInTheDocument();
    expect(words(container.querySelector('.about-hero'))).toContain(
      'QBSheet connects to tournament-control software over QBTCP',
    );
    expect(words(container.querySelector('.about-hero'))).toContain(
      'continue scoring when the server is unreachable, and return results as QBJ',
    );
  });

  test('states the scope, including the software the director has to run', () => {
    const { container } = render(<Tournaments />);

    expect(screen.getByRole('heading', { level: 2, name: 'QBSheet and tournament control' })).toBeInTheDocument();

    const scope = container.querySelector('.about-split');
    for (const term of ['Tournament control', 'QBSheet', 'QBTCP', 'QBJ']) {
      expect(within(scope as HTMLElement).getByText(term, { selector: 'dt' })).toBeInTheDocument();
    }
    // A director who reads this page and installs only QBSheet has been failed by it, so the
    // requirement is stated rather than implied.
    expect(words(scope)).toContain(
      'Connected scoring requires tournament-control software that implements QBTCP',
    );
    expect(within(scope as HTMLElement).getByText(/Owns the schedule/)).toBeInTheDocument();
  });

  test('documents the round as four ordered steps', () => {
    const { container } = render(<Tournaments />);

    expect(screen.getByRole('heading', { level: 2, name: 'A connected round' })).toBeInTheDocument();

    // Four rather than the product page's three: a connected round has a step before scoring.
    for (const name of ['Pair', 'Receive', 'Score', 'Return']) {
      expect(screen.getByRole('heading', { level: 3, name })).toBeInTheDocument();
    }
    const flow = container.querySelector('.about-flow');
    expect(flow?.querySelectorAll('.about-stages > li')).toHaveLength(4);

    // Persisting the assignment before scoring depends on a further network call is the durability
    // requirement the rest of the page rests on.
    expect(words(flow)).toContain('stores it on the device before scoring depends on any further network call');
    // And a retry is deduplicated rather than filed twice, which is the result-identity rule.
    expect(words(flow)).toContain('identified as the same result rather than recorded as a second game');
  });

  test('documents the failure handling without overstating any of it', () => {
    const { container } = render(<Tournaments />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Connection failures' }),
    ).toBeInTheDocument();
    for (const title of [
      'Network loss during a round',
      'A second device on the same game',
      'The server rejects the room',
      'A result is not accepted',
    ]) {
      expect(screen.getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
    }

    const bands = container.querySelectorAll('.about-band');
    expect(bands).toHaveLength(1);
    const said = words(bands[0] ?? null);
    // Each of these is a documented protocol obligation rather than a hope.
    expect(said).toContain('Snapshots resume when the connection returns');
    expect(said).toContain('A takeover is started by a person rather than resolved automatically between devices');
    expect(said).toContain('does not unmount the scorer or discard scored work');
    expect(said).toContain('Acceptance by the server is not a reason for a room to delete its local copy');
  });

  test('lists the requirements, including a server this project does not provide', () => {
    const { container } = render(<Tournaments />);

    expect(screen.getByRole('heading', { level: 2, name: 'Requirements' })).toBeInTheDocument();
    const requirements = container.querySelector('.about-requirements');
    for (const term of ['Tournament-control software', 'A browser per room', 'A secure origin', 'Pairing codes']) {
      expect(within(requirements as HTMLElement).getByText(term, { selector: 'dt' })).toBeInTheDocument();
    }
    // The two that would otherwise strand somebody.
    expect(words(requirements)).toContain('QBSheet connects to the server you run');
    expect(words(requirements)).toContain('browsers install only on a secure origin');
  });

  test('keeps tournament control optional on the page that documents it', () => {
    const { container } = render(<Tournaments />);

    // This is the page most likely to imply a server is required, so the alternative is a section
    // rather than a clause.
    expect(screen.getByRole('heading', { level: 2, name: 'Scoring without a connection' })).toBeInTheDocument();
    const fallback = container.querySelector('.about-fallback');
    expect(words(fallback)).toContain('Connected scoring is one of three ways to start a game');
    expect(words(fallback)).toContain('open a QBJ file or enter the teams, players, and scoring rules directly');
  });

  test('links out from two directories deep', () => {
    const { container } = render(<Tournaments />);

    // Every path is written from `about/tournaments/`, so the scorer is two levels up and the sibling
    // pages are one. A page deployed inside a repository subpath has nothing else to go on.
    for (const link of screen.getAllByRole('link', { name: 'Open QBSheet' })) {
      expect(link).toHaveAttribute('href', '../../');
    }
    // The wordmark returns to this site's front page, which is the product page one level up,
    // not the scorer two levels up. "Open QBSheet" is the way into the application.
    expect(container.querySelector('.about-brand')).toHaveAttribute('href', '../');
    for (const link of screen.getAllByRole('link', { name: 'About' })) {
      expect(link).toHaveAttribute('href', '../');
    }
    expect(screen.getByRole('link', { name: 'Self-hosting guide' })).toHaveAttribute('href', '../self-host/');
    expect(screen.getByRole('link', { name: 'What scoring a game involves' })).toHaveAttribute(
      'href',
      '../scoring/',
    );
    expect(screen.getByRole('link', { name: 'Read the specification' })).toHaveAttribute(
      'href',
      'https://github.com/gbyo/qbsheet/blob/main/docs/QBTCP.md',
    );

    for (const region of ['.about-nav', '.about-footer nav']) {
      const nav = container.querySelector(region);
      const self = within(nav as HTMLElement).getByRole('link', { name: 'Tournaments' });
      expect(self).toHaveAttribute('href', './');
      expect(self).toHaveAttribute('aria-current', 'page');
    }
  });

  /**
   * The shared chrome, asserted once rather than on all six pages.
   *
   * `PageChrome` renders the header and footer for every page here, so its behaviour is a property of
   * the module and not of this page. It is checked from a page that is not the product page, because
   * the depth-dependent halves — the wordmark's `../` — are the ones that go wrong.
   */
  test('marks the links that leave the site, and lands the wordmark on this site', () => {
    const { container } = render(<Tournaments />);

    // The wordmark is the way back to the front page of the site, not into the application.
    expect(container.querySelector('.about-brand')).toHaveAttribute('href', '../');

    for (const region of ['.about-nav', '.about-footer nav']) {
      const github = within(container.querySelector(region) as HTMLElement).getByRole('link', {
        name: /^GitHub/,
      });
      expect(github).toHaveAttribute('href', 'https://github.com/gbyo/qbsheet');
      expect(github).toHaveAttribute('target', '_blank');
      // Without this a new tab holds a handle on this one through `window.opener`.
      expect(github).toHaveAttribute('rel', 'noopener noreferrer');
      // The arrow is decoration, so the behaviour is announced in words as well. A screen reader
      // saying "graphic" after the link text would tell nobody anything.
      expect(github.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(github.textContent).toContain('(opens in a new tab)');
    }

    // A page link is not an external one, and must not have grown either attribute.
    const selfHost = within(container.querySelector('.about-nav') as HTMLElement).getByRole('link', {
      name: 'Self-host',
    });
    expect(selfHost).not.toHaveAttribute('target');
    expect(selfHost).not.toHaveAttribute('rel');
  });

  test('assumes no quiz bowl format', () => {
    const { container } = render(<Tournaments />);
    const said = words(container).toLowerCase();

    // The same editorial floor as every other page: nothing here may narrow QBSheet to one
    // tournament's rules.
    for (const assumption of ['naqt', 'acf', 'power', 'neg', 'bounce', 'four players a side', 'between tossups']) {
      expect(said).not.toContain(assumption);
    }
  });

  test('makes no claim about who uses QBSheet or on what', () => {
    const { container } = render(<Tournaments />);
    const said = words(container).toLowerCase();

    // Adoption and hardware claims are not knowable from this repository, and a marketing claim on a
    // documentation page is still a claim. An earlier draft of this page asserted both.
    for (const unverifiable of ['most rooms', 'a lot of events', 'many events', 'trusted by', 'thousands']) {
      expect(said).not.toContain(unverifiable);
    }
  });
});
