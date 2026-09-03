/**
 * The QBLive product page.
 *
 * # Why a page here for an application served somewhere else
 *
 * QBLive is not part of this deployment. `live.qbsheet.com` serves the client, the tournament's own
 * backend serves the tournament, and neither is this site. What was missing was anywhere on this site
 * that said what QBLive *is* — the header had a bare external link, so the only way to find out was
 * to open an application that, without a tournament link, has nothing to show. See `resolveBootstrap`
 * in `apps/live-web/src/App.tsx`: a visit with no publication in the URL and none remembered is an
 * error screen, correctly.
 *
 * So this page explains the product and then hands the reader the application, and it is explicit
 * that a tournament is reached through the link or QR code that tournament published.
 *
 * # Same build-time rendering as every other page here
 *
 * Rendered to static HTML by `aboutPrerenderPlugin` in `vite.config.ts`, out of the same `about-*`
 * classes as the rest of the site.
 *
 * # Nothing here is aspirational
 *
 * The five tabs are `apps/live-web/src/App.tsx`. The read-only, unauthenticated public routes are
 * `docs/QBLIVE.md` §4; the release gate and the scope-label disclosure are §9.3; players defaulting
 * off are §9.4; the refusal to publish an estimated time is §7.2; the vendor-neutral "a static host
 * serving two JSON documents is a conforming server" is §1 and §3; the remembered last snapshot is
 * `readCache`/`writeCache` in `apps/live-web/src/state/store.ts`.
 *
 * What is deliberately not claimed: the iOS client and App Clip, which exist in the repository but
 * are not what `live.qbsheet.com` hands a reader today; and any control QBLive does not have. QBLive
 * shows a tournament. It never runs one.
 */
import type { ReactNode } from 'react';
import {
  ActionLinks,
  PageFooter,
  PageHeader,
  githubUrl,
  pageUrl,
  qbliveDocsUrl,
  qbliveUrl,
} from './PageChrome';

const slug = 'qblive' as const;

/** Relative, because this page does not know what directory the deployment put it in. */
const directorUrl = pageUrl(slug, 'director');
const scoringUrl = pageUrl(slug, 'scoring');

const open = { href: qbliveUrl, label: 'Open QBLive', external: true } as const;
const repository = { href: githubUrl, label: 'View on GitHub', external: true } as const;

/** The five screens QBLive has, named as it names them. */
const screens: { term: string; body: ReactNode }[] = [
  {
    term: 'Home',
    body: 'One team’s day: the next event, the game in progress, where the team stands, its recent results, and anything urgent the tournament has announced.',
  },
  {
    term: 'Schedule',
    body: 'The followed team’s games, or the whole published schedule, grouped by round.',
  },
  {
    term: 'Standings',
    body: 'The standings tables the tournament published, at the scopes it published them for.',
  },
  {
    term: 'Stats',
    body: 'Team and player statistics, when the tournament has chosen to publish them.',
  },
  {
    term: 'Updates',
    body: 'Announcements from tournament control, shown as plain text and never as markup.',
  },
];

/**
 * What a tournament is agreeing to when it publishes, which is the part worth being exact about.
 *
 * Every one of these is a rule in the protocol rather than a property of one client, which is why
 * they are stated as things QBLive does and not as things this build happens to do.
 */
const guarantees = [
  {
    title: 'Read-only, and unauthenticated',
    body: 'Every public QBLive route is a GET that takes no credential. A QBLive link is the ability to read one tournament and nothing else; it cannot change a schedule, a result, or a standing.',
  },
  {
    title: 'Nothing publishes ahead of its round',
    body: 'A game becomes public when its round is released or closed. Brackets and tiebreakers exist in Director long before they go on the wall, and even a bracket’s name is a disclosure, so an unreleased phase contributes no table.',
  },
  {
    title: 'Player names are a separate decision',
    body: 'Many of these tournaments are school events. Player names and individual statistics are off unless the tournament turns them on, and Director says plainly what turning them on makes public.',
  },
  {
    title: 'No invented times',
    body: 'A published start time is one the tournament committed to. QBLive shows no estimated, projected, or inferred time — a game with no committed time shows no time at all.',
  },
];

