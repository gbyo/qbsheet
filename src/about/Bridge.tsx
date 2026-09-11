/**
 * The Bridge product page, which is a page about an application this website does not serve.
 *
 * # Why this page exists at all
 *
 * Bridge is easy to confuse with Director: both sit on the tournament computer and both talk to
 * rooms over QBTCP. But they answer different questions. Director is tournament control of its own;
 * Bridge exists for the tournament that already runs in YellowFruit and only wants QBSheet in the
 * rooms. Without a page that says so, a YellowFruit director either never finds the tool or
 * installs Director for a job it is not meant to do. The comparison near the bottom is the point of
 * the page as much as any section above it.
 *
 * # Same build-time rendering as every other page here
 *
 * Rendered to static HTML by `aboutPrerenderPlugin` in `vite.config.ts`, so there is no state, no
 * effect and no handler on it, and it is built out of the same `about-*` classes as `Director`,
 * `QbLive` and `Tournaments` rather than a second set of its own.
 *
 * # Nothing here is aspirational
 *
 * Every claim traces to something in this repository today. The four round stages are the
 * tournament-day procedure in `apps/qbbridge/README.md` and the operator manual in
 * `apps/qbbridge/src/ui/HelpView.tsx`: `Open YellowFruit File`, per-round plans that can be
 * entered ahead of time, `Publish Round`, the room QR and eight-digit pairing code, `Save New
 * Results`, and YellowFruit's own `File → Import Games Only`. What Bridge reads from the `.yft`
 * and what it leaves alone is that README's "What comes from the `.yft`" section; the read-only
 * file boundary and the byte-for-byte result files are its "Results" section; rooms keeping their
 * pairing across rounds is the relay section of the same file. The relay being the existing QBTCP
 * relay in the tournament's own Cloudflare account is `docs/QBTCP-RELAY-DEPLOY.md`.
 *
 * What is deliberately *not* claimed: any installer URL (there is no stable per-platform download
 * URL, so the action points at the releases index, as Director's does), any Bridge release
 * procedure detail (that is `docs/QBBRIDGE_RELEASE.md`), and any quiz bowl format. Bridge carries
 * the format YellowFruit described; it does not have one.
 */
import type { ReactNode } from 'react';
import {
  ActionLinks,
  PageFooter,
  PageHeader,
  bridgeDocsUrl,
  bridgeRelayDocsUrl,
  pageUrl,
  qbjDocsUrl,
  qbtcpDocsUrl,
  releasesUrl,
} from './PageChrome';

const slug = 'bridge' as const;

/** Relative, because this page does not know what directory the deployment put it in. */
const directorUrl = pageUrl(slug, 'director');
const tournamentsUrl = pageUrl(slug, 'tournaments');

/** The primary action, and the reason it is not a file name. See `releasesUrl`. */
const download = { href: releasesUrl, label: 'Download Bridge', external: true } as const;
const guide = { href: bridgeDocsUrl, label: 'Read the setup guide', external: true } as const;

/**
 * Where each part of a round lives, in the order a game travels.
 *
 * Five boxes rather than three, because the trip is the point: the tournament starts in
 * YellowFruit and ends there, and Bridge appears twice — once carrying the round out, once
 * carrying the games back. YellowFruit is at both ends because it never stops owning the event.
 */
const pipeline: { name: string; detail: string }[] = [
  { name: 'YellowFruit', detail: 'Holds the tournament, the teams, and the standings.' },
  { name: 'Bridge', detail: 'Publishes one assignment per room.' },
  { name: 'Scorer', detail: 'Scores the game in the room.' },
  { name: 'Bridge', detail: 'Saves each completed game as a file.' },
  { name: 'YellowFruit', detail: 'Imports the games it is given.' },
];

/**
 * The four steps of a round run through Bridge.
 *
 * Four, and in these words, because they are the operator's actual afternoon: the file is loaded,
 * the rooms are assigned, the round is published, and the finished games are imported. Planning
 * ahead is part of assigning rather than a step of its own, because entering next week's prelims
 * on a quiet evening sends nothing anywhere until a round is published.
 */
const stages: { number: string; name: string; idea: string; detail: ReactNode }[] = [
  {
    number: '01',
    name: 'Load',
    idea: 'Open the tournament file.',
    detail:
      'Open the saved .yft with Open YellowFruit File, and check the team count, player count, and format summary against what was entered in YellowFruit.',
  },
  {
    number: '02',
    name: 'Assign',
    idea: 'Put teams in rooms.',
    detail:
      'Pick the two teams for every room. Each round keeps its own plan, so prelim rounds can be entered the night before. Rooms are added once and keep their pairing for the whole tournament.',
  },
  {
    number: '03',
    name: 'Score',
    idea: 'Publish the round.',
    detail:
      'Click Publish Round. Scorekeepers scan the room’s QR code or type its eight-digit pairing code into ordinary QBSheet Scorer, and score the game normally. The scorer already has the teams, the players, and the scoring rules, so nobody enters them in a room.',
  },
  {
    number: '04',
    name: 'Import',
    idea: 'Bring the games back.',
    detail:
      'Completed games appear in Bridge as they arrive. Save them with Save New Results, then choose File \u2192 Import Games Only in YellowFruit, select the files, and review YellowFruit’s normal import validation.',
  },
];

