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
 * # Depth is derived, never passed
 *
 * Every path on these pages is relative, because the deployment chooses the directory: the same build
 * is served from a domain root, from `/qbsheet/` on GitHub Pages, and from a folder on a venue laptop.
 * A relative URL therefore has to be written against the directory of the document that names it, and
 * `about/index.html` and `about/faq/index.html` need different numbers of `../` for the same target.
 *
 * That count is not a parameter. A page passing its own depth is a page that can pass the wrong one,
 * and the symptom — a link that 404s only once the site is deployed a directory deeper than the dev
 * server put it — appears nowhere in a unit test of that page. So the depth is computed from the slug,
 * which is the same value that decides where the document is written, and there is nothing to get out
 * of step.
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
 * The empty slug is the product page at `about/`, which is the one document at depth 1. Everything
 * else sits one directory below it.
 */
export type PageSlug = '' | 'scoring' | 'tournaments' | 'self-host' | 'faq' | 'privacy';

/** The scorer, from a page at `slug`. The product page is one level down from it; the rest are two. */
export function scorerUrl(slug: PageSlug): string {
  return slug === '' ? '../' : '../../';
}

/**
 * A link from the page at `slug` to the page at `target`.
 *
 * A page always names itself as `./` rather than by its own directory name, because the deployment
 * owns that name and a self-link written as `./faq/` from inside `faq/` is wrong twice over.
 */
export function pageUrl(slug: PageSlug, target: PageSlug): string {
  if (target === slug) return './';
  const base = slug === '' ? './' : '../';
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
const primaryPages: { slug: PageSlug; label: string }[] = [
  { slug: '', label: 'About' },
  { slug: 'scoring', label: 'Scoring' },
  { slug: 'tournaments', label: 'Tournaments' },
  { slug: 'self-host', label: 'Self-host' },
  { slug: 'faq', label: 'FAQ' },
];

/** The footer carries everything, including the page the header leaves out. */
const footerPages: { slug: PageSlug; label: string }[] = [
  ...primaryPages,
  { slug: 'privacy', label: 'Privacy' },
];

/** `aria-current` belongs on the link to the page you are already on, and nowhere else. */
function current(slug: PageSlug, target: PageSlug): { 'aria-current'?: 'page' } {
  return slug === target ? { 'aria-current': 'page' } : {};
}

export function PageHeader({ slug }: { slug: PageSlug }) {
  return (
    <header className="about-header">
      <div className="about-header-inner">
        <a className="about-brand" href={scorerUrl(slug)} aria-label="QBSheet home">
          <BrandLogo className="about-brand-logo" />
        </a>
        <nav className="about-nav" aria-label="Primary navigation">
          <a href={scorerUrl(slug)}>Open QBSheet</a>
          {primaryPages.map((page) => (
            <a key={page.slug} href={pageUrl(slug, page.slug)} {...current(slug, page.slug)}>
              {page.label}
            </a>
          ))}
          <a href={githubUrl}>GitHub</a>
        </nav>
      </div>
    </header>
  );
}

export function PageFooter({ slug }: { slug: PageSlug }) {
  return (
    <footer className="about-footer">
      <nav aria-label="Footer navigation">
        <a href={scorerUrl(slug)}>QBSheet</a>
        {footerPages.map((page) => (
          <a key={page.slug} href={pageUrl(slug, page.slug)} {...current(slug, page.slug)}>
            {page.label}
          </a>
        ))}
        <a href={documentationUrl}>Documentation</a>
        <a href={githubUrl}>GitHub</a>
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
}: {
  slug: PageSlug;
  primary?: { href: string; label: string };
}) {
  return (
    <div className="about-actions">
      {primary === undefined ? (
        <>
          <a className="about-button is-primary" href={scorerUrl(slug)}>
            Open QBSheet
          </a>
          <a className="about-button" href={githubUrl}>
            View on GitHub
          </a>
        </>
      ) : (
        <>
          <a className="about-button is-primary" href={primary.href}>
            {primary.label}
          </a>
          <a className="about-button" href={scorerUrl(slug)}>
            Open QBSheet
          </a>
        </>
      )}
    </div>
  );
}
