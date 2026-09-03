/**
 * The Director product page, which is a page about an application this website does not serve.
 *
 * # Why this page exists at all
 *
 * The production site used to ship Director itself, at `/director.html`, as a browser build beside
 * the scorer. That was useful while the desktop application was being built and it is wrong now that
 * it exists: the thing at that URL could plan a tournament and could not run one. The QBTCP listener
 * the scoring rooms pair with is a native network service, and the tournament's authoritative state
 * is a SQLite database in the application's own data directory — a browser tab has neither. See
 * `TournamentView`, which says so on screen ("Desktop app required to start the LAN server").
 *
 * So the entry is gone from the root build and this page took its place. Its first job is not to sell
 * anything; it is to stop a director from arriving at a URL, planning a Saturday in it, and finding
 * out at the venue that no room can connect. That is why the desktop-only statement is the section
 * immediately below the hero rather than a footnote near the download.
 *
 * # Same build-time rendering as every other page here
 *
 * Rendered to static HTML by `aboutPrerenderPlugin` in `vite.config.ts`, so there is no state, no
 * effect and no handler on it, and it is built out of the same `about-*` classes as `About`,
 * `Scoring` and `Tournaments` rather than a second set of its own.
 *
 * # Nothing here is aspirational
 *
 * Every claim traces to something in this repository today. The four workflow stages are Director's
 * own navigation groups (`src/director/app/navigation.ts`); the round operations are
 * `TournamentView`; the one-time room codes are the pairing panel and `apps/director/README.md`; the
 * transfer transports are `TransfersView`; the inbox statuses and retained submissions are
 * `ResultsView`; the exports are `PublishView`; the tiebreak-derived standings are `StandingsView`;
 * the local database is `DirectorRepository` and `commands.rs`; and the durable outbox and QBLive's
 * optionality are `docs/QBLIVE.md`.
 *
 * What is deliberately *not* claimed: any installer URL (there is no release signing key yet, so the
 * action points at the releases index), signed automatic updates (`createUpdaterArtifacts` is
 * disabled), and any quiz bowl format. Director configures a format; it does not have one.
 */
import type { ReactNode } from 'react';
import {
  ActionLinks,
  PageFooter,
  PageHeader,
  directorDocsUrl,
  githubUrl,
  licenseUrl,
  pageUrl,
  qbjDocsUrl,
  qbtcpDocsUrl,
  releasesUrl,
} from './PageChrome';

const slug = 'director' as const;

/** Relative, because this page does not know what directory the deployment put it in. */
const qbliveUrl = pageUrl(slug, 'qblive');
const tournamentsUrl = pageUrl(slug, 'tournaments');

/** The primary action, and the reason it is not `Open Director`. See `releasesUrl`. */
const download = { href: releasesUrl, label: 'Download Director', external: true } as const;
const repository = { href: githubUrl, label: 'View on GitHub', external: true } as const;

/**
 * The tournament, in the order a director meets it.
 *
 * Four stages rather than a feature grid, and they are Director's own four: `Plan`, `Run` and
 * `Review` are the groups in its navigation sidebar, with collecting results split out of running
 * because it is the part that happens whether or not the network held.
 */
const stages: { number: string; name: string; idea: string; detail: ReactNode }[] = [
  {
    number: '01',
    name: 'Set up',
    idea: 'Plan the tournament.',
    detail:
      'Enter the tournament, its teams and rosters, the format and its phases, the rooms and the staff in them, and the packets. Director generates the schedule from the format, the confirmed teams, and the available rooms.',
  },
  {
    number: '02',
    name: 'Run',
    idea: 'Run the rounds.',
    detail: (
      <>
        Prepare, release, monitor, and close each round from one view. Director serves QBTCP on the
        venue&apos;s network, and every room is invited with a one-time code scoped to that room alone.{' '}
        <a href={tournamentsUrl}>What a connected room does</a>.
      </>
    ),
  },
  {
    number: '03',
    name: 'Collect',
    idea: 'Take the results in.',
    detail:
      'Completed games arrive over QBTCP, or on a USB drive, a shared folder, or a download when the network cannot be relied on. Each one waits in the results inbox to be accepted or rejected, and the submission as it arrived is kept.',
  },
  {
    number: '04',
    name: 'Publish',
    idea: 'Publish what people need.',
    detail: (
      <>
        Standings and player statistics are derived from accepted results and the tournament&apos;s tiebreak
        configuration. Export printable standings, CSV, QBJ, an SQBS roster, or a portable archive — or
        publish the tournament to <a href={qbliveUrl}>QBLive</a> for participants.
      </>
    ),
  },
];