function ModelSection() {
  return (
    <section className="about-section about-split" aria-labelledby="model-heading">
      <div className="about-section-heading about-section-heading-narrow">
        <p className="about-kicker">The product model</p>
        <h2 id="model-heading">Where QBLive fits</h2>
        <p>
          Director runs the tournament. QBSheet scores the games. QBLive lets everyone follow along. QBLive is
          the last of the three and the only one that holds nothing.
        </p>
      </div>
      <dl className="about-definition-list">
        <div>
          <dt>Director</dt>
          <dd>
            Runs the tournament and decides what is public. Everything QBLive shows was published from
            tournament control. <a href={directorUrl}>About Director</a>.
          </dd>
        </div>
        <div>
          <dt>QBSheet</dt>
          <dd>
            Scores the games in the rooms and returns results to tournament control.{' '}
            <a href={scoringUrl}>What scoring a game involves</a>.
          </dd>
        </div>
        <div>
          <dt>QBLive</dt>
          <dd>
            Shows the published tournament to whoever has its link. It is a reader, not a participant in
            running the event.
          </dd>
        </div>
        <div>
          <dt>The QBLive protocol</dt>
          <dd>
            Open and vendor-neutral: a static host serving two JSON documents is a conforming QBLive server.{' '}
            <a href={qbliveDocsUrl}>Read the protocol</a>.
          </dd>
        </div>
      </dl>
    </section>
  );
}

function ScreenSection() {
  return (
    <section className="about-section about-screens" aria-labelledby="screens-heading">
      <div className="about-section-heading about-section-heading-narrow">
        <p className="about-kicker">What you see</p>
        <h2 id="screens-heading">Five screens, one tournament</h2>
        <p>
          QBLive opens on the team you follow, because that is what somebody standing in a hallway came to
          find out.
        </p>
      </div>
      <dl className="about-definition-list">
        {screens.map((screen) => (
          <div key={screen.term}>
            <dt>{screen.term}</dt>
            <dd>{screen.body}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function GuaranteeSection() {
  return (
    <div className="about-band">
      <section className="about-section about-assurances" aria-labelledby="public-heading">
        <div className="about-section-heading about-reveal">
          <h2 id="public-heading">Public, and careful about it</h2>
        </div>
        <div className="about-assurance-grid about-reveal">
          {guarantees.map((guarantee) => (
            <article key={guarantee.title}>
              <h3>{guarantee.title}</h3>
              <p>{guarantee.body}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export default function QbLive() {
  return (
    <div className="about-page">
      <PageHeader slug={slug} />

      <main>
        <section className="about-hero" aria-labelledby="qblive-title">
          <p className="about-kicker">QBLive</p>
          <h1 id="qblive-title">Follow the tournament as it happens.</h1>
          <p className="about-hero-copy">
            QBLive is the public view of a quiz bowl tournament: the schedule, the standings, the statistics,
            and the announcements that tournament control has published. It opens in an ordinary browser, and
            it is read-only.
          </p>
          <ActionLinks slug={slug} primary={open} secondary={repository} />
        </section>

        <ModelSection />

        <ScreenSection />

        <GuaranteeSection />

        <section className="about-section about-access" aria-labelledby="access-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Getting in</p>
            <h2 id="access-heading">Opening a tournament</h2>
          </div>
          <div className="about-prose">
            <p>
              A tournament is reached through the link it published — a URL or a printed QR code from
              tournament control. Open it, choose a team to follow, and optionally a player whose statistics
              you want highlighted. There is nothing to install and no account to create.
            </p>
            <p>
              The tournament&apos;s data comes from the server the tournament runs, not from us.{' '}
              <code>live.qbsheet.com</code> serves this client; a tournament&apos;s schedule, results, and
              standings never pass through anything QBSheet operates. Coming back later reopens the last
              tournament this device saw, with the last information it received and how old that information
              is, until the network returns.
            </p>
          </div>
        </section>

        <section className="about-final" aria-labelledby="qblive-cta-heading">
          <h2 id="qblive-cta-heading">Following a tournament today?</h2>
          <p>Open the link the tournament published and follow your team.</p>
          <ActionLinks slug={slug} primary={open} secondary={repository} />
        </section>
      </main>

      <PageFooter slug={slug} />
    </div>
  );
}
