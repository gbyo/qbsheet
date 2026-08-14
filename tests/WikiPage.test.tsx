/**
 * The wiki's chrome, which is the part of the section this repository actually owns.
 *
 * The content is synced and its transformation is covered by `WikiContent.test.ts`. What is left, and
 * what this file protects, is the frame around it: that a wiki article resolves its links from one
 * directory deeper than every other page on the site, and that the edit link exists and leaves.
 *
 * The depth is the interesting half. A wiki article is the only document here at `about/wiki/<page>/`,
 * so it is the only one needing three `../` to reach the scorer, and it shares a slug with the section
 * index sitting one level above it — which is exactly the case that would make a self-link resolve to
 * the wrong document. Both are asserted by name.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import WikiPage from '../src/about/WikiPage';
import Wiki from '../src/about/Wiki';
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
    for (const link of screen.getAllByRole('link', { name: 'Open QBSheet' })) {
      expect(link).toHaveAttribute('href', '../../../');
    }
    expect(container.querySelector('.about-brand')).toHaveAttribute('href', '../../');
    const nav = container.querySelector('.about-nav') as HTMLElement;
    expect(within(nav).getByRole('link', { name: 'About' })).toHaveAttribute('href', '../../');
    expect(within(nav).getByRole('link', { name: 'FAQ' })).toHaveAttribute('href', '../../faq/');

    // The section index is a real directory above this one, so it must not be written as `./` — the
    // shortcut every other page takes for a link to itself.
    const wikiLinks = within(nav).getByRole('link', { name: 'Wiki' });
    expect(wikiLinks).toHaveAttribute('href', '../../wiki/');
    expect(wikiLinks).toHaveAttribute('aria-current', 'page');
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

describe('the wiki index', () => {
  test('lists the sections and links down into them', () => {
    const { container } = render(<Wiki sections={sections} wikiUrl="https://github.com/gbyo/qbsheet/wiki" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Wiki' })).toBeInTheDocument();
    // Sitting at `about/wiki/`, its articles are below it rather than beside it.
    const wikiNav = container.querySelector('.about-wiki-nav') as HTMLElement;
    expect(within(wikiNav).getByRole('link', { name: 'Start here' })).toHaveAttribute(
      'href',
      './start-here/',
    );
    // And it is an ordinary section page, so the scorer is two levels up.
    for (const link of screen.getAllByRole('link', { name: 'Open QBSheet' })) {
      expect(link).toHaveAttribute('href', '../../');
    }
  });

  test('says the specifications rather than the wiki are normative', () => {
    const { container } = render(<Wiki sections={sections} wikiUrl="https://github.com/gbyo/qbsheet/wiki" />);

    // The wiki's own footer says this, and it matters enough to repeat: somebody implementing QBTCP
    // against a guide rather than the specification will get it subtly wrong.
    const words = (container.textContent ?? '').replace(/\s+/g, ' ');
    expect(words).toContain('The specifications in docs/ are the normative ones');
    expect(words).toContain('where the two disagree the specification wins');
  });
});
