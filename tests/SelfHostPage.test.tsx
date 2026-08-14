/**
 * What the self-hosting page must say, and the two ways it could quietly become wrong.
 *
 * The structural claim is the same one `AboutPage.test.tsx` protects: the page is prerendered by
 * `aboutPrerenderPlugin`, so the component has to render completely from nothing. A `useEffect` that
 * filled in half of it would look correct in a dev server and ship a half-empty document.
 *
 * The second claim is that this page tells the truth about what hosting QBSheet involves, and it has
 * two specific failure modes. Promising offline scoring without saying that a service worker needs a
 * secure origin would strand the reader who self-hosted *for* offline scoring. And stating the AGPL
 * without its network clause, or stating that clause as though it applied to an unmodified build,
 * would be wrong in the direction that costs somebody something. Both are asserted by name.
 *
 * The links out are also fixed here. A page whose paths are one `../` short is a page that 404s only
 * once it is deployed a directory deeper than the dev server put it.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import SelfHost from '../src/about/SelfHost';

describe('the self-hosting page', () => {
  test('leads with what is actually being hosted', () => {
    render(<SelfHost />);

    expect(screen.getByRole('heading', { level: 1, name: 'Host QBSheet yourself' })).toBeInTheDocument();
    expect(
      screen.getByText(/QBSheet builds into a folder of static files/),
    ).toBeInTheDocument();
    // No application server and no accounts are the two things the reader is deciding about.
    expect(screen.getByText(/no application server behind it and no accounts/)).toBeInTheDocument();
  });

  test('gives the build as three ordered steps', () => {
    const { container } = render(<SelfHost />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Three steps, and then the same three steps again' }),
    ).toBeInTheDocument();

    // The numerals are decoration beside the name, so the heading a screen reader reaches is the step.
    for (const name of ['Build', 'Serve', 'Update']) {
      expect(screen.getByRole('heading', { level: 3, name })).toBeInTheDocument();
    }

    const steps = container.querySelectorAll('.about-stages > li');
    expect(steps).toHaveLength(3);

    // The commands themselves, which are the reason somebody is on this page.
    const build = steps[0]?.textContent ?? '';
    expect(build).toContain('Node.js 20 or later');
    expect(build).toContain('npm ci');
    expect(build).toContain('npm run build');
    expect(build).toContain('dist/');

    expect(steps[1]?.textContent ?? '').toContain('BASE_PATH');
    // Updating must not read as a separate procedure: it is the same three commands again.
    expect(steps[2]?.textContent ?? '').toContain('keep running the build they started on');
  });

  test('names what the host does not have to provide', () => {
    const { container } = render(<SelfHost />);

    expect(screen.getByRole('heading', { level: 2, name: 'What you don’t have to run' })).toBeInTheDocument();
    for (const title of ['No routing rules', 'No database', 'No accounts', 'Nothing of ours in the loop']) {
      expect(screen.getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
    }

    // The tint is the section break, and there is exactly one of it on this page too.
    const bands = container.querySelectorAll('.about-band');
    expect(bands).toHaveLength(1);
    expect(bands[0]?.querySelector('.about-assurance-grid')).not.toBeNull();

    // Why there are no rewrite rules to write, which is the claim a host operator will check first.
    expect(screen.getByText(/keeps its state in the URL fragment, which never reaches the server/)).toBeInTheDocument();
  });

  test('lists the kinds of host it runs on as a definition list', () => {
    render(<SelfHost />);

    expect(screen.getByRole('heading', { level: 2, name: 'Somewhere to put it' })).toBeInTheDocument();
    for (const term of ['GitHub Pages', 'Cloudflare Pages', 'Your own server', 'A venue laptop']) {
      expect(screen.getByText(term, { selector: 'dt' })).toBeInTheDocument();
    }
    expect(screen.getByText(/Project repositories are served from a subpath/)).toBeInTheDocument();
  });

  test('does not promise offline without saying the origin has to be secure', () => {
    const { container } = render(<SelfHost />);

    expect(screen.getByRole('heading', { level: 2, name: 'Serve it over HTTPS' })).toBeInTheDocument();

    // The whole point of the section. A reader self-hosting in order to get offline scoring has to be
    // told that plain HTTP does not install the worker, and told it here rather than in a footnote.
    const offline = container.querySelector('.about-offline');
    expect(offline?.textContent ?? '').toContain('browsers only install one on a secure origin');
    expect(offline?.textContent ?? '').toContain('localhost');
    expect(offline?.textContent ?? '').toContain('nothing is cached');
  });

  test('states the AGPL network clause and limits it to modified copies', () => {
    const { container } = render(<SelfHost />);

    expect(screen.getByRole('heading', { level: 2, name: 'Yours to change' })).toBeInTheDocument();
    expect(screen.getByText(/licensed under the GNU AGPL, version 3 or later/)).toBeInTheDocument();

    const license = container.querySelector('.about-license');
    const words = license?.textContent ?? '';
    // Both halves. The obligation, and the fact that it does not attach to an unmodified build.
    expect(words).toContain('let other people use your changed version over a network');
    expect(words).toContain('offer them the source');
    expect(words).toContain('Hosting an unmodified build doesn’t involve that step');
    // And the page never claims to be the authority on it.
    expect(words).toContain('What governs here is the license text, not this page');

    expect(screen.getByRole('link', { name: 'Read the license' })).toHaveAttribute(
      'href',
      'https://github.com/gbyo/qbsheet/blob/main/LICENSE',
    );
  });

  test('links out from two directories deep', () => {
    const { container } = render(<SelfHost />);

    // Every path on this page is written from `about/self-host/`, so the scorer is two levels up and
    // the product page is one. A page served from a repository subpath has nothing else to go on.
    for (const link of screen.getAllByRole('link', { name: 'Open QBSheet' })) {
      expect(link).toHaveAttribute('href', '../../');
    }
    for (const link of screen.getAllByRole('link', { name: 'About' })) {
      expect(link).toHaveAttribute('href', '../');
    }
    expect(container.querySelector('.about-brand')).toHaveAttribute('href', '../../');

    for (const link of screen.getAllByRole('link', { name: 'Read the build steps' })) {
      expect(link).toHaveAttribute('href', 'https://github.com/gbyo/qbsheet#deployment');
    }

    // Both navigations mark this page as the current one, and both point at the directory it is
    // served from rather than at a name, because the deployment chooses that name.
    for (const region of ['.about-nav', '.about-footer nav']) {
      const nav = container.querySelector(region);
      const self = within(nav as HTMLElement).getByRole('link', { name: 'Self-host' });
      expect(self).toHaveAttribute('href', './');
      expect(self).toHaveAttribute('aria-current', 'page');
    }
  });

  test('closes on the call to action and assumes no quiz bowl format', () => {
    const { container } = render(<SelfHost />);

    expect(screen.getByRole('heading', { level: 2, name: 'Ready to host it?' })).toBeInTheDocument();
    expect(screen.getByText(/four commands/)).toBeInTheDocument();

    // Same editorial floor as the product page: nothing here may narrow QBSheet to one format.
    const words = (container.textContent ?? '').toLowerCase();
    for (const assumption of ['naqt', 'acf', 'power', 'neg', 'bounce', 'four players a side', 'between tossups']) {
      expect(words).not.toContain(assumption);
    }
  });
});
