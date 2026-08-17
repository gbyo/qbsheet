/**
 * The wiki as this build reads it, and the three ways a synced wiki quietly breaks.
 *
 * The content is not written in this repository — it is a copy, and the copy changes without anybody
 * here reviewing it — so what is worth protecting is the *transformation*, plus a small number of
 * facts about the real synced content that the site's structure depends on.
 *
 * The failures this file is aimed at are all silent ones. A link rewritten without its fragment still
 * works, and lands the reader at the top of a long page. A heading anchor that does not match the one
 * GitHub generated breaks every cross-page link written against GitHub's. And raw HTML reaching a
 * rendered page would be a wiki edit — a wider circle of authors than a pull request has — putting
 * markup on this domain.
 */
import { describe, expect, test } from 'vitest';
import {
  editUrlFor,
  headingId,
  readWikiPage,
  readWikiSections,
  rewriteLinks,
  slugFor,
  wikiPageNames,
} from '../src/about/wikiContent';

/**
 * The repository root.
 *
 * `process.cwd()` rather than a path derived from `import.meta.url`, because Vitest serves this
 * module from a `/@fs/` URL that is neither a usable path nor a `file:` one. The runner's working
 * directory is the project root, which is the same thing `vite.config.ts` passes when it reads the
 * wiki for real.
 */
const root = process.cwd();

describe('wiki link rewriting', () => {
  const known = new Set(['Troubleshooting', 'Start-here']);

  test('points a bare page name at the directory this build writes', () => {
    expect(rewriteLinks('<a href="Start-here">x</a>', known)).toBe('<a href="../start-here/">x</a>');
  });

  test('keeps the fragment, which is the whole value of several of these links', () => {
    // Written by an author reading GitHub's own anchor. Dropping it leaves the link working and the
    // reader at the top of a page with a dozen sections.
    expect(rewriteLinks('<a href="Troubleshooting#pairing-fails">x</a>', known)).toBe(
      '<a href="../troubleshooting/#pairing-fails">x</a>',
    );
  });

  test('leaves absolute, rooted and same-page links alone', () => {
    for (const href of ['https://github.com/gbyo/qbsheet', '/about/', '#a-section', 'mailto:a@b.c']) {
      expect(rewriteLinks(`<a href="${href}">x</a>`, known)).toBe(`<a href="${href}">x</a>`);
    }
  });

  test('leaves a link to a page the wiki does not have', () => {
    // Broken either way, and the wiki's own version of it is the one somebody can find and fix. A
    // rewrite would point at a directory this build never creates.
    expect(rewriteLinks('<a href="Not-a-page">x</a>', known)).toBe('<a href="Not-a-page">x</a>');
  });
});

describe('heading anchors', () => {
  test('match the identifier GitHub would have generated', () => {
    expect(headingId('The browser will not save anything')).toBe('the-browser-will-not-save-anything');
    expect(headingId('Step 1. Open QBSheet')).toBe('step-1-open-qbsheet');
    expect(headingId('QBJ, QBTCP and `.qbg`')).toBe('qbj-qbtcp-and-qbg');
  });
});

describe('the synced wiki', () => {
  const names = wikiPageNames(root);

  test('publishes the pages and not GitHub’s own furniture', () => {
    expect(names).toContain('Start-here');
    expect(names).toContain('Troubleshooting');
    // The sidebar becomes this section's navigation and the footer is not carried across at all.
    expect(names).not.toContain('_Sidebar');
    expect(names).not.toContain('_Footer');
  });

  test('renders a page into a title, a description and a body without its own heading', () => {
    const page = readWikiPage(root, 'Start-here');

    expect(page.slug).toBe('start-here');
    expect(page.title).toBe('Start here');
    expect(page.description).toMatch(/^This page is for a scorekeeper/);
    // The component renders the title itself, so leaving the source `<h1>` would print it twice.
    expect(page.bodyHtml).not.toContain('<h1');
    expect(page.bodyHtml).toContain('<h2 id="before-you-start">');
  });

  test('refuses raw HTML rather than passing it through', () => {
    // Nothing in the wiki writes a tag today. This asserts the renderer's posture, not the content:
    // a wiki is editable by anyone with push access, and a rendered page is on this domain.
    const page = readWikiPage(root, 'Home');
    expect(page.bodyHtml).not.toMatch(/<script|<iframe|onerror=/i);
  });

  test('every cross-page anchor resolves to a heading that exists', () => {
    // The assertion that catches a wiki edit renaming a section other pages point at, which is
    // invisible on the rendered page because the link still works.
    const bodies = new Map(names.map((name) => [slugFor(name), readWikiPage(root, name).bodyHtml]));
    const missing: string[] = [];
    for (const [from, html] of bodies) {
      for (const [, target, anchor] of html.matchAll(/href="\.\.\/([a-z0-9-]+)\/#([^"]+)"/g)) {
        const body = bodies.get(target);
        if (body === undefined || !body.includes(`id="${anchor}"`)) {
          missing.push(`${from} → ${target}#${anchor}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('reads the navigation from the wiki’s own sidebar', () => {
    const sections = readWikiSections(root);

    // The grouping is the wiki's, so that reorganising it on GitHub reorganises this site.
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.map((section) => section.heading)).toContain('Score a game');
    for (const section of sections) {
      expect(section.links.length).toBeGreaterThan(0);
      for (const link of section.links) {
        expect(names).toContain(link.name);
        expect(link.slug).toBe(slugFor(link.name));
      }
    }
  });

  test('sends an edit to GitHub rather than anywhere in this repository', () => {
    // The copy here is overwritten by the next sync, so an edit made against it would be lost and
    // would leave the two disagreeing in the meantime.
    expect(editUrlFor('Start-here')).toBe('https://github.com/gbyo/qbsheet/wiki/Start-here/_edit');
  });
});