/** What YellowFruit keeps, stated as a boundary rather than as a list of features. */
function ScopeSection() {
  return (
    <section className="about-section about-split" aria-labelledby="scope-heading">
      <div className="about-section-heading about-section-heading-narrow">
        <p className="about-kicker">Scope</p>
        <h2 id="scope-heading">What stays in YellowFruit</h2>
        <p>
          Bridge is not a second tournament-control application. It keeps no standings, no statistics, no
          schedule, no bracket, and no tournament state of its own.
        </p>
      </div>
      <dl className="about-definition-list">
        <div>
          <dt>Tournament setup</dt>
          <dd>
            The event is created and configured in YellowFruit before the tournament, and saved as a{' '}
            <code>.yft</code> file.
          </dd>
        </div>
        <div>
          <dt>Teams and rosters</dt>
          <dd>
            YellowFruit owns the teams, the players, and the school registrations. Edits made there reach
            Bridge when the file is saved and reloaded with Reload YellowFruit File.
          </dd>
        </div>
        <div>
          <dt>Rounds and phases</dt>
          <dd>
            YellowFruit owns the phases and the rounds. Once YellowFruit knows who advanced, reload the file
            and enter the playoff rounds by hand. Bridge does not predict advancement and generates no
            schedule.
          </dd>
        </div>
        <div>
          <dt>Standings and statistics</dt>
          <dd>
            Bridge keeps none. What a room returns is a game, not a standing, and YellowFruit remains the
            authority for both.
          </dd>
        </div>
        <div>
          <dt>The tournament file</dt>
          <dd>
            Bridge reads the <code>.yft</code> and never writes to it. Planned pairings stay in Bridge; the
            file is left alone.
          </dd>
        </div>
      </dl>
    </section>
  );
}

