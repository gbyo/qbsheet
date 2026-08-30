/**
 * The header, the footer, and every URL the marketing pages point at.
 *
 * # Why this is a module and not a copy on each page
 *
 * With two pages, a hand-maintained header on each was cheap. With six it is a standing invitation to
 * drift: a link added to one navigation and forgotten in five is not a visible defect anywhere, it is
 * simply a page nobody can reach from half the site. The same argument that keeps these pages as React
 * components rather than hand-written HTML — see the note at the top of `About` — applies once more
 * here, one level down.
 *
 * # Depth is computed, never counted by a caller
 *
 * Every path on these pages is relative, because the deployment chooses the directory: the same build
 * is served from a domain root, from `/qbsheet/` on GitHub Pages, and from a folder on a venue laptop.
 * A relative URL therefore has to be written against the directory of the document that names it, and
 * `about/index.html` and `about/faq/index.html` need different numbers of `../` for the same target.
 *
 * No caller states that count. A page passing its own `../` depth is a page that can pass the wrong
 * one, and the symptom — a link that 404s only once the site is deployed a directory deeper than the
 * dev server put it — appears nowhere in a unit test of that page. The depth is computed from the
 * slug, which is the same value that decides where the document is written.
 *
 * The wiki adds the one case a slug cannot answer on its own: its articles sit a directory deeper than
 * every other page. `nested` is how an article says so — a fact about itself rather than an arithmetic
 * result, so there is still no count to get wrong. See `depthOf`.
 */
import BrandLogo from '../BrandLogo';

export const githubUrl = 'https://github.com/gbyo/qbsheet';
export const qbjDocsUrl = `${githubUrl}/blob/main/docs/QBJ_ASSIGNMENT_PROFILE.md`;
export const qbtcpDocsUrl = `${githubUrl}/blob/main/docs/QBTCP.md`;
export const licenseUrl = `${githubUrl}/blob/main/LICENSE`;
export const documentationUrl = `${githubUrl}#documentation`;
export const buildStepsUrl = `${githubUrl}#deployment`;

/**
 * The pages of this site, named by the directory each is served from.
 *
 * The empty slug is the product page, which is `about/` itself. Everything else names a directory
 * below it. `wiki` names the section as a whole, whose articles each sit a directory below that; see
 * `depthOf`.
 */
export type PageSlug = '' | 'scoring' | 'tournaments' | 'self-host' | 'faq' | 'privacy' | 'wiki';

/**
 * How many directories below `about/` a document sits.
 *
 * The product page is `about/` itself, so it is zero. Every other section is one. `nested` is the one
 * exception the site has: a wiki article lives at `about/wiki/<page>/`, one below its section, and it
 * is the only kind of document that does.
 *
 * Kept as a flag rather than a free-form number so the count still cannot be passed wrongly — a caller
 * says whether it is an article, not how many `../` it believes it needs.
 */
function depthOf(slug: PageSlug, nested: boolean): number {
  return (slug === '' ? 0 : 1) + (nested ? 1 : 0);
}

/** The scorer, which is one directory above `about/` whatever the document's own depth is. */
export function scorerUrl(slug: PageSlug, nested = false): string {
  return '../'.repeat(depthOf(slug, nested) + 1);
}

/**
 * A link from the page at `slug` to the page at `target`.
 *
 * A page names itself as `./` rather than by its own directory name, because the deployment owns that
 * name and a self-link written as `./faq/` from inside `faq/` is wrong twice over. A wiki article is
 * not its section index, so that shortcut is exactly what it must not take.
 */
export function pageUrl(slug: PageSlug, target: PageSlug, nested = false): string {
  if (target === slug && !nested) return './';
  const depth = depthOf(slug, nested);
  const base = depth === 0 ? './' : '../'.repeat(depth);
  return target === '' ? base : `${base}${target}/`;
}

/**
 * The content pages, in the order the header offers them.
 *
 * The product page leads, because the wordmark goes to the *scorer* rather than here — a deliberate
 * choice the rest of the site is built around — and without this entry a reader three pages deep would
 * have no route back to the overview except the footer.
 *
 * Then scoring and tournaments, which are the two the reader is choosing between: one is written for
 * the person at the table and the other for the person putting sixteen rooms on this.
 *
 * Privacy is not here. It is the one page nobody browses to and everybody arrives at from a link or a
 * search, so it is carried in the footer where a legal-adjacent page is looked for anyway, and the
 * header stays at a length that still wraps to two lines rather than three on a narrow phone.
 */
interface INavPage {
  slug: PageSlug;
  label: string;
  /**
   * Where the link goes, when that is not the slug's own directory.
   *
   * The wiki is the only entry needing one. It has no index page of its own — the wiki's `Home` is
   * its front page, written by the same people who write the rest of it — so the navigation points
   * at that article rather than at a directory nothing would be served from.
   */
  path?: string;
}

