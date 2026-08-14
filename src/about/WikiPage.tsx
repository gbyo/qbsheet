/**
 * One wiki page, wearing this site's chrome.
 *
 * # A component with no opinions about content
 *
 * Everything this renders arrives as props. The Markdown is read and turned into HTML by
 * `wikiContent`, which runs in `vite.config.ts` at build time, and this component only places the
 * result. That split is deliberate: it keeps `node:fs` and the Markdown renderer out of anything that
 * could be bundled, and it makes the component testable with plain objects rather than a fixture
 * directory.
 *
 * Like every other page here it is rendered to static HTML by `aboutPrerenderPlugin` and ships with no
 * React behind it.
 *
 * # `dangerouslySetInnerHTML`, and why it is not dangerous here
 *
 * The HTML is produced by `marked` from Markdown this repository has a committed copy of, with raw
 * HTML disabled at the renderer — see `wikiContent`. So the tags reaching this point are the ones the
 * renderer itself emits from Markdown constructs, not anything an author wrote directly. The
 * alternative, parsing that HTML back into React elements, would add a parser to defend against input
 * that is already constrained at its source.
 *
 * # The edit link is the point
 *
 * A wiki nobody can edit is a documentation page with extra steps. The button goes to GitHub's editor
 * for this exact page, because GitHub holds the copy that people change and this repository holds a
 * synced duplicate — an edit made here would be overwritten by the next sync and would leave the two
 * disagreeing. `.github/workflows/sync-wiki.yml` is the other half of that arrangement.
 */
import { PageFooter, PageHeader } from './PageChrome';
import type { IWikiPage, IWikiSection } from './wikiContent';

const slug = 'wiki' as const;

/**
 * The wiki's own navigation, from the wiki's own sidebar.
 *
 * Marked `aria-current` on the page being read, the same as the site navigation above it, so the two
 * behave alike for somebody moving through this section with a screen reader.
 */
export function WikiNav({ sections, current }: { sections: IWikiSection[]; current?: string }) {
  return (
    <nav className="about-wiki-nav" aria-label="Wiki navigation">
      {sections.map((section) => (
        <div key={section.heading}>
          <h2>{section.heading}</h2>
          <ul>
            {section.links.map((link) => (
              <li key={link.slug}>
                <a
                  href={link.slug === current ? './' : `../${link.slug}/`}
                  {...(link.slug === current ? { 'aria-current': 'page' as const } : {})}
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The link back to GitHub's editor, which is where this page is actually changed. */
export function EditLink({ href }: { href: string }) {
  return (
    <a className="about-wiki-edit" href={href} target="_blank" rel="noopener noreferrer">
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
      Edit on GitHub
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

export default function WikiPage({
  page,
  sections,
  editUrl,
}: {
  page: IWikiPage;
  sections: IWikiSection[];
  editUrl: string;
}) {
  return (
    <div className="about-page">
      <PageHeader slug={slug} nested />

      <main className="about-wiki">
        <div className="about-wiki-inner">
          <WikiNav sections={sections} current={page.slug} />

          <article className="about-wiki-body">
            <div className="about-wiki-heading">
              {/* The wiki's own `Home`, which is its front page. There is no index page above these
                  articles: the section is the wiki, and the wiki already has one. */}
              <p className="about-kicker">
                <a href="../home/">Wiki</a>
              </p>
              <h1>{page.title}</h1>
              <EditLink href={editUrl} />
            </div>
            <div
              className="about-wiki-prose"
              dangerouslySetInnerHTML={{ __html: page.bodyHtml }}
            />
          </article>
        </div>
      </main>

      <PageFooter slug={slug} nested />
    </div>
  );
}
