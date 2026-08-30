/**
 * The public product page.
 *
 * # This component never runs in a browser
 *
 * It is rendered to static HTML at build time by `aboutPrerenderPlugin` in `vite.config.ts`, and the
 * deployed page ships that HTML with no React behind it. So it holds no state, no effects and no
 * event handlers: everything interactive about this page is a link, and the one piece of behaviour —
 * the scroll reveals — is thirty lines of `reveal.ts` that finds its targets by class name.
 *
 * Keeping it a React component anyway is worth it for one reason. The wordmark, the type scale, the
 * tokens and the button are the scorer's, and a hand-written HTML file would be a second copy of all
 * of them that nothing keeps in step. Rendering the real component means the page cannot drift from
 * the application it is advertising, and it means the copy below is unit-testable.
 *
 * # Written for the person deciding whether to use it
 *
 * The reader this page is composed for is a tournament director deciding whether sixteen rooms can be
 * asked to use it, or a scorekeeper deciding whether it fits a practice table. So the middle of the page
 * is the scoring workflow in the order the scorekeeper meets it: start with a game, score it, finish
 * with a result. Start deliberately covers all three ways in: open a QBJ assignment, connect to
 * tournament control, or create a game yourself. That is one sequence rather than a feature list, and
 * it is laid out as one — three stages on a rule — because a reader looking at a grid of capabilities
 * still has to work out which of them happen in what order.
 *
 * What follows it is the set of properties that decision actually turns on, and it is a section of its
 * own rather than a fourth stage of the sequence.
 *
 * # No claim here is aspirational
 *
 * Every sentence below describes behaviour this repository implements today, and the ones that name a
 * format name it as narrowly as the code does. Nothing on this page may assume powers, negs, a bonus
 * shape, a roster size, or a substitution model, because `IScorekeeperFormat` assumes none of them and
 * a tournament whose format the copy quietly excluded is a tournament that reads this page and leaves.
 */
import productImage from '../assets/about-qbsheet-practice.webp';
import {
  ActionLinks,
  PageFooter,
  PageHeader,
  githubUrl,
  pageUrl,
  qbjDocsUrl,
  qbtcpDocsUrl,
} from './PageChrome';

const slug = '' as const;

/** Relative, because this page does not know what directory the deployment put it in. */
const selfHostUrl = pageUrl(slug, 'self-host');

/**
 * React 18 does not recognise `fetchPriority` and drops it with a warning, so it is spread in as the
 * lower-case HTML attribute. It matters more now than it did: the image is in the served HTML, where
 * the preload scanner finds it before any script runs, and it is this page's largest paint.
 */
const highFetchPriority = { fetchpriority: 'high' };

/**
 * The three stages of a game, in the order the scorekeeper meets them.
 *
 * `detail` is deliberately conditional where the implementation is. A game may come from a QBJ
 * assignment, tournament control, or manual setup, and QBSheet asks for the rest (`RosterSetup`,
 * `ScoringRulesSetup`) when needed. The copy names all three ways in without promising that an
 * assignment contains fields a generic QBJ may not have. Tournament control is one path, never a
 * requirement, and a finished result remains useful without it.
 */
const stages = [
  {
    number: '01',
    name: 'Start',
    idea: 'Start with a game.',
    detail:
      'Open a QBJ assignment, connect QBSheet to tournament control, or create a game yourself for practice, scrimmages, and tryouts. QBSheet asks for the teams, players, and scoring rules it still needs.',
  },
  {
    number: '02',
    name: 'Score',
    idea: 'Score the game.',
    detail:
      'The scorekeeper gets a scoresheet built around the game they started, with the setup in place before scoring begins.',
  },
  {
    number: '03',
    name: 'Finish',
    idea: 'Keep the finished result.',
    detail:
      'When the game is over, QBSheet keeps the result on the device. Connected games can be sent back to tournament control; any game can be downloaded as QBJ.',
  },
];

/** The four things a director asks about a scoresheet before putting it in sixteen rooms. */
const assurances = [
  {
    title: 'No internet required',
    body: 'Scoring happens on the device. Once a game is open, losing the network does not stop the room, and a reload restores from local state rather than from a server.',
  },
  {
    title: 'Less setup at the table',
    body: 'QBSheet asks only for what the assignment left out. A document that named the teams, the players and the rules leaves nothing for the room to re-enter.',
  },
  {
    title: 'Your format, not ours',
    body: 'Configure scoring and lineup rules around the tournament instead of forcing the tournament around the scoresheet. QBSheet never infers a format from the name of a rule set.',
  },
  {
    title: 'Recovery built in',
    body: 'Every accepted question is written to the device as it is scored, and a finished game stays there, downloadable as QBJ, for days after it was handed over.',
  },
];

