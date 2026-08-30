/**
 * What the questions page must answer, and the two ways an answer here goes wrong.
 *
 * The structural claim is shared with every page here: the component is prerendered, so it has to
 * render completely from nothing.
 *
 * The first failure is an answer that is more comfortable than the truth. Durable storage is the clear
 * case: a restricted profile, private browsing and an exhausted quota are ordinary states in
 * `GameDatabase`, and the accurate answer is that QBSheet reports the failure, not that it cannot
 * happen. The format answer has the opposite risk — a scoresheet that defines no format of its own
 * reads as a limited one unless it says so plainly.
 *
 * The second is a claim this repository cannot support. An earlier draft of this page asserted that
 * Chromebooks and iPads are "what most rooms use" and that "a lot of events" self-host. Neither is
 * knowable from the source, and both are asserted absent by the last test.
 *
 * The format-assumption guard constrains this page hardest of any, because it is the page answering
 * "does it support our format" — the question that most invites a list of format names.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import Faq from '../src/about/Faq';

/** An element's words with the JSX line breaks taken out. See `TournamentsPage.test.tsx`. */
function words(element: Element | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ');
}

describe('the questions page', () => {
  test('groups the questions by subject', () => {
    const { container } = render(<Faq />);

    expect(screen.getByRole('heading', { level: 1, name: 'Frequently asked questions' })).toBeInTheDocument();

    const headings = [...container.querySelectorAll('.about-faq h2')].map((heading) => heading.textContent);
    expect(headings).toEqual([
      'Devices and browsers',
      'Formats and scoring',
      'Files and storage',
      'Licensing and support',
    ]);

    // Each question is a term in a definition list rather than a heading, so the heading outline is
    // the four groups rather than sixteen questions.
    expect(container.querySelectorAll('.about-faq-list > div')).toHaveLength(16);
  });

  test('answers the device questions within what is knowable', () => {
    const { container } = render(<Faq />);

    const said = words(container.querySelector('.about-faq'));
    expect(said).toContain('Nothing. QBSheet runs in a browser');
    // A phone is described by the constraint rather than sold as supported or dismissed.
    expect(said).toContain('The scoresheet is dense on a phone-sized screen');
    // The device check is what makes a room verifiable in advance, so it is named.
    expect(said).toContain('device check');
  });

  test('states that QBSheet defines no format of its own', () => {
    render(<Faq />);

    expect(screen.getByRole('heading', { level: 2, name: 'Formats and scoring' })).toBeInTheDocument();
    expect(screen.getByText('Does QBSheet support our format?', { selector: 'dt' })).toBeInTheDocument();
    expect(screen.getByText(/QBSheet defines no format of its own/)).toBeInTheDocument();
    expect(screen.getByText(/does not infer rules from the\s+name of a rule set/)).toBeInTheDocument();
  });

  test('states that storage can fail', () => {
    const { container } = render(<Faq />);

    expect(screen.getByText('What if the browser cannot store data?', { selector: 'dt' })).toBeInTheDocument();

    // The comfortable version of this answer would be that it cannot happen.
    const said = words(container);
    expect(said).toContain('A restricted profile, private browsing, or an exhausted storage quota');
    expect(said).toContain('the scoresheet states that local recovery is unavailable');
  });

  test('states the cost and the licence', () => {
    const { container } = render(<Faq />);

    expect(screen.getByRole('heading', { level: 2, name: 'Licensing and support' })).toBeInTheDocument();
    const said = words(container);
    expect(said).toContain('Nothing. QBSheet is free software under the GNU AGPL, version 3 or later');
    expect(said).toContain('no per-room charge');
    // And it does not claim to be the tournament software, which this page is the last chance to
    // prevent a reader assuming.
    expect(said).toContain('No. QBSheet scores one room');
  });

  test('links out from two directories deep', () => {
    const { container } = render(<Faq />);

    for (const link of screen.getAllByRole('link', { name: 'Open QBSheet' })) {
      expect(link).toHaveAttribute('href', '../../');
    }
    // The wordmark returns to this site's front page, which is the product page one level up,
    // not the scorer two levels up. "Open QBSheet" is the way into the application.
    expect(container.querySelector('.about-brand')).toHaveAttribute('href', '../');
    for (const link of screen.getAllByRole('link', { name: 'About' })) {
      expect(link).toHaveAttribute('href', '../');
    }
    expect(screen.getByRole('link', { name: 'How connected rooms work' })).toHaveAttribute('href', '../tournaments/');
    expect(screen.getByRole('link', { name: 'What scoring a game involves' })).toHaveAttribute('href', '../scoring/');
    expect(screen.getByRole('link', { name: 'What is stored and transmitted' })).toHaveAttribute('href', '../privacy/');
    expect(screen.getByRole('link', { name: 'Self-hosting guide' })).toHaveAttribute('href', '../self-host/');

    for (const region of ['.about-nav', '.about-footer nav']) {
      const nav = container.querySelector(region);
      const self = within(nav as HTMLElement).getByRole('link', { name: 'FAQ' });
      expect(self).toHaveAttribute('href', './');
      expect(self).toHaveAttribute('aria-current', 'page');
    }
  });

  test('assumes no quiz bowl format', () => {
    const { container } = render(<Faq />);
    const said = words(container).toLowerCase();

    // Hardest here of anywhere: this page answers "does it support our format", which is exactly the
    // question that tempts a list of format names. A list is what would narrow the answer.
    for (const assumption of ['naqt', 'acf', 'power', 'neg', 'bounce', 'four players a side', 'between tossups']) {
      expect(said).not.toContain(assumption);
    }
  });

  test('makes no claim about who uses QBSheet or on what', () => {
    const { container } = render(<Faq />);
    const said = words(container).toLowerCase();

    // Both of these were in an earlier draft and neither is knowable from this repository.
    for (const unverifiable of ['most rooms', 'a lot of events', 'many events', 'trusted by', 'thousands']) {
      expect(said).not.toContain(unverifiable);
    }
  });
});
