import BrandLogo from '../BrandLogo';
import productImage from '../assets/about-qbsheet-practice.webp';

const githubUrl = 'https://github.com/gbyo/qbsheet';
const qbjDocsUrl = `${githubUrl}/blob/main/docs/QBJ_ASSIGNMENT_PROFILE.md`;
const qbtcpDocsUrl = `${githubUrl}/blob/main/docs/QBTCP.md`;

function ActionLinks() {
  return (
    <div className="about-actions">
      <a className="about-button is-primary" href="../">
        Open QBSheet
      </a>
      <a className="about-button" href={githubUrl}>
        View on GitHub
      </a>
    </div>
  );
}

export default function About() {
  return (
    <div className="about-page">
      <header className="about-header">
        <div className="about-header-inner">
          <a className="about-brand" href="../" aria-label="QBSheet home">
            <BrandLogo className="about-brand-logo" />
          </a>
          <nav className="about-nav" aria-label="Primary navigation">
            <a href="../">Open QBSheet</a>
            <a href={githubUrl}>GitHub</a>
          </nav>
        </div>
      </header>

      <main>
        <section className="about-hero" aria-labelledby="about-title">
          <h1 id="about-title">The simpler way to keep score.</h1>
          <p className="about-hero-copy">
            QBSheet keeps quiz bowl scoring fast, flexible, and out of your way, whether you’re connected or
            offline.
          </p>
          <ActionLinks />
        </section>

        <figure className="about-product-visual">
          <img
            src={productImage}
            width="2200"
            height="1430"
            alt="QBSheet scoring a tied practice game between Ninety Six and Greenwood"
            fetchPriority="high"
          />
          <figcaption>The real QBSheet scoring interface, shown during a guided practice game.</figcaption>
        </figure>

        <section className="about-section" aria-labelledby="rooms-heading">
          <div className="about-section-heading">
            <p className="about-kicker">At the table</p>
            <h2 id="rooms-heading">Built for real tournament rooms</h2>
          </div>
          <div className="about-feature-grid">
            <article>
              <h3>Works offline</h3>
              <p>Once loaded, QBSheet keeps working even if the network drops.</p>
            </article>
            <article>
              <h3>Flexible setup</h3>
              <p>Open a game file, connect to tournament control, or create a game manually.</p>
            </article>
            <article>
              <h3>Made for quiz bowl</h3>
              <p>Supports powers, negs, bonuses, substitutions, and configurable scoring rules.</p>
            </article>
            <article>
              <h3>Safe and dependable</h3>
              <p>Games are saved locally as you score, with QBJ backups and recovery support.</p>
            </article>
          </div>
        </section>

        <section className="about-section" aria-labelledby="workflows-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Three ways in</p>
            <h2 id="workflows-heading">Use it your way</h2>
            <p>
              Run QBSheet standalone, open assigned games from QBJ files, or connect live to compatible
              tournament-control software using QBTCP.
            </p>
          </div>
          <div className="about-workflows">
            <article>
              <h3>Create a game</h3>
              <p>Enter the teams, players, and rules directly in QBSheet.</p>
            </article>
            <article>
              <h3>Open QBJ</h3>
              <p>Open a game assignment or tournament file supplied by tournament staff.</p>
            </article>
            <article>
              <h3>Connect to tournament control</h3>
              <p>Receive assignments and return results through compatible QBTCP software.</p>
            </article>
          </div>
        </section>

        <section className="about-section about-editorial" aria-labelledby="standalone-heading">
          <div>
            <p className="about-kicker">Standalone scoring</p>
            <h2 id="standalone-heading">Not just for tournaments</h2>
          </div>
          <p className="about-editorial-copy">
            Enter teams, players, and scoring rules yourself for practices, scrimmages, tryouts, or pickup
            games. No tournament-control software required.
          </p>
        </section>

        <section className="about-section about-open" aria-labelledby="open-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Interoperable by design</p>
            <h2 id="open-heading">Open and straightforward</h2>
            <p>One scoresheet, built around established quiz bowl formats and a readable source codebase.</p>
          </div>
          <dl className="about-definition-list">
            <div>
              <dt>QBJ</dt>
              <dd>
                QBSheet reads and writes Quiz Bowl JSON files.{' '}
                <a href={qbjDocsUrl}>Read the QBJ documentation</a>.
              </dd>
            </div>
            <div>
              <dt>QBTCP</dt>
              <dd>
                QBSheet uses QBTCP for live communication with compatible tournament-control software.{' '}
                <a href={qbtcpDocsUrl}>Read the protocol overview</a>.
              </dd>
            </div>
            <div>
              <dt>Open source</dt>
              <dd>
                QBSheet is available under the GNU AGPL. <a href={githubUrl}>View the source on GitHub</a>.
              </dd>
            </div>
          </dl>
        </section>

        <section className="about-final" aria-labelledby="ready-heading">
          <h2 id="ready-heading">Ready to score?</h2>
          <p>Open QBSheet and start with the game in front of you.</p>
          <ActionLinks />
        </section>
      </main>

      <footer className="about-footer">
        <nav aria-label="Footer navigation">
          <a href="../">QBSheet</a>
          <a href="./" aria-current="page">About</a>
          <a href={`${githubUrl}#documentation`}>Documentation</a>
          <a href={githubUrl}>GitHub</a>
        </nav>
      </footer>
    </div>
  );
}