/**
 * What a director is actually deciding, which is whether this survives a bad Saturday.
 *
 * Four properties rather than a longer list, because these are the four that the venue tests: where
 * the tournament lives, what happens when the uplink dies, what publishing can cost you, and what
 * happens after a result was accepted and turns out to be wrong.
 */
const assurances = [
  {
    title: 'The tournament is on your computer',
    body: 'Director keeps the tournament in a local database in its own application data directory. It is not a client of a service we run, there is no account, and no part of running the event depends on reaching us.',
  },
  {
    title: 'Rounds do not need the internet',
    body: 'Rooms pair with Director over the venue’s own network. QBTCP is traffic between the scoring devices and the machine in front of you, so a failed venue uplink is not a failed round.',
  },
  {
    title: 'Publishing cannot block the tournament',
    body: 'Publishing to QBLive is optional and is never required for scoring, scheduling, result acceptance, advancement, statistics, or recovery. Director writes locally first and publishes afterwards from a durable outbox that retries.',
  },
  {
    title: 'A wrong result is correctable',
    body: 'An accepted result can be corrected, and the result it replaced stays in the tournament’s audit history. An exported tournament carries that history and its schema version with it.',
  },
];

/**
 * The desktop-only statement, in a band, immediately after the hero.
 *
 * The tint is doing the work a warning box would do on a site that had warning boxes. This page has
 * one job before it has any other, and a reader who takes nothing else from it should take this.
 */
function DesktopOnlySection() {
  return (
    <div className="about-band">
      <section className="about-section about-desktop-only" aria-labelledby="desktop-heading">
        <div className="about-section-heading about-section-heading-narrow">
          <p className="about-kicker">Before the event</p>
          <h2 id="desktop-heading">Director is a desktop application.</h2>
        </div>
        <div className="about-prose">
          <p>
            Install Director on the computer that will run the tournament, and open it once before the event
            rather than on the morning of it. There is no web version and this website does not run it: the
            tournament&apos;s authoritative state is a database in Director&apos;s own application data
            directory, and the QBTCP listener that scoring rooms pair with is a network service on that
            machine. Neither is something a browser tab can provide.
          </p>
          <p>
            The scorers are the other half, and they are the web application. Rooms open QBSheet in a browser
            and connect to the Director machine; nothing is installed in a room.
          </p>
        </div>
      </section>
    </div>
  );
}

/** Who owns what, which is the first thing to be clear about and the easiest to get wrong. */
function ScopeSection() {
  return (
    <section className="about-section about-split" aria-labelledby="scope-heading">
      <div className="about-section-heading about-section-heading-narrow">
        <p className="about-kicker">Scope</p>
        <h2 id="scope-heading">One system, three parts</h2>
        <p>
          Director runs the tournament. QBSheet scores the games. QBLive lets everyone follow along. Director
          is the only one of the three that holds the tournament&apos;s state.
        </p>
      </div>
      <dl className="about-definition-list">
        <div>
          <dt>Director</dt>
          <dd>
            The desktop application. Owns the schedule, the room assignments, the accepted results, the
            standings, and the statistics.
          </dd>
        </div>
        <div>
          <dt>QBSheet</dt>
          <dd>
            The browser scoresheet in each room. Scores one game at a time and keeps working when the network
            does not. <a href={tournamentsUrl}>QBSheet for tournaments</a>.
          </dd>
        </div>
        <div>
          <dt>QBLive</dt>
          <dd>
            The public, read-only view of a tournament Director has published. Optional.{' '}
            <a href={qbliveUrl}>What QBLive shows</a>.
          </dd>
        </div>
        <div>
          <dt>QBTCP and QBJ</dt>
          <dd>
            The open protocol between Director and the rooms, and the open document format the tournament
            travels in. <a href={qbtcpDocsUrl}>Read the protocol</a> or{' '}
            <a href={qbjDocsUrl}>the QBJ profile</a>.
          </dd>
        </div>
      </dl>
    </section>
  );
}

