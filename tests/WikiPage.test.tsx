/**
 * The wiki's chrome, which is the part of the section this repository actually owns.
 *
 * The content is synced and its transformation is covered by `WikiContent.test.ts`. What is left, and
 * what this file protects, is the frame around it: that a wiki article resolves its links from one
 * directory deeper than every other page on the site, and that the edit link exists and leaves.
 *
 * The depth is the interesting half. A wiki article is the only document here at `about/wiki/<page>/`,
 * so it is the only one needing three `../` to reach the scorer, and its own navigation entry points at
 * a sibling article rather than at its directory — which is exactly the case a self-link shortcut would
 * resolve to the wrong document. Both are asserted by name.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import WikiPage from '../src/about/WikiPage';
import type { IWikiPage, IWikiSection } from '../src/about/wikiContent';

const page: IWikiPage = {
  name: 'Start-here',
  slug: 'start-here',
  title: 'Start here',
  description: 'This page is for a scorekeeper.',
  bodyHtml: '<h2 id="before-you-start">Before you start</h2><p>You need one of two things.</p>',
};

const sections: IWikiSection[] = [
  {
    heading: 'Score a game',
    links: [
      { name: 'Start-here', slug: 'start-here', label: 'Start here' },
      { name: 'Troubleshooting', slug: 'troubleshooting', label: 'Troubleshooting' },
    ],
  },
];

const editUrl = 'https://github.com/gbyo/qbsheet/wiki/Start-here/_edit';

describe('a wiki article', () => {
  test('renders the title and the synced body', () => {
    render(<WikiPage page={page} sections={sections} editUrl={editUrl} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Start here' })).toBeInTheDocument();
    // The body arrives as HTML, so this is the assertion that it was placed rather than escaped.
    expect(screen.getByRole('heading', { level: 2, name: 'Before you start' })).toBeInTheDocument();
    expect(screen.getByText('You need one of two things.')).toBeInTheDocument();
  });

  test('offers an edit that goes to GitHub and leaves this site', () => {
    render(<WikiPage page={page} sections={sections} editUrl={editUrl} />);

    const edit = screen.getByRole('link', { name: /^Edit on GitHub/ });
    // The copy in this repository is overwritten by the next sync, so an edit has to go upstream.
    expect(edit).toHaveAttribute('href', editUrl);
    expect(edit).toHaveAttribute('target', '_blank');
    expect(edit).toHaveAttribute('rel', 'noopener noreferrer');
    expect(edit.textContent).toContain('(opens in a new tab)');
  });

  test('resolves every link from one directory deeper than the rest of the site', () => {
    const { container } = render(<WikiPage page={page} sections={sections} editUrl={editUrl} />);

    // `about/wiki/start-here/` is three levels below the scorer and two below the product page. This
    // is the assertion that fails if a wiki article is ever treated as an ordinary section page.
    expect(container.querySelector('.about-brand')).toHaveAttribute('href', '../../');
    const nav = container.querySelector('.about-nav') as HTMLElement;
    expect(within(nav).getByRole('link', { name: 'Scorer' })).toHaveAttribute('href', '../../../');
    expect(within(nav).getByRole('link', { name: 'Director' })).toHaveAttribute(
      'href',
      '../../../director.html',
    );

    // The wiki has no index page: its own `Home` is the front page, so that is where the navigation
    // entry goes. It must not be written as `./`, the shortcut every other page takes for itself.
    const footer = container.querySelector('.about-footer nav') as HTMLElement;
    expect(within(footer).getByRole('link', { name: 'About' })).toHaveAttribute('href', '../../');
    expect(within(footer).getByRole('link', { name: 'FAQ' })).toHaveAttribute('href', '../../faq/');
    const wikiLink = within(footer).getByRole('link', { name: 'Wiki' });
    expect(wikiLink).toHaveAttribute('href', '../../wiki/home/');
    expect(wikiLink).toHaveAttribute('aria-current', 'page');
  });

  test('marks the current page in the wiki navigation and points at its siblings', () => {
    const { container } = render(<WikiPage page={page} sections={sections} editUrl={editUrl} />);

    const wikiNav = container.querySelector('.about-wiki-nav') as HTMLElement;
    const self = within(wikiNav).getByRole('link', { name: 'Start here' });
    expect(self).toHaveAttribute('href', './');
    expect(self).toHaveAttribute('aria-current', 'page');
    // A sibling article is one directory across, not down.
    expect(within(wikiNav).getByRole('link', { name: 'Troubleshooting' })).toHaveAttribute(
      'href',
      '../troubleshooting/',
    );
  });
});
