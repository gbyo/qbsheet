/**
 * What the QBLive page must say, and the claims it must not drift into.
 *
 * # Why the copy is worth a test
 *
 * QBLive publishes school tournaments to anybody with a link, and three of the protocol's rules
 * exist because getting them wrong hurts somebody: nothing publishes ahead of its round, player
 * names are off until a director turns them on, and no start time is ever estimated. A marketing
 * page is exactly where those get softened into something friendlier, so they are asserted by name
 * rather than left to review.
 *
 * The other risk is the product model. QBLive shows a tournament; Director runs it. A page that
 * implies QBLive holds a schedule or accepts a result has described a different, worse system.
 *
 * # And the structural one, as on every page here
 *
 * `aboutPrerenderPlugin` renders this to static HTML at build time, so it has to render completely
 * with no state, no effect and no browser.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import QbLive from '../src/about/QbLive';

describe('the QBLive page', () => {
  test('introduces QBLive as the public, read-only view', () => {
    render(<QbLive />);

    // The hero kicker specifically: the word is also the header entry, a term in the product-model
    // list, and the closing action.
    expect(screen.getByText('QBLive', { selector: '.about-hero .about-kicker' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Follow the tournament as it happens.' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/the public view of a quiz bowl tournament.*and it is read-only/s),
    ).toBeInTheDocument();
  });

  test('sends the reader to the real application, which is somebody else’s origin', () => {
    render(<QbLive />);

    const open = screen.getAllByRole('link', { name: /^Open QBLive/ });
    expect(open).toHaveLength(2);
    for (const link of open) {
      expect(link).toHaveAttribute('href', 'https://live.qbsheet.com/');
      // It leaves this site, so it is marked as leaving it: new tab, no opener, and the behaviour
      // announced in words for anybody who cannot see the arrow.
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(link.textContent).toContain('(opens in a new tab)');
    }
  });

  test('states the product model without giving QBLive any control', () => {
    const { container } = render(<QbLive />);

    expect(screen.getByRole('heading', { level: 2, name: 'Where QBLive fits' })).toBeInTheDocument();
    expect(
      screen.getByText(
        /Director runs the tournament\. QBSheet scores the games\. QBLive lets everyone follow along\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/It is a reader, not a participant in running the event\./)).toBeInTheDocument();
    expect(
      screen.getByText(/Everything QBLive shows was published from tournament control\./),
    ).toBeInTheDocument();

    // Relative links to the sibling pages, one directory across.
    expect(screen.getByRole('link', { name: 'About Director' })).toHaveAttribute('href', '../director/');
    expect(screen.getByRole('link', { name: 'What scoring a game involves' })).toHaveAttribute(
      'href',
      '../scoring/',
    );
    expect(container.textContent).not.toContain('QBLive runs');
  });

  test('lists the five screens the application actually has', () => {
    render(<QbLive />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Five screens, one tournament' }),
    ).toBeInTheDocument();
    for (const term of ['Home', 'Schedule', 'Standings', 'Stats', 'Updates']) {
      expect(screen.getByText(term, { selector: 'dt' })).toBeInTheDocument();
    }
  });

  test('keeps every protocol promise that protects a participant', () => {
    render(<QbLive />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Public, and careful about it' }),
    ).toBeInTheDocument();
    for (const title of [
      'Read-only, and unauthenticated',
      'Nothing publishes ahead of its round',
      'Player names are a separate decision',
      'No invented times',
    ]) {
      expect(screen.getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
    }

    // The three sentences that would be the easiest to soften, and the most harmful to soften.
    expect(
      screen.getByText(/A game becomes public when its round is released or closed\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/off unless the tournament turns them on/)).toBeInTheDocument();
    expect(screen.getByText(/no estimated, projected, or inferred time/)).toBeInTheDocument();
  });

  test('is honest about where a tournament’s data lives and how it is reached', () => {
    render(<QbLive />);

    expect(screen.getByRole('heading', { level: 2, name: 'Opening a tournament' })).toBeInTheDocument();
    // Opening the client with no tournament link shows no tournament, so the page says where the
    // link comes from rather than implying the front door is a tournament.
    expect(screen.getByText(/A tournament is reached through the link it published/)).toBeInTheDocument();
    expect(screen.getByText(/never pass through anything QBSheet operates/)).toBeInTheDocument();
  });

  test('resolves the chrome from one directory below the product page', () => {
    const { container } = render(<QbLive />);

    expect(container.querySelector('.about-brand')).toHaveAttribute('href', '../');

    const nav = container.querySelector('.about-nav') as HTMLElement;
    expect(within(nav).getAllByRole('link')).toHaveLength(4);
    expect(within(nav).getByRole('link', { name: 'Scorer' })).toHaveAttribute('href', '../../');
    expect(within(nav).getByRole('link', { name: 'Director' })).toHaveAttribute('href', '../director/');
    const self = within(nav).getByRole('link', { name: 'QBLive' });
    expect(self).toHaveAttribute('href', './');
    expect(self).toHaveAttribute('aria-current', 'page');
    // The header entry is a page on this site now. The external application is reached from the
    // hero and the closing action, where the mark and the new tab say what it is.
    expect(self).not.toHaveAttribute('target');

    const footer = container.querySelector('.about-footer nav') as HTMLElement;
    expect(within(footer).getByRole('link', { name: 'About' })).toHaveAttribute('href', '../');
    expect(within(footer).queryByRole('link', { name: 'QBLive' })).toBeNull();
  });
});
