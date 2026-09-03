/**
 * What the Director page must say, and the one thing it must never offer.
 *
 * # The editorial assertion is the point of this file
 *
 * This page replaced a URL. The production site used to serve Director itself at `/director.html`,
 * and a tournament director who found it could plan a Saturday in something that could not run one:
 * the QBTCP listener rooms pair with is a native network service, and the tournament's storage is a
 * local database. So the page's first job is to say, unmissably, that Director is installed rather
 * than opened — and its first failure mode is a well-meaning edit that adds an "Open Director"
 * button, or points an action back at the entry that no longer exists. Both are asserted absent.
 *
 * # The structural assertion is the same one every page here carries
 *
 * `aboutPrerenderPlugin` renders this component to static HTML at build time, so it has to render
 * completely from nothing: no state, no effect, no observer, no browser. A component that grew a
 * `useEffect` to fill in half of itself would look right in a dev server and ship a half-empty page.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import Director from '../src/about/Director';

describe('the Director page', () => {
  test('names the product and offers a download rather than a way in', () => {
    render(<Director />);

    expect(screen.getByText('QBSheet Director')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Tournament control that stays with you.' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /the desktop application for setting up, running, reviewing, and publishing a quiz bowl tournament/,
      ),
    ).toBeInTheDocument();

    // The releases index rather than an installer file name: this repository publishes no stable
    // download URL, and a page cannot promise a link the project does not have.
    const download = screen.getAllByRole('link', { name: /^Download Director/ });
    expect(download).toHaveLength(2);
    for (const link of download) {
      expect(link).toHaveAttribute('href', 'https://github.com/gbyo/qbsheet/releases');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link.textContent).toContain('(opens in a new tab)');
    }
  });

  test('never offers a way to run Director from this website', () => {
    const { container } = render(<Director />);

    // The two spellings of the defect: a button that implies a hosted Director, and a link at the
    // entry the root build no longer emits.
    expect(screen.queryByRole('link', { name: /Open Director/ })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    for (const link of container.querySelectorAll('a')) {
      expect(link.getAttribute('href')).not.toContain('director.html');
    }

    // "Open QBSheet" is right on a page about the scorer and wrong here: Director is not the
    // scorer, and offering it as the runner-up action invites exactly the confusion this page
    // exists to remove.
    expect(screen.queryByRole('link', { name: 'Open QBSheet' })).toBeNull();
  });

  test('states that Director is a desktop application, in a section of its own', () => {
    const { container } = render(<Director />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Director is a desktop application.' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Install Director on the computer that will run the tournament/),
    ).toBeInTheDocument();
    expect(screen.getByText(/There is no web version and this website does not run it/)).toBeInTheDocument();

    // The tint is what marks it before anybody reads a word of it, and the notice is the first of
    // the two bands on the page.
    const bands = container.querySelectorAll('.about-band');
    expect(bands).toHaveLength(2);
    expect(bands[0].querySelector('#desktop-heading')).not.toBeNull();
  });

  test('explains the tournament as four ordered stages', () => {
    const { container } = render(<Director />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Set up, run, collect, publish' }),
    ).toBeInTheDocument();
    for (const name of ['Set up', 'Run', 'Collect', 'Publish']) {
      expect(screen.getByRole('heading', { level: 3, name })).toBeInTheDocument();
    }
    // The numerals are decoration beside the name, so the heading a screen reader reaches is the
    // stage itself.
    expect(container.querySelectorAll('.about-stages > li')).toHaveLength(4);
    for (const numeral of container.querySelectorAll('.about-stage-number')) {
      expect(numeral).toHaveAttribute('aria-hidden', 'true');
    }
  });

  test('answers what a director is deciding, and keeps the claims local', () => {
    render(<Director />);

    expect(screen.getByRole('heading', { level: 2, name: 'Local control, by design' })).toBeInTheDocument();
    for (const title of [
      'The tournament is on your computer',
      'Rounds do not need the internet',
      'Publishing cannot block the tournament',
      'A wrong result is correctable',
    ]) {
      expect(screen.getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
    }

    // Publishing is optional, and saying so is the difference between this and a product that
    // stops working when a venue's uplink does.
    expect(
      screen.getByText(
        /never required for scoring, scheduling, result acceptance, advancement, statistics, or recovery/,
      ),
    ).toBeInTheDocument();
  });

  test('places the three products and links to the other two pages', () => {
    render(<Director />);

    expect(screen.getByRole('heading', { level: 2, name: 'One system, three parts' })).toBeInTheDocument();
    expect(
      screen.getByText(
        /Director runs the tournament\. QBSheet scores the games\. QBLive lets everyone follow along\./,
      ),
    ).toBeInTheDocument();
    // Relative and one directory across, because the deployment owns the directory this page sits in.
    expect(screen.getByRole('link', { name: 'What QBLive shows' })).toHaveAttribute('href', '../qblive/');
    expect(screen.getByRole('link', { name: 'QBSheet for tournaments' })).toHaveAttribute(
      'href',
      '../tournaments/',
    );
  });

  test('resolves the chrome from one directory below the product page', () => {
    const { container } = render(<Director />);

    expect(container.querySelector('.about-brand')).toHaveAttribute('href', '../');

    const nav = container.querySelector('.about-nav') as HTMLElement;
    expect(within(nav).getAllByRole('link')).toHaveLength(4);
    expect(within(nav).getByRole('link', { name: 'Scorer' })).toHaveAttribute('href', '../../');
    // A page names itself as `./`, and `aria-current` belongs on that link and nowhere else.
    const self = within(nav).getByRole('link', { name: 'Director' });
    expect(self).toHaveAttribute('href', './');
    expect(self).toHaveAttribute('aria-current', 'page');
    const qblive = within(nav).getByRole('link', { name: 'QBLive' });
    expect(qblive).toHaveAttribute('href', '../qblive/');
    expect(qblive).not.toHaveAttribute('aria-current');

    const footer = container.querySelector('.about-footer nav') as HTMLElement;
    expect(within(footer).getByRole('link', { name: 'About' })).toHaveAttribute('href', '../');
    expect(within(footer).getByRole('link', { name: 'FAQ' })).toHaveAttribute('href', '../faq/');
    // The products are the header's business. Repeating them beside `FAQ` and `Privacy` would
    // double every product link on the site and file them as pages of writing.
    expect(within(footer).queryByRole('link', { name: 'Director' })).toBeNull();
    expect(within(footer).queryByRole('link', { name: 'QBLive' })).toBeNull();
  });

  test('assumes no quiz bowl format', () => {
    const { container } = render(<Director />);
    const words = (container.textContent ?? '').toLowerCase();

    // Director configures a format. It does not have one, and neither may its page.
    for (const assumption of ['naqt', 'acf', 'power', 'neg', 'bounce', 'four players a side']) {
      expect(words).not.toContain(assumption);
    }
  });
});
