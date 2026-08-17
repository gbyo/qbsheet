/**
 * What the privacy page must state, including the two parts it would be easier to leave out.
 *
 * The structural claim is shared with every page here: the component is prerendered, so it has to
 * render completely from nothing.
 *
 * A privacy page fails in one direction — by being more comfortable than the truth — and there are two
 * places this one could.
 *
 * The first is the disclosure. A connected room sends the scorekeeper's name and an opaque per-device
 * identifier to the tournament server, and a page listing only absences would be incomplete about the
 * one case where data leaves the device. Both are asserted here, along with the fact that the
 * recipient is the reader's own server.
 *
 * The second is hosting. Serving a website means a server receives a request for it, and a page
 * claiming that nothing is collected without saying so would overreach on behalf of a host this
 * project does not control.
 *
 * The absences themselves are checkable against the source: no analytics, telemetry, or third-party
 * script exists in this repository, and the webfont is bundled from `@fontsource` rather than
 * requested from a CDN, so the claim that a loaded page issues no third-party request is a fact about
 * the build.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import Privacy from '../src/about/Privacy';

/** An element's words with the JSX line breaks taken out. See `TournamentsPage.test.tsx`. */
function words(element: Element | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ');
}

describe('the privacy page', () => {
  test('states what the page covers', () => {
    const { container } = render(<Privacy />);

    expect(screen.getByRole('heading', { level: 1, name: 'Privacy' })).toBeInTheDocument();
    const hero = words(container.querySelector('.about-hero'));
    expect(hero).toContain('no user accounts, no analytics, and no application server');
    expect(hero).toContain('what the software stores on a device and what a connected room transmits');
  });

  test('lists the absences, each checkable against the source', () => {
    const { container } = render(<Privacy />);

    expect(screen.getByRole('heading', { level: 2, name: 'Data not collected' })).toBeInTheDocument();
    for (const title of ['No accounts', 'No analytics', 'No application server', 'No cookies']) {
      expect(screen.getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
    }

    const bands = container.querySelectorAll('.about-band');
    expect(bands).toHaveLength(1);
    const said = words(bands[0] ?? null);
    // The webfont clause matters: a page fetching a font from a CDN would be issuing a third-party
    // request on every load while claiming it issued none.
    expect(said).toContain('the webfont is served with the site rather than from a CDN');
    expect(said).toContain('Standalone scoring makes no network requests');
  });

  test('states what is stored on the device and for how long', () => {
    const { container } = render(<Privacy />);

    expect(screen.getByRole('heading', { level: 2, name: 'Data stored on the device' })).toBeInTheDocument();
    const storage = container.querySelector('.about-storage');
    for (const term of ['Games in progress', 'Completed games', 'Settings', 'Removal']) {
      expect(within(storage as HTMLElement).getByText(term, { selector: 'dt' })).toBeInTheDocument();
    }

    // The retention windows are `completedGameRetentionMs` and `manualGameRetentionMs`.
    const said = words(storage);
    expect(said).toContain('Retained for seven days');
    expect(said).toContain('retained for thirty days');
    expect(said).toContain("Clearing the browser's data for the site removes the local copy from that browser");
    expect(said).toContain(
      'Connected tournament servers may retain data they have received under their operators’ policies',
    );
  });

  test('discloses what a connected room sends and who receives it', () => {
    const { container } = render(<Privacy />);

    expect(screen.getByRole('heading', { level: 2, name: 'Data sent by a connected room' })).toBeInTheDocument();

    const connected = words(container.querySelector('.about-connected'));
    // The disclosure. A page listing only absences would be incomplete here.
    expect(connected).toContain("The scorekeeper's name");
    expect(connected).toContain('an opaque per-device identifier');
    // The recipient, which is the reader's own server.
    expect(connected).toContain('That server is not run by this project');
    expect(connected).toContain('A room that is not connected transmits none of this');
    // The rule that makes an exported scoresheet safe to send on.
    expect(connected).toContain('are not written into QBJ documents, log lines, or error messages');
  });

  test('does not overreach about the web server that serves the site', () => {
    const { container } = render(<Privacy />);

    expect(screen.getByRole('heading', { level: 2, name: 'Requests to the web server' })).toBeInTheDocument();
    const hosting = words(container.querySelector('.about-hosting-note'));
    expect(hosting).toContain('web servers commonly log requests');
    expect(hosting).toContain('This applies to any deployment of QBSheet');
    expect(hosting).toContain('The requests occur when the site loads; scoring itself transmits nothing');
    expect(hosting).toContain('A self-hosted copy places those logs under your own control');
  });

  test('tells the reader how to check the claims', () => {
    const { container } = render(<Privacy />);

    expect(screen.getByRole('heading', { level: 2, name: 'Verifying this page' })).toBeInTheDocument();
    const verify = words(container.querySelector('.about-verify'));
    expect(verify).toContain('the single module that makes network requests at all');
    expect(verify).toContain('Report anything on this page that the code does not support');
    expect(screen.getByRole('link', { name: 'Read the source' })).toHaveAttribute(
      'href',
      'https://github.com/gbyo/qbsheet',
    );
  });

  test('links out from two directories deep', () => {
    const { container } = render(<Privacy />);

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

    // Privacy is a footer page rather than a header one, so it is marked current in the one
    // navigation that carries it.
    const footer = container.querySelector('.about-footer nav');
    const self = within(footer as HTMLElement).getByRole('link', { name: 'Privacy' });
    expect(self).toHaveAttribute('href', './');
    expect(self).toHaveAttribute('aria-current', 'page');
    expect(container.querySelector('.about-nav')?.textContent).not.toContain('Privacy');
  });

  test('assumes no quiz bowl format', () => {
    const { container } = render(<Privacy />);
    const said = words(container).toLowerCase();

    for (const assumption of ['naqt', 'acf', 'power', 'neg', 'bounce', 'four players a side', 'between tossups']) {
      expect(said).not.toContain(assumption);
    }
  });
});
