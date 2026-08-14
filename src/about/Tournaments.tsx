/**
 * Connected scoring, documented for the person running the tournament.
 *
 * # What this page is for
 *
 * The product page states that QBSheet connects to tournament control. This page states what that
 * involves: what the director has to run, what the four steps of a connected round are, and how the
 * software behaves when the connection fails. Those are the facts a schedule is planned around.
 *
 * # Scope is stated first
 *
 * QBSheet scores one room. The schedule, the room assignments and the tournament's statistics belong
 * to tournament-control software, and connected scoring requires the director to be running one.
 * Leaving that to be inferred would mislead a reader into installing half a tournament, so it is the
 * first section rather than a caveat later on. `docs/QBTCP.md` states the same division in its
 * "Ownership of each concern" table.
 *
 * # Every claim is a documented protocol requirement
 *
 * The failure behaviour is not a description of this build alone. Each statement corresponds to a MUST
 * in the "Durability requirements for a scoresheet" section of `docs/QBTCP.md`: the assignment is
 * persisted before scoring depends on a further network call, a locally accepted event is durable
 * before it is delivered, `401`/`403`/`410` do not destroy the game, a reload restores from local
 * state, snapshots coalesce, and a connected final still offers a manual download. The takeover
 * paragraph is "Writer ownership and takeover", including the requirement that a person starts it.
 *
 * # Register
 *
 * Declarative, and specific about what is configured where. No invented scenarios and no claims about
 * how many events use QBSheet or what hardware they use, because neither is something this repository
 * knows.
 */
import {
  ActionLinks,
  PageFooter,
  PageHeader,
  pageUrl,
  qbjDocsUrl,
  qbtcpDocsUrl,
} from './PageChrome';

const slug = 'tournaments' as const;

/**
 * The four steps of a connected round.
 *
 * Four rather than the product page's three, because a connected round has a step before scoring: the
 * room has to pair before it can be assigned a game.
 */
const stages = [
  {
    number: '01',
    name: 'Pair',
    idea: 'The room joins the tournament.',
    detail:
      'A scorekeeper enters the server address and the pairing code for the room. QBSheet exchanges the code for a credential scoped to that room. There are no user accounts and nothing to sign in to.',
  },
  {
    number: '02',
    name: 'Receive',
    idea: 'The assignment arrives.',
    detail:
      'Tournament control returns the room’s current assignment as a QBJ document. QBSheet stores it on the device before scoring depends on any further network call.',
  },
  {
    number: '03',
    name: 'Score',
    idea: 'The room scores the game.',
    detail:
      'Scoring runs on the device. While the server is reachable, QBSheet sends snapshots of the current game state, which tournament control can display.',
  },
  {
    number: '04',
    name: 'Return',
    idea: 'The result is submitted.',
    detail:
      'QBSheet submits the completed game to the server as QBJ. A retry after a timeout is identified as the same result rather than recorded as a second game.',
  },
];

/** How the software behaves when the network or the server fails. */
const failures = [
  {
    title: 'Network loss during a round',
    body: 'Scoring continues. The assignment and every accepted question are already on the device. Snapshots resume when the connection returns, and the room sends its current state rather than replaying the updates it missed.',
  },
  {
    title: 'A second device on the same game',
    body: 'One device holds write access to a session at a time. Another device can take it over. A takeover is started by a person rather than resolved automatically between devices, and the previous writer is notified at its next write instead of being overwritten silently.',
  },
  {
    title: 'The server rejects the room',
    body: 'An expired credential, a disallowed origin, or an assignment superseded by a newer revision does not unmount the scorer or discard scored work. The room continues scoring locally and the result remains available for download.',
  },
  {
    title: 'A result is not accepted',
    body: 'Games remain on the device that scored them and stay downloadable as QBJ. Acceptance by the server is not a reason for a room to delete its local copy.',
  },
];