const primaryPages: INavPage[] = [
  { slug: '', label: 'About' },
  { slug: 'scoring', label: 'Scoring' },
  { slug: 'tournaments', label: 'Tournaments' },
  { slug: 'self-host', label: 'Self-host' },
  { slug: 'faq', label: 'FAQ' },
  // One entry for the whole wiki, whose own sidebar carries its sixteen pages. A section that
  // navigates itself does not need the site navigation to enumerate it.
  { slug: 'wiki', label: 'Wiki', path: 'wiki/home' },
];

/** Where a navigation entry points, which is the slug's directory unless it names another. */
function navHref(from: PageSlug, page: INavPage, nested: boolean): string {
  if (page.path === undefined) return pageUrl(from, page.slug, nested);
  const depth = depthOf(from, nested);
  return `${depth === 0 ? './' : '../'.repeat(depth)}${page.path}/`;
}

/** The footer carries everything, including the page the header leaves out. */
const footerPages: INavPage[] = [...primaryPages, { slug: 'privacy', label: 'Privacy' }];

/** `aria-current` belongs on the link to the page you are already on, and nowhere else. */
function current(slug: PageSlug, target: PageSlug): { 'aria-current'?: 'page' } {
  return slug === target ? { 'aria-current': 'page' } : {};
}

/**
 * A link that leaves the site, marked as one.
 *
 * # Why the icon and the new tab arrive together
 *
 * The arrow is the convention readers already know, and what it conventionally promises is that the
 * current page will still be there afterwards. An icon on a link that replaces the page is a small
 * lie, so the two are one component rather than two decisions: anything wearing the mark opens in a
 * new tab, and anything opening in a new tab wears the mark.
 *
 * `rel="noopener noreferrer"` because a new tab otherwise gets a handle on this one through
 * `window.opener`. `noreferrer` is what this project's lint rule asks for, and it covers the older
 * browsers where `noopener` alone was not honoured.
 *
 * # Why the arrow is not the whole announcement
 *
 * The glyph is `aria-hidden`, because a screen reader saying "graphic" after the link text tells
 * nobody anything. The behaviour is announced in words instead, by the visually-hidden span, so the
 * two audiences are told the same thing in the form each can use.
 */
function ExternalLink({ href, children, className }: { href: string; children: string; className?: string }) {
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <svg
        className="about-external-icon"
        viewBox="0 0 24 24"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M14 4h6v6" />
        <path d="M20 4 11 13" />
        <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </svg>
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

export function PageHeader({ slug, nested = false }: { slug: PageSlug; nested?: boolean }) {
  return (
    <header className="about-header">
      <div className="about-header-inner">
        {/* The wordmark returns to this site's own front page, which is the product page rather than
            the scorer. "Open QBSheet" is the way into the application, and it is a button-shaped
            thing in the hero and the closing action of every page. */}
        <a className="about-brand" href={pageUrl(slug, '', nested)} aria-label="QBSheet home">
          <BrandLogo className="about-brand-logo" />
        </a>
        <nav className="about-nav" aria-label="Primary navigation">
          <a href={scorerUrl(slug, nested)}>Open QBSheet</a>
          {primaryPages.map((page) => (
            <a key={page.slug} href={navHref(slug, page, nested)} {...current(slug, page.slug)}>
              {page.label}
            </a>
          ))}
          <ExternalLink href={githubUrl}>GitHub</ExternalLink>
        </nav>
      </div>
    </header>
  );
}

export function PageFooter({ slug, nested = false }: { slug: PageSlug; nested?: boolean }) {
  return (
    <footer className="about-footer">
      <nav aria-label="Footer navigation">
        <a href={scorerUrl(slug, nested)}>QBSheet</a>
        {footerPages.map((page) => (
          <a key={page.slug} href={navHref(slug, page, nested)} {...current(slug, page.slug)}>
            {page.label}
          </a>
        ))}
        {/* Both of these leave the site, and a marked link in the header beside an unmarked one in
            the footer reads as an oversight rather than as a distinction. */}
        <ExternalLink href={documentationUrl}>Documentation</ExternalLink>
        <ExternalLink href={githubUrl}>GitHub</ExternalLink>
      </nav>
    </footer>
  );
}

/**
 * The two buttons every page closes on, and opens on where it has a hero worth acting from.
 *
 * `primary` is the page's own call to action, because it is not the same on all six: the self-hosting
 * page sends a reader to the build steps, and the rest send them into the scorer.
 */
export function ActionLinks({
  slug,
  primary,
  nested = false,
}: {
  slug: PageSlug;
  primary?: { href: string; label: string; external?: boolean };
  nested?: boolean;
}) {
  return (
    <div className="about-actions">
      {primary === undefined ? (
        <>
          <a className="about-button is-primary" href={scorerUrl(slug, nested)}>
            Open QBSheet
          </a>
          <ExternalLink className="about-button" href={githubUrl}>
            View on GitHub
          </ExternalLink>
        </>
      ) : (
        <>
          {primary.external ? (
            <ExternalLink className="about-button is-primary" href={primary.href}>
              {primary.label}
            </ExternalLink>
          ) : (
            <a className="about-button is-primary" href={primary.href}>
              {primary.label}
            </a>
          )}
          <a className="about-button" href={scorerUrl(slug, nested)}>
            Open QBSheet
          </a>
        </>
      )}
    </div>
  );
}
