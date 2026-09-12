/**
 * What the Bridge page must say, and the confusion it must not create.
 *
 * # The editorial assertion is the point of this file
 *
 * Bridge sits next to Director in the header and on the same tournament computer in real life, so
 * the page's first failure mode is describing a second Director. The YellowFruit boundary — what it
 * reads, what it never writes, and who owns the standings — is asserted by name, because a softer
 * sentence here is a director trusting Bridge with a tournament file it was never meant to hold.
 *
 * # The structural assertion is the same one every page here carries
 *
 * `aboutPrerenderPlugin` renders this component to static HTML at build time, so it has to render
 * completely from nothing: no state, no effect, no observer, no browser. A component that grew a
 * `useEffect` to fill in half of itself would look right in a dev server and ship a half-empty page.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import Bridge from '../src/about/Bridge';

/**
 * An element's words with the JSX line breaks taken out.
 *
 * A sentence written across two source lines carries the indentation between them into `textContent`,
 * so asserting on the sentence without this passes or fails on where Prettier happened to wrap it.
 */
function words(element: Element | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ');
}

describe('the Bridge page', () => {
  test('names the product and offers a download rather than a way in', () => {
    render(<Bridge />);

    expect(screen.getByText('QBSheet Bridge', { selector: '.about-hero .about-kicker' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Use QBSheet with YellowFruit' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Keep running the tournament in YellowFruit\. Bridge sends each room its game in QBSheet/,
      ),
    ).toBeInTheDocument();

    // The releases index rather than an installer file name: this repository publishes no stable
    // per-platform download URL, and a page cannot promise a link the project does not have.
    const download = screen.getAllByRole('link', { name: /^Download Bridge/ });
    expect(download).toHaveLength(2);
    for (const link of download) {
      expect(link).toHaveAttribute('href', 'https://github.com/gbyo/qbsheet/releases');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link.textContent).toContain('(opens in a new tab)');
    }

    const guide = screen.getAllByRole('link', { name: /^Read the setup guide/ });
    expect(guide).toHaveLength(2);
    for (const link of guide) {
      expect(link).toHaveAttribute(
        'href',
        'https://github.com/gbyo/qbsheet/blob/main/apps/qbbridge/README.md',
      );
      expect(link).toHaveAttribute('target', '_blank');
    }
  });

  test('never offers a way to run Bridge from this website', () => {
    const { container } = render(<Bridge />);

    expect(screen.queryByRole('link', { name: /Open Bridge/ })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();

    // "Open QBSheet" is right on a page about the scorer and wrong here: Bridge is not the
    // scorer, and offering it as the runner-up action invites exactly the confusion this page
    // exists to remove.
    expect(screen.queryByRole('link', { name: 'Open QBSheet' })).toBeNull();
    expect(container.textContent).not.toContain('Open QBSheet');
  });

  test('shows the trip a game takes, with YellowFruit at both ends', () => {
    const { container } = render(<Bridge />);

    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'YellowFruit runs the tournament. Bridge carries the rounds.',
      }),
    ).toBeInTheDocument();

    const pipeline = container.querySelector('.about-pipeline');
    expect(pipeline).not.toBeNull();
    const stops = Array.from(pipeline?.querySelectorAll('.about-pipeline-name') ?? []).map((stop) =>
      (stop.textContent ?? '').trim(),
    );
    expect(stops).toEqual(['YellowFruit', 'Bridge', 'Scorer', 'Bridge', 'YellowFruit']);

    // The arrows are decoration on a list that already carries the order, so they stay out of the
    // accessible name computation.
    for (const arrow of pipeline?.querySelectorAll('.about-pipeline-arrow') ?? []) {
      expect(arrow).toHaveAttribute('aria-hidden', 'true');
    }

    // QBTCP, QBJ and QBBridge are defined where they are used, not assumed from elsewhere.
    expect(words(pipeline?.parentElement ?? null)).toContain('the open document format for game data');
    expect(words(pipeline?.parentElement ?? null)).toContain('the open protocol between tournament control');
    expect(container.textContent).toContain('called QBBridge in the repository');
  });

  test('states what stays in YellowFruit without claiming it for Bridge', () => {
    const { container } = render(<Bridge />);

    expect(screen.getByRole('heading', { level: 2, name: 'What stays in YellowFruit' })).toBeInTheDocument();
    const scope = container.querySelector('.about-split');
    for (const term of [
      'Tournament setup',
      'Teams and rosters',
      'Rounds and phases',
      'Standings and statistics',
      'The tournament file',
    ]) {
      expect(within(scope as HTMLElement).getByText(term, { selector: 'dt' })).toBeInTheDocument();
    }
    expect(words(scope)).toContain('Bridge does not predict advancement and generates no schedule');
    expect(words(scope)).toContain('Bridge reads the .yft and never writes to it');

    // Bridge keeps nothing of its own. Saying otherwise would describe Director.
    expect(container.textContent).not.toContain('Bridge runs the tournament');
  });

  test('explains a round as four ordered steps in the application’s own words', () => {
    const { container } = render(<Bridge />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Load, assign, score, import' }),
    ).toBeInTheDocument();
    for (const name of ['Load', 'Assign', 'Score', 'Import']) {
      expect(screen.getByRole('heading', { level: 3, name })).toBeInTheDocument();
    }
    const flow = container.querySelectorAll('.about-flow')[1];
    expect(flow?.querySelectorAll('.about-stages > li')).toHaveLength(4);

    expect(words(flow)).toContain('Open YellowFruit File');
    expect(words(flow)).toContain('can be entered the night before');
    expect(words(flow)).toContain('Publish Round');
    expect(words(flow)).toContain('eight-digit pairing code');
    expect(words(flow)).toContain('Save New Results');
    expect(words(flow)).toContain('Import Games Only');
    expect(words(flow)).toContain('Mark imported');
    expect(words(flow)).toContain('local confirmation that YellowFruit handled the files');
  });

  test('tells scorekeepers their pairing survives the round change', () => {
    const { container } = render(<Bridge />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Scorekeepers use normal QBSheet' }),
    ).toBeInTheDocument();
    expect(words(container)).toContain('so nobody recreates the tournament in a room');
    expect(words(container)).toContain('still paired in the last round');

    const card = container.querySelector('.about-room-card');
    expect(card).not.toBeNull();
    for (const term of ['Room', 'Pairing', 'Assignment']) {
      expect(within(card as HTMLElement).getByText(term, { selector: 'dt' })).toBeInTheDocument();
    }
  });

  test('draws the file boundary exactly where the implementation draws it', () => {
    const { container } = render(<Bridge />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Bridge reads the file. YellowFruit keeps it.' }),
    ).toBeInTheDocument();
    expect(words(container)).toContain('never writes to it');
    expect(words(container)).toContain('That is a reread, not synchronization');
    expect(words(container)).toContain('one .qbj file per game, written out exactly as the room sent it');
    expect(words(container)).toContain('Planned pairings are never written back');
    expect(words(container)).toContain('mark the saved result imported as a local handoff reminder');
    expect(words(container)).toContain(
      'does not inspect YellowFruit to verify that the game was accepted or applied to standings',
    );
    expect(words(container)).not.toContain('never claims a result was imported');
  });

  test('separates Bridge from Director in two sentences', () => {
    render(<Bridge />);

    expect(screen.getByRole('heading', { level: 2, name: 'Which one runs the event' })).toBeInTheDocument();
    expect(
      screen.getByText(/the tournament already runs in YellowFruit and the rooms should score on QBSheet/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /the tournament should run in QBSheet’s own tournament-control application instead/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'About Director' })).toHaveAttribute('href', '../director/');
  });

  test('lists the requirements, including the relay this project does not run', () => {
    const { container } = render(<Bridge />);

    expect(screen.getByRole('heading', { level: 2, name: 'Requirements' })).toBeInTheDocument();
    const requirements = container.querySelector('.about-requirements');
    for (const term of ['QBSheet Bridge', 'A YellowFruit file', 'QBSheet in each room', 'The QBTCP relay']) {
      expect(within(requirements as HTMLElement).getByText(term, { selector: 'dt' })).toBeInTheDocument();
    }
    expect(words(requirements)).toContain('QBSheet operates no server');
    expect(screen.getByRole('link', { name: 'Read the relay deployment notes' })).toHaveAttribute(
      'href',
      'https://github.com/gbyo/qbsheet/blob/main/docs/QBTCP-RELAY-DEPLOY.md',
    );
  });

  test('closes without selling anything', () => {
    render(<Bridge />);

    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Keep running the tournament in YellowFruit. Use QBSheet in the rooms.',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Get started today/ })).toBeNull();
  });

  test('resolves the chrome from one directory below the product page', () => {
    const { container } = render(<Bridge />);

    expect(container.querySelector('.about-brand')).toHaveAttribute('href', '../');

    const nav = container.querySelector('.about-nav') as HTMLElement;
    expect(within(nav).getAllByRole('link')).toHaveLength(5);
    expect(within(nav).getByRole('link', { name: 'Scorer' })).toHaveAttribute('href', '../../');
    expect(within(nav).getByRole('link', { name: 'Director' })).toHaveAttribute('href', '../director/');
    // A page names itself as `./`, and `aria-current` belongs on that link and nowhere else.
    const self = within(nav).getByRole('link', { name: 'Bridge' });
    expect(self).toHaveAttribute('href', './');
    expect(self).toHaveAttribute('aria-current', 'page');
    const qblive = within(nav).getByRole('link', { name: 'QBLive' });
    expect(qblive).toHaveAttribute('href', '../qblive/');
    expect(qblive).not.toHaveAttribute('aria-current');

    const footer = container.querySelector('.about-footer nav') as HTMLElement;
    expect(within(footer).getByRole('link', { name: 'About' })).toHaveAttribute('href', '../');
    // The products are the header's business. Repeating them beside `FAQ` and `Privacy` would
    // double every product link on the site and file them as pages of writing.
    expect(within(footer).queryByRole('link', { name: 'Bridge' })).toBeNull();
  });

  test('assumes no quiz bowl format', () => {
    const { container } = render(<Bridge />);
    const said = words(container).toLowerCase();

    // Bridge carries the format YellowFruit described. It does not have one, and neither may its page.
    for (const assumption of ['naqt', 'acf', 'power', 'neg', 'bounce', 'four players a side']) {
      expect(said).not.toContain(assumption);
    }
  });

  test('makes no claim about who uses Bridge or how well it works', () => {
    const { container } = render(<Bridge />);
    const said = words(container).toLowerCase();

    for (const unverifiable of [
      'most rooms',
      'many events',
      'trusted by',
      'thousands',
      'seamless',
      'effortless',
      'powerful',
      'revolutionary',
    ]) {
      expect(said).not.toContain(unverifiable);
    }
  });
});
