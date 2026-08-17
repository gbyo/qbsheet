/**
 * What QBSheet stores and what it transmits.
 *
 * # A description, not a policy
 *
 * Standalone QBSheet transmits nothing: the whole application is a static site, and the only module in
 * this repository that makes a network request is `FruityServerClient`, which talks to the tournament
 * server the reader operates. There is no service here to make undertakings on behalf of, so the page
 * describes behaviour and storage rather than stating a policy. Every sentence can be checked against
 * the source, which is what the last section says.
 *
 * # The transmissions are stated, not only the absences
 *
 * A page listing only what does not happen would be incomplete about the one case where data leaves
 * the device. A connected room sends the scorekeeper's name and an opaque per-device identifier to the
 * tournament server, and both are documented here in a section of their own rather than left in
 * `docs/QBTCP.md` for somebody to find. The recipient is named as well, because it is the reader's own
 * server rather than anything this project runs.
 *
 * The section on web-server requests is deliberately general. Serving a file means a server receives a
 * request for it, and this page cannot describe the log configuration of a host it does not control —
 * a self-hosted copy is somebody else's infrastructure entirely. Stating that and pointing at
 * self-hosting is the accurate answer.
 *
 * # Nothing here is aspirational
 *
 * The absence of analytics is checkable: no telemetry, tag manager, or third-party script appears in
 * this repository, and the webfont is bundled from `@fontsource` rather than requested from a CDN, so
 * a loaded page issues no third-party request. On-device storage is `GameDatabase` and `GameStore`;
 * the retention windows are `completedGameRetentionMs` and `manualGameRetentionMs`, seven and thirty
 * days. The rule that no credential, device identifier, operator name, or server address enters a QBJ
 * document is the third rule of the QBTCP security model.
 */
import { ActionLinks, PageFooter, PageHeader, githubUrl, pageUrl, qbtcpDocsUrl } from './PageChrome';

const slug = 'privacy' as const;

const absences = [
  {
    title: 'No accounts',
    body: 'Scorekeepers do not sign in. There are no user records, email addresses, passwords, or profiles, for scorekeepers or for directors.',
  },
  {
    title: 'No analytics',
    body: 'No tracking, telemetry, tag manager, or third-party scripts. A loaded page makes no request to a third-party service, and the webfont is served with the site rather than from a CDN.',
  },
  {
    title: 'No application server',
    body: 'QBSheet is a static site. Standalone scoring makes no network requests, and this project runs no back end for game data to be sent to.',
  },
  {
    title: 'No cookies',
    body: 'QBSheet sets no cookies and shows no consent banner. What it stores is kept on the device for the room’s own use.',
  },
];

export default function Privacy() {
  return (
    <div className="about-page">
      <PageHeader slug={slug} />

      <main>
        <section className="about-hero" aria-labelledby="privacy-title">
          <h1 id="privacy-title">Privacy</h1>
          <p className="about-hero-copy">
            QBSheet has no user accounts, no analytics, and no application server. This page describes
            what the software stores on a device and what a connected room transmits.
          </p>
          <ActionLinks slug={slug} />
        </section>

        <div className="about-band">
          <section className="about-section about-assurances" aria-labelledby="absences-heading">
            <div className="about-section-heading about-reveal">
              <h2 id="absences-heading">Data not collected</h2>
            </div>
            <div className="about-assurance-grid about-reveal">
              {absences.map((absence) => (
                <article key={absence.title}>
                  <h3>{absence.title}</h3>
                  <p>{absence.body}</p>
                </article>
              ))}
            </div>
          </section>
        </div>

        <section className="about-section about-storage" aria-labelledby="storage-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">On the device</p>
            <h2 id="storage-heading">Data stored on the device</h2>
            <p>
              The following is stored in the browser of the device that scored the game and is
              readable only by that browser.
            </p>
          </div>
          <dl className="about-definition-list">
            <div>
              <dt>Games in progress</dt>
              <dd>
                Each accepted question, written as it is scored, so that a reload or a closed tab does
                not lose the round.
              </dd>
            </div>
            <div>
              <dt>Completed games</dt>
              <dd>
                Retained for seven days. Games entered manually are retained for thirty days.
              </dd>
            </div>
            <div>
              <dt>Settings</dt>
              <dd>
                The keyboard preference, progress through the guided practice game, and the tournament
                server a room last paired with.
              </dd>
            </div>
            <div>
              <dt>Removal</dt>
              <dd>
                Clearing the browser&apos;s data for the site removes the local copy from that browser.
                Connected tournament servers may retain data they have received under their operators’
                policies.
              </dd>
            </div>
          </dl>
        </section>

        <section className="about-section about-connected" aria-labelledby="connected-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Connected rooms</p>
            <h2 id="connected-heading">Data sent by a connected room</h2>
          </div>
          <div className="about-prose">
            <p>
              A room connected to tournament control communicates with the server the tournament
              operates. That server is not run by this project, and QBSheet retains no copy of what it
              receives.
            </p>
            <p>
              The room sends the game: the scoresheet as it is filled in, and the completed result. It
              also sends two further items. The scorekeeper&apos;s name, which tournament control
              displays in its view of the rooms, and an opaque per-device identifier, used to determine
              which device currently holds write access when two are open on one game.
            </p>
            <p>
              Neither is a user account. Credentials, device identifiers, operator names, and server
              addresses are not written into QBJ documents, log lines, or error messages, so an
              exported scoresheet carries no access to the tournament.{' '}
              <a href={qbtcpDocsUrl}>The protocol&apos;s security model</a> states these rules in full.
            </p>
            <p>A room that is not connected transmits none of this.</p>
          </div>
        </section>

        <section className="about-section about-hosting-note" aria-labelledby="hosting-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Hosting</p>
            <h2 id="hosting-heading">Requests to the web server</h2>
          </div>
          <div className="about-prose">
            <p>
              Loading a website causes a request to the server hosting it, and web servers commonly log
              requests. This applies to any deployment of QBSheet. The requests occur when the site
              loads; scoring itself transmits nothing.
            </p>
            <p>
              A self-hosted copy places those logs under your own control, because the site is static
              files on a host you choose. <a href={pageUrl(slug, 'self-host')}>Self-hosting guide</a>.
            </p>
          </div>
        </section>

        <section className="about-section about-verify" aria-labelledby="verify-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Source</p>
            <h2 id="verify-heading">Verifying this page</h2>
          </div>
          <div className="about-prose">
            <p>
              QBSheet is open source. Each statement above describes code that can be read: what is
              stored, what is transmitted, and the single module that makes network requests at all.{' '}
              <a href={githubUrl}>Read the source</a>.
            </p>
            <p>Report anything on this page that the code does not support.</p>
          </div>
        </section>

        <section className="about-final" aria-labelledby="privacy-cta-heading">
          <h2 id="privacy-cta-heading">Other questions</h2>
          <p>
            Devices, formats, files, and licensing are covered in the{' '}
            <a href={pageUrl(slug, 'faq')}>FAQ</a>.
          </p>
          <ActionLinks slug={slug} />
        </section>
      </main>

      <PageFooter slug={slug} />
    </div>
  );
}
