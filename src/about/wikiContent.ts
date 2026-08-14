/**
 * The GitHub wiki, read off disk and turned into something the site can render.
 *
 * # This module never reaches a browser
 *
 * It reads files and it runs at build time only, called from `vite.config.ts` while
 * `aboutPrerenderPlugin` renders each page to static HTML. Nothing in the client graph imports it, so
 * neither it nor `marked` is in any bundle the scorer or the marketing pages ship — the same
 * arrangement as the page components themselves, and the reason a Markdown renderer can be a
 * `devDependency`.
 *
 * # The wiki is the source, and it is not edited here
 *
 * `wiki/` is a copy, synced from `gbyo/qbsheet.wiki` by `.github/workflows/sync-wiki.yml`. Editing a
 * page in this repository would be overwritten by the next sync and would leave the version on GitHub
 * — the one people actually edit — silently disagreeing with the published site. That is why every
 * rendered page carries an edit link that goes to GitHub rather than anywhere here.
 *
 * # Why the copy is committed rather than fetched during the build
 *
 * A build that fetched the wiki would stop being reproducible, would fail without a network, and would
 * make every self-hoster's build depend on GitHub being reachable. It would also falsify a claim the
 * self-hosting page makes in as many words: that neither the build nor the site it produces contacts
 * anything we run. So the sync is a commit, and the build reads local files like every other input.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Marked } from 'marked';

/** Where the synced copy lives, relative to the repository root. */
export const wikiDirectory = 'wiki';

/** The wiki this content came from, which is where an edit has to go. */
export const wikiBaseUrl = 'https://github.com/gbyo/qbsheet/wiki';

/**
 * Pages the wiki has that the site does not publish.
 *
 * `_Sidebar` and `_Footer` are GitHub's own furniture rather than pages: the sidebar becomes this
 * section's navigation and the footer is not carried across, because the site has a footer of its own
 * and two would be one too many.
 */
const notPages = new Set(['_Sidebar', '_Footer']);

/** One page of the wiki, rendered. */
export interface IWikiPage {
  /** The wiki's own name for the page, which is what an edit URL and an internal link use. */
  name: string;
  /** The directory this page is served from, which is the name lowercased. */
  slug: string;
  /** The first level-one heading, which every page in this wiki starts with. */
  title: string;
  /** The opening paragraph, flattened for a meta description. */
  description: string;
  /** The body as HTML, with the leading `<h1>` removed because the page renders its own. */
  bodyHtml: string;
}

/** One group of links in the wiki's own sidebar. */
export interface IWikiSection {
  heading: string;
  links: { name: string; slug: string; label: string }[];
}

/**
 * A page name as it appears in a URL.
 *
 * Lowercased and nothing else. The wiki's names are already hyphenated words — `Score-a-connected-game`
 * — so there is no separator to invent, and inventing one would break the correspondence between a
 * link written in a wiki page and the directory this build puts it in.
 */
export function slugFor(name: string): string {
  return name.toLowerCase();
}

/**
 * An identifier for a heading, matching the one GitHub would have given it.
 *
 * This has to agree with GitHub rather than merely be consistent with itself. Wiki pages link to each
 * other's sections — several point at `Troubleshooting#the-browser-will-not-save-anything` — and those
 * fragments were written by an author reading the anchor GitHub generated. A different scheme here
 * would leave every one of them landing at the top of a long page, which is the failure mode nobody
 * reports because the link still works.
 *
 * The rule: lower-case, drop everything that is not a letter, a digit, a space or a hyphen, then turn
 * runs of spaces into single hyphens.
 */
export function headingId(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .replace(/ +/g, '-');
}

/**
 * A renderer with raw HTML off and heading anchors on.
 *
 * # No raw HTML
 *
 * The wiki's Markdown contains none today — every angle bracket in it is inside a code span or a
 * fence — so nothing is lost by refusing it, and refusing it means a future wiki edit cannot inject
 * markup into a page on this domain. A wiki is editable by anyone with push access, which is a wider
 * circle than the people who review a pull request here. `marked` escapes rather than strips, so an
 * author who does write a tag sees it as text and can tell something was disallowed.
 *
 * # Heading anchors
 *
 * Added because `marked` stopped emitting them and this wiki's cross-page links depend on them. A
 * repeated heading gets a numeric suffix, which is also what GitHub does, so two sections called
 * "Symptoms" on one page remain separately addressable.
 */