function ScopeSection() {
  return (
    <section className="about-section about-split" aria-labelledby="scope-heading">
      <div className="about-section-heading about-section-heading-narrow">
        <p className="about-kicker">Scope</p>
        <h2 id="scope-heading">QBSheet and tournament control</h2>
        <p>
          QBSheet scores the game in one room. The schedule, the room assignments, and the
          tournament&apos;s statistics belong to tournament-control software. Connected scoring
          requires tournament-control software that implements QBTCP.
        </p>
      </div>
      <dl className="about-definition-list">
        <div>
          <dt>Tournament control</dt>
          <dd>Owns the schedule, assigns teams to rooms, and collects results into the tournament&apos;s statistics.</dd>
        </div>
        <div>
          <dt>QBSheet</dt>
          <dd>Scores the game in one room, and continues to work without a network connection.</dd>
        </div>
        <div>
          <dt>QBTCP</dt>
          <dd>
            The protocol between them. It is an open specification, and no product owns it.{' '}
            <a href={qbtcpDocsUrl}>Read the specification</a>.
          </dd>
        </div>
        <div>
          <dt>QBJ</dt>
          <dd>
            The document format for game and tournament data. An assignment sent over the network is
            the same document tournament control could write to disk. <a href={qbjDocsUrl}>Read the profile</a>.
          </dd>
        </div>
      </dl>
    </section>
  );
}

function RoundSection() {
  return (
    <section className="about-section about-flow" aria-labelledby="round-heading">
      <div className="about-section-heading about-flow-heading about-reveal">
        <p className="about-kicker">Connected rounds</p>
        <h2 id="round-heading">A connected round</h2>
        <p>Each room follows the same four steps.</p>
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

function FailureSection() {
  return (
    <div className="about-band">
      <section className="about-section about-assurances" aria-labelledby="failures-heading">
        <div className="about-section-heading about-reveal">
          <h2 id="failures-heading">Connection failures</h2>
        </div>
        <div className="about-assurance-grid about-reveal">
          {failures.map((failure) => (
            <article key={failure.title}>
              <h3>{failure.title}</h3>
              <p>{failure.body}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export default function Tournaments() {
  return (
    <div className="about-page">
      <PageHeader slug={slug} />

      <main>
        <section className="about-hero" aria-labelledby="tournaments-title">
          <h1 id="tournaments-title">QBSheet for tournaments</h1>
          <p className="about-hero-copy">
            QBSheet connects to tournament-control software over QBTCP. Rooms score in a browser,
            continue scoring when the server is unreachable, and return results as QBJ.
          </p>
          <ActionLinks
            slug={slug}
            primary={{ href: qbtcpDocsUrl, label: 'Read the protocol', external: true }}
          />
        </section>

        <ScopeSection />

        <RoundSection />

        <FailureSection />

        <section className="about-section about-requirements" aria-labelledby="requirements-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Setup</p>
            <h2 id="requirements-heading">Requirements</h2>
          </div>
          <dl className="about-definition-list">
            <div>
              <dt>Tournament-control software</dt>
              <dd>
                Software that implements QBTCP, reachable from the rooms. QBSheet connects to the
                server you run.
              </dd>
            </div>
            <div>
              <dt>A browser per room</dt>
              <dd>
                A current browser on any device. Nothing is installed, and a room that has loaded
                QBSheet once can score without a network connection.
              </dd>
            </div>
            <div>
              <dt>A secure origin</dt>
              <dd>
                Serve QBSheet over HTTPS. Offline support uses a service worker, which browsers
                install only on a secure origin.{' '}
                <a href={pageUrl(slug, 'self-host')}>Self-hosting guide</a>.
              </dd>
            </div>
            <div>
              <dt>Pairing codes</dt>
              <dd>
                Issued by your tournament-control software. A code pairs one room and is exchanged
                for a credential that reaches that room only.
              </dd>
            </div>
          </dl>
        </section>

        <section className="about-section about-fallback" aria-labelledby="fallback-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Without a server</p>
            <h2 id="fallback-heading">Scoring without a connection</h2>
          </div>
          <div className="about-prose">
            <p>
              Connected scoring is one of three ways to start a game. A room that cannot reach the
              server can open a QBJ file or enter the teams, players, and scoring rules directly, and
              scores the game with the same scoresheet, the same corrections, and the same QBJ export.
            </p>
            <p>
              A game started this way is not connected, so its result is handed over as a downloaded
              file rather than submitted. <a href={pageUrl(slug, 'scoring')}>What scoring a game involves</a>.
            </p>
          </div>
        </section>

        <section className="about-final" aria-labelledby="tournaments-cta-heading">
          <h2 id="tournaments-cta-heading">Try QBSheet before the tournament</h2>
          <p>QBSheet includes a guided practice game that runs without a tournament server.</p>
          <ActionLinks slug={slug} />
        </section>
      </main>

      <PageFooter slug={slug} />
    </div>
  );
}
