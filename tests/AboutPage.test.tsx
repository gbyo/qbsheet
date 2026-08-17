/**
 * What the product page must still say, and what it must never start saying.
 *
 * Two different claims are protected here and they fail for different reasons.
 *
 * The first is structural: the page is prerendered to static HTML by `aboutPrerenderPlugin`, so the
 * component has to render completely from nothing — no state, no effects, no observer, no browser. A
 * component that grew a `useEffect` to fill in half its content would still look right in a dev server
 * and would ship a half-empty page. Rendering it here with no environment at all is what catches that.
 *
 * The second is editorial, and it is the one worth the file. QBSheet is a generic scoresheet, and the
 * way a generic scoresheet quietly stops being one is a marketing page that assumes a format: powers,
 * negs, a bonus shape, four players a side, substitutions between tossups, NAQT. `IScorekeeperFormat`
 * assumes none of them, and a tournament whose format this page silently excluded is a tournament that
 * reads it and leaves. So the assumptions are asserted absent by name.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import About from '../src/about/About';

describe('the product page', () => {
  test('keeps the hero exactly as it is', () => {
    render(<About />);

    expect(screen.getByRole('heading', { level: 1, name: 'The simpler way to keep score.' })).toBeInTheDocument();
    expect(screen.getByText(/QBSheet keeps quiz bowl scoring fast, flexible, and out of your way/)).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /QBSheet scoring a tied practice game between Ninety Six and Greenwood/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/The real QBSheet scoring interface/)).toBeInTheDocument();
  });

  test('explains the tournament workflow as three ordered stages', () => {
    render(<About />);

    expect(screen.getByRole('heading', { level: 2, name: 'Built around how you actually score' })).toBeInTheDocument();

    // The stage numerals are decoration next to the name, so the heading a screen reader reaches is the
    // stage itself. A numeral that stopped being `aria-hidden` would fail this by name.
    const stages = ['Start', 'Score', 'Finish'].map((name) =>
      screen.getByRole('heading', { level: 3, name }),
    );
    expect(stages).toHaveLength(3);

    expect(screen.getByText('Start with a game.')).toBeInTheDocument();
    expect(screen.getByText('Score the game.')).toBeInTheDocument();
    expect(screen.getByText('Keep the finished result.')).toBeInTheDocument();
  });

  test('ends the workflow section at the three stages', () => {
    const { container } = render(<About />);

    // The four assurances used to live in this section, and a reader arriving at them directly below
    // three numbered stages had to work out that they were not a fourth stage.
    const flow = container.querySelector('.about-flow');
    expect(flow).not.toBeNull();
    expect(flow?.querySelectorAll('.about-stages > li')).toHaveLength(3);
    expect(flow?.textContent).not.toContain('No internet required');
  });

  test('offers three ways in and keeps tournament control optional', () => {
    render(<About />);

    // A file, a server, and self-created games all have to be present. Tournament control is useful,
    // but a practice, scrimmage, or tryout has no assignment to receive and no result to send back.
    expect(
      screen.getByText(/Open a QBJ assignment, connect QBSheet to tournament control, or create a game yourself/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Connected games can be sent back to tournament control; any game can be downloaded as QBJ/)).toBeInTheDocument();
  });

  test('answers the four things a director asks in a section of their own', () => {
    const { container } = render(<About />);

    expect(screen.getByRole('heading', { level: 2, name: 'Made for tournament day' })).toBeInTheDocument();
    for (const title of ['No internet required', 'Less setup at the table', 'Your format, not ours', 'Recovery built in']) {
      expect(screen.getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
    }

    // The tint is the section break, and there is exactly one of it on the page.
    const bands = container.querySelectorAll('.about-band');
    expect(bands).toHaveLength(1);
    expect(bands[0].querySelector('.about-assurance-grid')).not.toBeNull();
  });

  test('explains the open-by-design promise and keeps its documentation links', () => {
    render(<About />);

    expect(screen.getByText('OPEN BY DESIGN')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: "Your games aren't locked into QBSheet." })).toBeInTheDocument();
    expect(
      screen.getByText(
        'QBSheet uses open formats and an open protocol, so tournament data can move between the scoresheet and compatible tournament software.',
      ),
    ).toBeInTheDocument();
    // Still a definition list, which is the presentation this section is kept for.
    for (const term of ['QBJ', 'QBTCP', 'Open source', 'Self-hosting']) {
      expect(screen.getByText(term, { selector: 'dt' })).toBeInTheDocument();
    }
    expect(screen.getByText(/Portable files for assignments, games, and results\./)).toBeInTheDocument();
    expect(screen.getByText(/Live communication with compatible tournament-control software\./)).toBeInTheDocument();
    expect(screen.getByText(/QBSheet is licensed under the GNU AGPL\./)).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Read the QBJ documentation' })).toHaveAttribute(
      'href',
      'https://github.com/gbyo/qbsheet/blob/main/docs/QBJ_ASSIGNMENT_PROFILE.md',
    );
    expect(screen.getByRole('link', { name: 'Read the protocol overview' })).toHaveAttribute(
      'href',
      'https://github.com/gbyo/qbsheet/blob/main/docs/QBTCP.md',
    );
    expect(screen.getByRole('link', { name: 'View the source on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/gbyo/qbsheet',
    );
    // Relative, because this page does not know which directory the deployment served it from.
    expect(screen.getByRole('link', { name: 'Read the self-hosting guide' })).toHaveAttribute(
      'href',
      './self-host/',
    );
  });

  test('offers self-hosting from both navigations', () => {
    const { container } = render(<About />);

    // Three ways to the page from here: the header, the footer, and the open-by-design list. The
    // first two are what make it reachable from anywhere on the page rather than only from the middle.
    for (const region of ['.about-nav', '.about-footer nav']) {
      const nav = container.querySelector(region);
      expect(within(nav as HTMLElement).getByRole('link', { name: 'Self-host' })).toHaveAttribute(
        'href',
        './self-host/',
      );
    }
  });

  test('keeps the closing call to action and both ways into the application', () => {
    render(<About />);

    expect(screen.getByRole('heading', { level: 2, name: 'Ready to score?' })).toBeInTheDocument();
    const open = screen.getAllByRole('link', { name: 'Open QBSheet' });
    expect(open).toHaveLength(3);
    for (const link of open) expect(link).toHaveAttribute('href', '../');

    const github = screen.getAllByRole('link', { name: /^View on GitHub/ });
    expect(github).toHaveLength(2);
    for (const link of github) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(link.textContent).toContain('(opens in a new tab)');
    }
  });

  test('assumes no quiz bowl format', () => {
    const { container } = render(<About />);
    const words = (container.textContent ?? '').toLowerCase();

    // Each of these would narrow the page to somebody else's tournament. Powers, negs and bounce-backs
    // are optional structures in `IScorekeeperFormat`; the active-player count is configurable; and
    // when substitutions are allowed is whatever the tournament's `IRoomProcedure` says it is.
    for (const assumption of ['naqt', 'acf', 'power', 'neg', 'bounce', 'four players a side', 'between tossups']) {
      expect(words).not.toContain(assumption);
    }
  });
});
