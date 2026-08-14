/**
 * What using the scoresheet involves, documented for the person who will operate it.
 *
 * # What this page is for
 *
 * The other pages are written for somebody choosing QBSheet. This one is written for somebody who
 * will use it: what the per-question loop is, what the keyboard does, how corrections and lineup
 * changes work, and what happens at the end of a game. It is reference material for a scorekeeper
 * before a tournament, not an argument for adopting the software.
 *
 * # The keyboard is described without naming a ruling
 *
 * `KeyboardScoring` resolves every action through `tossupRulings`, so the meaning of the second key is
 * whatever the tournament's format defines, and a format with no such ruling leaves that key inert.
 * Documenting the layout as a seat followed by an outcome is therefore the accurate description as
 * well as the one that does not narrow QBSheet to a particular rule set. `ScoringPage.test.tsx`
 * asserts the absence of the format assumptions by name.
 *
 * # Nothing here is aspirational
 *
 * Seat numbering and the two-key sequence are `keyboardSeatNumbers` and `keyboardActionLabels`; the
 * undo bindings are `keyboardShortcutLabels`. Corrections to an earlier question are
 * `questionCorrection`, lineup changes are `LineupEditing`, and when substitutions are permitted is
 * the tournament's `IRoomProcedure` rather than anything this page assumes. The synchronous write on
 * every accepted event is `GameStore`, which is explicit that it happens in the same turn as the
 * click. Guided practice is `PracticeScreen`, and the drill is `KeyboardDrill`.
 */
import { ActionLinks, PageFooter, PageHeader, pageUrl, scorerUrl } from './PageChrome';

const slug = 'scoring' as const;

/** The per-question loop. The third step is conditional because the implementation makes it so. */
const stages = [
  {
    number: '01',
    name: 'Record the answer',
    idea: 'Who answered, and what happened.',
    detail:
      'Enter the player and the outcome, either with two keys — the seat number, then the outcome — or with the on-screen controls. The available outcomes come from the tournament’s scoring rules.',
  },
  {
    number: '02',
    name: 'Resolve the tossup',
    idea: 'Another team answers, or the question goes dead.',
    detail:
      'QBSheet tracks which actions remain valid for the question and does not accept a combination the rules do not allow.',
  },
  {
    number: '03',
    name: 'Score the bonus',
    idea: 'If the format uses bonuses.',
    detail:
      'When the format defines bonuses, QBSheet prompts for the parts as that format structures them. When it does not, the step does not appear.',
  },
];

/** Corrections and local recovery, which is most of what a scorekeeper needs to know in advance. */
const recoveries = [
  {
    title: 'Undo and redo',
    body: 'Ctrl/⌘ + Z steps back through accepted operations, and Ctrl/⌘ + Shift + Z steps forward again. Undo applies to the last operation rather than to the game as a whole.',
  },
  {
    title: 'Correcting an earlier question',
    body: 'Any question in the round can be reopened and edited at any point: which players answered, what the answers were worth, and the bonus. The scoresheet recalculates from the correction, and the correction is recorded rather than replacing the original silently.',
  },
  {
    title: 'Lineup changes',
    body: 'Lineup changes during a game are recorded as part of the scoresheet. When substitutions are permitted is set by the tournament’s room procedure, and QBSheet enforces the procedure the tournament configured rather than a default of its own.',
  },
  {
    title: 'Local recovery',
    body: 'Each accepted question is written to the device as it is scored, in the same operation rather than afterwards. Reopening QBSheet after a closed tab, a reload, or a lost connection restores the game.',
  },
];

function LoopSection() {
  return (
    <section className="about-section about-flow" aria-labelledby="loop-heading">
      <div className="about-section-heading about-flow-heading about-reveal">
        <p className="about-kicker">Per question</p>
        <h2 id="loop-heading">Scoring a tossup</h2>
        <p>The same sequence for every question in the round.</p>
      </div>
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
    </section>
  );
}

function RecoverySection() {
  return (
    <div className="about-band">
      <section className="about-section about-assurances" aria-labelledby="corrections-heading">
        <div className="about-section-heading about-reveal">
          <h2 id="corrections-heading">Corrections and recovery</h2>
        </div>
        <div className="about-assurance-grid about-reveal">
          {recoveries.map((recovery) => (
            <article key={recovery.title}>
              <h3>{recovery.title}</h3>
              <p>{recovery.body}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export default function Scoring() {
  return (
    <div className="about-page">
      <PageHeader slug={slug} />

      <main>
        <section className="about-hero" aria-labelledby="scoring-title">
          <h1 id="scoring-title">Scoring with QBSheet</h1>
          <p className="about-hero-copy">
            A scorekeeper records who answered each question and what the answer was worth. QBSheet
            derives the score, writes the game to the device as it is scored, and produces the result
            file at the end.
          </p>
          <ActionLinks
            slug={slug}
            primary={{ href: scorerUrl(slug), label: 'Open the practice game' }}
          />
        </section>

        <LoopSection />

        <RecoverySection />

        <section className="about-section about-keyboard" aria-labelledby="keyboard-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Input</p>
            <h2 id="keyboard-heading">Keyboard shortcuts</h2>
            <p>The keyboard is optional. Every action is also available as an on-screen control.</p>
          </div>
          <dl className="about-definition-list">
            <div>
              <dt>Seats</dt>
              <dd>
                <code>1</code>–<code>4</code> are the left team’s seats and <code>5</code>–
                <code>8</code> are the right team’s. The numbers are shown beside the players.
              </dd>
            </div>
            <div>
              <dt>Outcome keys</dt>
              <dd>
                A second key records the outcome. Which keys are active depends on the tournament’s
                scoring rules; a key with no corresponding ruling does nothing.
              </dd>
            </div>
            <div>
              <dt>Unanswered question</dt>
              <dd>
                <code>Space</code> records a question that neither team answered.
              </dd>
            </div>
            <div>
              <dt>Undo and redo</dt>
              <dd>
                <code>Ctrl/⌘ + Z</code> and <code>Ctrl/⌘ + Shift + Z</code>.
              </dd>
            </div>
          </dl>
        </section>

        <section className="about-section about-practice" aria-labelledby="practice-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Learning the scoresheet</p>
            <h2 id="practice-heading">Guided practice</h2>
          </div>
          <div className="about-prose">
            <p>
              QBSheet includes a guided practice game. It runs the real scoresheet through a full
              round with a prompt at each step, and covers a correction and a lineup change as well as
              ordinary scoring. A separate keyboard drill covers the shortcuts.
            </p>
            <p>
              Practice does not require a tournament server or a game file. Progress is stored locally,
              so the round can be stopped and resumed.
            </p>
          </div>
        </section>

        <section className="about-section about-finish" aria-labelledby="finish-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">End of the game</p>
            <h2 id="finish-heading">Finishing a game</h2>
          </div>
          <div className="about-prose">
            <p>
              QBSheet shows the completed scoresheet for review before the game is submitted. In a
              connected room the result is sent to tournament control and the delivery state is
              reported to the scorekeeper. Otherwise the result is downloaded as a QBJ file and handed
              over.
            </p>
            <p>
              The game remains on the device after it has been handed over and can be downloaded
              again. <a href={pageUrl(slug, 'tournaments')}>How connected rooms work</a>.
            </p>
          </div>
        </section>

        <section className="about-final" aria-labelledby="scoring-cta-heading">
          <h2 id="scoring-cta-heading">Open QBSheet</h2>
          <p>The guided practice game runs in the browser and does not require a tournament.</p>
          <ActionLinks slug={slug} />
        </section>
      </main>

      <PageFooter slug={slug} />
    </div>
  );
}