/**
 * The workflow, which is the one sequence on the page.
 *
 * The rule above each stage is drawn before that stage's words appear, and the three are sequenced, so
 * the section is read left to right once rather than landing all at once. It is the only place here
 * where the motion carries an idea — direction — and it is still under 700ms. `about.css` owns the
 * timing; `reveal.ts` only decides when it starts.
 */
function WorkflowStages() {
  return (
    <ol className="about-stages">
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
  );
}

/** The workflow, and nothing else. It ends where the three stages end. */
function WorkflowSection() {
  return (
    <section className="about-section about-flow" aria-labelledby="scoring-heading">
      <div className="about-section-heading about-flow-heading about-reveal">
        <p className="about-kicker">From start to finish</p>
        <h2 id="scoring-heading">Built around how you actually score</h2>
        <p>From the first setup to the final result, QBSheet fits the way you already score.</p>
      </div>
      <WorkflowStages />
    </section>
  );
}

/**
 * The four things a director asks, on their own.
 *
 * These used to sit under the workflow, and sharing a section with it made both harder to read: a
 * sequence and a set of properties are different kinds of thing, and a reader arriving at a ruled grid
 * immediately below three numbered stages has to work out that the grid is not a fourth stage. So they
 * are a section, and the tint is what says so before anybody reads a word of them.
 *
 * No rules between them either. They are four independent claims with nothing to compare across, and a
 * table grid on a set like that is a border doing the work whitespace already did.
 */
function AssuranceSection() {
  return (
    <div className="about-band">
      <section className="about-section about-assurances" aria-labelledby="tournament-day-heading">
        <div className="about-section-heading about-reveal">
          <h2 id="tournament-day-heading">Made for tournament day</h2>
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

export default function About() {
  return (
    <div className="about-page">
      <PageHeader slug={slug} />

      <main>
        <section className="about-hero" aria-labelledby="about-title">
          <h1 id="about-title">The simpler way to keep score.</h1>
          <p className="about-hero-copy">
            QBSheet keeps quiz bowl scoring fast, flexible, and out of your way, whether you’re connected or
            offline.
          </p>
          <ActionLinks slug={slug} />
        </section>

        <figure className="about-product-visual">
          <img
            src={productImage}
            width="2200"
            height="1430"
            alt="QBSheet scoring a tied practice game between Ninety Six and Greenwood"
            {...highFetchPriority}
          />
          <figcaption>The real QBSheet scoring interface, shown during a guided practice game.</figcaption>
        </figure>

        <WorkflowSection />

        <AssuranceSection />

        <section className="about-section about-open" aria-labelledby="open-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">OPEN BY DESIGN</p>
            <h2 id="open-heading">Your games aren&apos;t locked into QBSheet.</h2>
            <p>
              QBSheet uses open formats and an open protocol, so tournament data can move between the
              scoresheet and compatible tournament software.
            </p>
          </div>
          <dl className="about-definition-list">
            <div>
              <dt>QBJ</dt>
              <dd>
                Portable files for assignments, games, and results.{' '}
                <a href={qbjDocsUrl}>Read the QBJ documentation</a>.
              </dd>
            </div>
            <div>
              <dt>QBTCP</dt>
              <dd>
                Live communication with compatible tournament-control software.{' '}
                <a href={qbtcpDocsUrl}>Read the protocol overview</a>.
              </dd>
            </div>
            <div>
              <dt>Open source</dt>
              <dd>
                QBSheet is licensed under the GNU AGPL. <a href={githubUrl}>View the source on GitHub</a>.
              </dd>
            </div>
            <div>
              <dt>Self-hosting</dt>
              <dd>
                Run your own copy on any static host. <a href={selfHostUrl}>Read the self-hosting guide</a>.
              </dd>
            </div>
          </dl>
        </section>

        <section className="about-final" aria-labelledby="ready-heading">
          <h2 id="ready-heading">Ready to score?</h2>
          <p>Open QBSheet and start with the game in front of you.</p>
          <ActionLinks slug={slug} />
        </section>
      </main>

      <PageFooter slug={slug} />
    </div>
  );
}
