/**
 * The wiki's front door.
 *
 * # What this page is and is not
 *
 * It is the contents page for a section whose pages come from somewhere else. It states where the
 * content lives, that anyone can change it, and that the specifications in `docs/` — not this wiki —
 * are the normative ones. That last point is the wiki's own footer talking, and it matters enough to
 * repeat here: somebody implementing QBTCP against a guide rather than against the specification will
 * get it subtly wrong.
 *
 * # The sections are the wiki's, not this file's
 *
 * The groups and their order are parsed from the wiki's `_Sidebar.md` by `wikiContent` and arrive as
 * props. Restating them here would mean a reorganisation on GitHub silently disagreeing with the
 * published contents page, which is the failure a synced wiki exists to avoid.
 */
import { PageFooter, PageHeader, githubUrl } from './PageChrome';
import { WikiNav } from './WikiPage';
import type { IWikiSection } from './wikiContent';

const slug = 'wiki' as const;

export default function Wiki({
  sections,
  wikiUrl,
}: {
  sections: IWikiSection[];
  wikiUrl: string;
}) {
  return (
    <div className="about-page">
      <PageHeader slug={slug} />

      <main>
        <section className="about-hero" aria-labelledby="wiki-title">
          <h1 id="wiki-title">Wiki</h1>
          <p className="about-hero-copy">
            Guides for scoring a game, preparing devices, running a connected room, and building
            QBSheet. Anyone can edit these pages on GitHub, and changes appear here after the next
            sync.
          </p>
        </section>

        <section className="about-section about-wiki-index" aria-labelledby="contents-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Contents</p>
            <h2 id="contents-heading">Every page</h2>
            <p>
              These pages are a guide. The specifications in <code>docs/</code> are the normative
              ones, and where the two disagree the specification wins.
            </p>
          </div>
          <WikiNav sections={sections} base="./" />
        </section>

        <section className="about-section about-wiki-source" aria-labelledby="source-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Source</p>
            <h2 id="source-heading">Where these pages live</h2>
          </div>
          <div className="about-prose">
            <p>
              The wiki is kept on GitHub, and this site publishes a copy of it. Editing a page there
              updates it here, so the version people can change and the version people read do not
              drift apart.
            </p>
            <p>
              Every page below carries an edit link that opens that page in GitHub&apos;s editor.{' '}
              <a href={wikiUrl} target="_blank" rel="noopener noreferrer">
                Browse the wiki on GitHub
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
              , or{' '}
              <a href={githubUrl} target="_blank" rel="noopener noreferrer">
                the repository itself
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
              .
            </p>
          </div>
        </section>
      </main>

      <PageFooter slug={slug} />
    </div>
  );
}