function renderer(): Marked {
  const seen = new Map<string, number>();
  const marked = new Marked({ gfm: true, breaks: false, async: false });
  marked.use({
    renderer: {
      heading(token) {
        const text = this.parser.parseInline(token.tokens);
        const base = headingId(token.text);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const id = count === 0 ? base : `${base}-${count}`;
        return `<h${token.depth} id="${id}">${text}</h${token.depth}>\n`;
      },
    },
  });
  return marked;
}

/**
 * Rewrite the links a wiki page makes to its siblings.
 *
 * GitHub resolves a bare `[Text](Page-Name)` against the wiki. This build has to resolve it against
 * `/about/wiki/<slug>/`, where a sibling is one directory up and back down. An anchor has to survive
 * the rewrite, because several pages link to a specific section of `Troubleshooting` and losing the
 * fragment would land the reader at the top of a long page.
 *
 * Anything already absolute — every `https://` link in the wiki goes to this repository — is left
 * exactly as it is.
 */
export function rewriteLinks(html: string, known: ReadonlySet<string>): string {
  return html.replace(/href="([^"]+)"/g, (whole, href: string) => {
    if (/^[a-z]+:|^\/|^#/i.test(href)) return whole;
    const [target, ...rest] = href.split('#');
    const anchor = rest.length > 0 ? `#${rest.join('#')}` : '';
    // A link to a page the wiki does not have is left alone rather than pointed at a directory this
    // build will not create. It is a broken link either way, and the wiki's own version of it is the
    // one somebody can find and fix.
    if (!known.has(target)) return whole;
    return `href="../${slugFor(target)}/${anchor}"`;
  });
}

/** The opening paragraph as one line of plain text, for a `<meta name="description">`. */
function describe(markdown: string): string {
  const body = markdown.replace(/^#[^\n]*\n/, '');
  const paragraph = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block.length > 0 && !block.startsWith('#') && !block.startsWith('|'));
  if (paragraph === undefined) return '';
  return paragraph
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first level-one heading, which is the page's own title. */
function titleOf(markdown: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match === null ? fallback : match[1].trim();
}

/** Every page name the wiki publishes, in the order the filesystem lists them. */
export function wikiPageNames(root: string): string[] {
  return readdirSync(join(root, wikiDirectory))
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -'.md'.length))
    .filter((name) => !notPages.has(name))
    .sort();
}

/** One page, read and rendered. */
export function readWikiPage(root: string, name: string): IWikiPage {
  const markdown = readFileSync(join(root, wikiDirectory, `${name}.md`), 'utf8');
  const known = new Set(wikiPageNames(root));
  const html = renderer().parse(markdown) as string;
  // The level-one heading is dropped from the body because `WikiPage` renders the title itself, in
  // the hero the rest of the site uses. Leaving it would put the same words on the page twice.
  const withoutTitle = html.replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/, '');
  return {
    name,
    slug: slugFor(name),
    title: titleOf(markdown, name.replace(/-/g, ' ')),
    description: describe(markdown),
    bodyHtml: rewriteLinks(withoutTitle, known),
  };
}

/**
 * The wiki's sidebar, as the sections this site navigates by.
 *
 * Parsed from `_Sidebar.md` rather than restated here, so the order and the grouping stay whatever the
 * wiki says they are. Somebody who reorganises the sidebar on GitHub has reorganised this site's
 * navigation, which is the behaviour a synced wiki should have.
 *
 * A bold line is a group heading and a list item is a link. Anything else in that file is ignored,
 * because the sidebar is prose that happens to be structured rather than a data format with rules.
 */
export function readWikiSections(root: string): IWikiSection[] {
  const source = readFileSync(join(root, wikiDirectory, '_Sidebar.md'), 'utf8');
  const known = new Set(wikiPageNames(root));
  const sections: IWikiSection[] = [];
  for (const line of source.split('\n')) {
    const heading = /^\*\*(.+)\*\*\s*$/.exec(line.trim());
    if (heading !== null) {
      sections.push({ heading: heading[1].trim(), links: [] });
      continue;
    }
    const link = /^-\s*\[([^\]]+)\]\(([^)#]+)[^)]*\)\s*$/.exec(line.trim());
    if (link === null || sections.length === 0) continue;
    const name = link[2].trim();
    if (!known.has(name)) continue;
    sections[sections.length - 1].links.push({ name, slug: slugFor(name), label: link[1].trim() });
  }
  return sections.filter((section) => section.links.length > 0);
}

/** Where a reader goes to change a page, which is the wiki and never this repository. */
export function editUrlFor(name: string): string {
  return `${wikiBaseUrl}/${name}/_edit`;
}