function WorkflowSection() {
  return (
    <section className="about-section about-flow" aria-labelledby="workflow-heading">
      <div className="about-section-heading about-flow-heading about-reveal">
        <p className="about-kicker">Tournament day</p>
        <h2 id="workflow-heading">Set up, run, collect, publish</h2>
        <p>Director follows the tournament from the plan to the final standings.</p>
      </div>
      <ol className="about-stages about-stages-wide">
        {stages.map((stage) => (
          <li key={stage.number}>
            <h3 className="about-stage-name">
              <span className="about-stage-number" aria-hidden="true">
                {stage.number}
              </span>
              {stage.name}
            </h3>
            <p className="about-stage-idea">{stage.idea}</p>
            <p className="about-stage-detail">{stage.detail}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AssuranceSection() {
  return (
    <div className="about-band">
      <section className="about-section about-assurances" aria-labelledby="local-heading">
        <div className="about-section-heading about-reveal">
          <h2 id="local-heading">Local control, by design</h2>
        </div>
        <div className="about-assurance-grid about-reveal">
          {assurances.map((assurance) => (
            <article key={assurance.title}>
              <h3>{assurance.title}</h3>
              <p>{assurance.body}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export default function Director() {
  return (
    <div className="about-page">
      <PageHeader slug={slug} />

      <main>
        <section className="about-hero" aria-labelledby="director-title">
          <p className="about-kicker">QBSheet Director</p>
          <h1 id="director-title">Tournament control that stays with you.</h1>
          <p className="about-hero-copy">
            Director is the desktop application for setting up, running, reviewing, and publishing a quiz bowl
            tournament. It runs on the computer in front of you, and the tournament stays there.
          </p>
          <ActionLinks slug={slug} primary={download} secondary={repository} />
        </section>

        <DesktopOnlySection />

        <ScopeSection />

        <WorkflowSection />

        <AssuranceSection />

        <section className="about-section about-requirements" aria-labelledby="install-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Getting Director</p>
            <h2 id="install-heading">Installing it</h2>
          </div>
          <dl className="about-definition-list">
            <div>
              <dt>Releases</dt>
              <dd>
                Builds are published on GitHub. <a href={releasesUrl}>Open the releases page</a>.
              </dd>
            </div>
            <div>
              <dt>From source</dt>
              <dd>
                Director is a Tauri application under <code>apps/director</code> with its own build commands.{' '}
                <a href={directorDocsUrl}>Read the Director build notes</a>.
              </dd>
            </div>
            <div>
              <dt>The tournament network</dt>
              <dd>
                Rooms reach Director over the venue&apos;s network rather than the internet. Serve the scorer
                over HTTPS so rooms keep their offline shell.
              </dd>
            </div>
            <div>
              <dt>Open source</dt>
              <dd>
                Director is part of the QBSheet repository and licensed under the GNU AGPL.{' '}
                <a href={licenseUrl}>Read the license</a>.
              </dd>
            </div>
          </dl>
        </section>

        <section className="about-final" aria-labelledby="director-cta-heading">
          <h2 id="director-cta-heading">Run the next one from your own machine.</h2>
          <p>Install Director on the tournament computer before the event.</p>
          <ActionLinks slug={slug} primary={download} secondary={repository} />
        </section>
      </main>

      <PageFooter slug={slug} />
    </div>
  );
}