function PipelineSection() {
  return (
    <section className="about-section about-flow" aria-labelledby="pipeline-heading">
      <div className="about-section-heading about-flow-heading about-reveal">
        <p className="about-kicker">How it fits together</p>
        <h2 id="pipeline-heading">YellowFruit runs the tournament. Bridge carries the rounds.</h2>
        <p>
          QBSheet Bridge — called QBBridge in the repository — sits between the tournament file and the rooms.
          Assignments travel as QBJ, the open document format for game data, over QBTCP, the open protocol
          between tournament control and the rooms. <a href={qbjDocsUrl}>Read the QBJ profile</a> or{' '}
          <a href={qbtcpDocsUrl}>the protocol</a>.
        </p>
      </div>
      <ol className="about-pipeline about-reveal" aria-label="Where a game travels during a round">
        {pipeline.map((step, index) => (
          <li key={`${step.name}-${index}`}>
            {index > 0 && (
              <span className="about-pipeline-arrow" aria-hidden="true">
                →
              </span>
            )}
            <div className="about-pipeline-stop">
              <p className="about-pipeline-name">{step.name}</p>
              <p className="about-pipeline-detail">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="about-prose about-reveal">
        <p>
          YellowFruit remains the tournament authority throughout. Bridge reads the tournament file, publishes
          the assignments, and saves the results. Standings, statistics, and advancement never leave
          YellowFruit, and Bridge does not replace any of it.
        </p>
      </div>
    </section>
  );
}

function RoundSection() {
  return (
    <section className="about-section about-flow" aria-labelledby="round-heading">
      <div className="about-section-heading about-flow-heading about-reveal">
        <p className="about-kicker">A round with Bridge</p>
        <h2 id="round-heading">Load, assign, score, import</h2>
        <p>One round follows the same four steps, prelims and playoffs alike.</p>
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

/** What a scorekeeper meets, which is deliberately less than the operator meets. */
function RoomsSection() {
  return (
    <section className="about-section about-split" aria-labelledby="rooms-heading">
      <div className="about-section-heading about-section-heading-narrow">
        <p className="about-kicker">In the rooms</p>
        <h2 id="rooms-heading">Scorekeepers use normal QBSheet</h2>
        <p>
          What changes for a scorekeeper is smaller than they might expect: the correct game is already there.
        </p>
      </div>
      <div>
        <div className="about-prose">
          <p>
            Rooms score in ordinary QBSheet Scorer, in a browser. The assignment arrives with the two teams,
            their players, and the scoring rules, so nobody recreates the tournament in a room.{' '}
            <a href={tournamentsUrl}>What a connected room does</a>.
          </p>
          <p>
            Pairing is per room rather than per round. A room’s code stays valid for the whole tournament, so
            a device paired in round 1 is still paired in the last round, and publishing a new round does not
            disturb a game somebody is in the middle of scoring.
          </p>
        </div>
        <figure className="about-room-card" aria-label="An example of what one room is given">
          <figcaption>One room is given its own code and its own game.</figcaption>
          <dl>
            <div>
              <dt>Room</dt>
              <dd>Room 4</dd>
            </div>
            <div>
              <dt>Pairing</dt>
              <dd>An eight-digit code and a QR code, for the door</dd>
            </div>
            <div>
              <dt>Assignment</dt>
              <dd>This room’s game, and no other room’s</dd>
            </div>
          </dl>
        </figure>
      </div>
    </section>
  );
}

/** The safety boundary, in a band, because it is the part a director has to take on trust. */
function FileSection() {
  return (
    <div className="about-band">
      <section className="about-section" aria-labelledby="file-heading">
        <div className="about-section-heading about-section-heading-narrow">
          <p className="about-kicker">Ownership</p>
          <h2 id="file-heading">Bridge reads the file. YellowFruit keeps it.</h2>
        </div>
        <div className="about-prose">
          <p>
            Bridge opens the <code>.yft</code> read-only and never writes to it. Roster and format edits made
            in YellowFruit reach Bridge when the file is saved there and reloaded here with Reload YellowFruit
            File. That is a reread, not synchronization.
          </p>
          <p>
            What leaves Bridge is completed games: one <code>.qbj</code> file per game, written out exactly as
            the room sent it. Bridge recalculates nothing, merges nothing, and renames no identifier. Planned
            pairings are never written back, because stock YellowFruit’s import appends what it is given —
            sending unplayed games back would corrupt the file Bridge exists to leave alone.
          </p>
          <p>
            YellowFruit performs its normal import validation on whatever it is given. Bridge reports only
            what it can see: a result is new until it is written, then saved. It never claims a result was
            imported, accepted, or applied to standings.
          </p>
        </div>
      </section>
    </div>
  );
}

/** The confusion this page exists to prevent, kept to two sentences and a link. */
function ChoiceSection() {
  return (
    <section className="about-section about-split" aria-labelledby="choice-heading">
      <div className="about-section-heading about-section-heading-narrow">
        <p className="about-kicker">Bridge or Director</p>
        <h2 id="choice-heading">Which one runs the event</h2>
      </div>
      <div className="about-prose">
        <p>
          <strong>Use Bridge when</strong> the tournament already runs in YellowFruit and the rooms should
          score on QBSheet.
        </p>
        <p>
          <strong>Use Director when</strong> the tournament should run in QBSheet’s own tournament-control
          application instead. <a href={directorUrl}>About Director</a>.
        </p>
      </div>
    </section>
  );
}

export default function Bridge() {
  return (
    <div className="about-page">
      <PageHeader slug={slug} />

      <main>
        <section className="about-hero" aria-labelledby="bridge-title">
          <p className="about-kicker">QBSheet Bridge</p>
          <h1 id="bridge-title">Use QBSheet with YellowFruit</h1>
          <p className="about-hero-copy">
            Keep running the tournament in YellowFruit. Bridge sends each room its game in QBSheet and
            collects the completed scoresheets for import back into YellowFruit.
          </p>
          <ActionLinks slug={slug} primary={download} secondary={guide} />
        </section>

        <PipelineSection />

        <ScopeSection />

        <RoundSection />

        <RoomsSection />

        <FileSection />

        <ChoiceSection />

        <section className="about-section about-requirements" aria-labelledby="setup-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Setup</p>
            <h2 id="setup-heading">Requirements</h2>
          </div>
          <dl className="about-definition-list">
            <div>
              <dt>QBSheet Bridge</dt>
              <dd>
                The desktop application on the tournament computer. Builds are published on GitHub.{' '}
                <a href={releasesUrl}>Open the releases page</a>.
              </dd>
            </div>
            <div>
              <dt>A YellowFruit file</dt>
              <dd>
                The <code>.yft</code>, created and configured in stock YellowFruit and saved before the
                tournament.
              </dd>
            </div>
            <div>
              <dt>QBSheet in each room</dt>
              <dd>
                Ordinary QBSheet Scorer, opened in a browser. Rooms reach Bridge over the internet through the
                relay, so each room needs a device that can get online.
              </dd>
            </div>
            <div>
              <dt>The QBTCP relay</dt>
              <dd>
                Bridge publishes through the existing QBTCP relay, running in the tournament’s own Cloudflare
                account. QBSheet operates no server.{' '}
                <a href={bridgeRelayDocsUrl}>Read the relay deployment notes</a>.
              </dd>
            </div>
          </dl>
        </section>

        <section className="about-final" aria-labelledby="bridge-cta-heading">
          <h2 id="bridge-cta-heading">
            Keep running the tournament in YellowFruit. Use QBSheet in the rooms.
          </h2>
          <p>Load the tournament file, publish the rounds, and import the finished games.</p>
          <ActionLinks slug={slug} primary={download} secondary={guide} />
        </section>
      </main>

      <PageFooter slug={slug} />
    </div>
  );
}
