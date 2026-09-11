/**
 * The operator's manual, in the application rather than only in a README.
 *
 * The room this is written for has no second screen and possibly no internet on the laptop
 * running QBBridge, so everything needed to set the tournament up is here — including the
 * Cloudflare deployment, which is the part with real commands in it and the part a first-time
 * operator gets stuck on.
 *
 * Every command and endpoint below is checked against the deployment it describes by
 * `HelpView.test.tsx`, so a rename in `wrangler.jsonc` or in the relay's environment cannot
 * leave this page confidently wrong.
 */

import type { ReactNode } from 'react';
import { Notice } from '@qbsheet/ui';
import { generateSetupToken, generateTournamentId } from '../model/relay';
import SecretGenerator from './SecretGenerator';

interface Section {
  id: string;
  title: string;
  body: ReactNode;
}

/** A shell command, shown as something to type rather than something to read past. */
function Command({ children }: { children: string }) {
  return <pre className="help-command">{children}</pre>;
}

const sections: Section[] = [
  {
    id: 'what',
    title: 'What QBSheet Bridge does',
    body: (
      <>
        <p>
          It lets stock YellowFruit run the tournament while the rooms score on ordinary QBSheet Scorer. It
          carries a round out to the rooms and brings each completed game back as a <code>.qbj</code> file you
          import through YellowFruit&rsquo;s own dialog.
        </p>
        <pre className="help-flow">{`YellowFruit .yft
      ↓  loaded here (read only — the .yft is never written to)
QBSheet Bridge
      ↓  one QBJ assignment per room
QBTCP relay, in your Cloudflare account
      ↓  pairing code / QR
QBSheet Scorer, in each room
      ↓  completed game
relay  →  QBSheet Bridge  →  .qbj files in a folder
      ↓
YellowFruit → Import Games Only`}</pre>
        <p>
          YellowFruit stays the authority for standings, statistics and the schedule. QBBridge keeps none of
          those and never edits your tournament file.
        </p>
      </>
    ),
  },
  {
    id: 'relay',
    title: 'Setting up the Cloudflare relay',
    body: (
      <>
        <p>
          The relay is how a scorer in a room reaches this laptop over the internet. It is a small Cloudflare
          Worker with one SQLite Durable Object per tournament, and it runs{' '}
          <strong>in your own Cloudflare account</strong>. QBSheet operates no server, receives no tournament
          traffic, and needs no QBSheet account. Do this once, before the tournament.
        </p>

        <h4>1. Deploy the Worker</h4>
        <p>
          Open <code>github.com/gbyo/qbsheet/tree/main/apps/qbtcp-relay-backend-cloudflare</code> and use its{' '}
          <strong>Deploy to Cloudflare</strong> button. Cloudflare clones the repository, reads{' '}
          <code>wrangler.jsonc</code>, provisions the Durable Object and deploys. A free account is enough for
          a tournament this size.
        </p>

        <h4>2. Set the one-time setup token</h4>
        <p>Run this, and paste the token when Wrangler prompts for it:</p>
        <Command>wrangler secret put RELAY_SETUP_TOKEN</Command>
        <p id="help-setup-token-note">
          Generate one here if you have nothing better to hand. You will paste the same value twice — once
          into the prompt above, once into the Tournament screen — and then never again: claiming exchanges it
          for a durable management credential, after which the setup token is worthless even if it leaks.
          QBBridge does not store it.
        </p>
        <SecretGenerator
          label="setup token"
          generate={generateSetupToken}
          describedBy="help-setup-token-note"
        />

        <h4>3. Allow the scorer&rsquo;s browser origin</h4>
        <p>
          Scorekeepers open QBSheet Scorer in a browser, and the relay refuses a credentialed request from a
          browser origin it has not been told about. Set this or every room will fail to pair with{' '}
          <code>403 origin_not_allowed</code> — at the preflight, before the real request is even sent.
        </p>
        <Command>wrangler secret put RELAY_ALLOWED_ORIGINS</Command>
        <p>
          Enter <code>https://qbsheet.com</code>, or a comma-separated list if your scorekeepers use more than
          one address. QBBridge itself is unaffected either way: it talks to the relay natively, with no
          browser origin attached, which is why its requests need no entry here.
        </p>

        <h4>4. Copy the address</h4>
        <p>
          The deployed Worker URL looks like{' '}
          <code>https://qbtcp-relay-backend.your-subdomain.workers.dev</code>. No custom domain is needed.
          Paste just the origin into QBBridge — no path, no trailing slash.
        </p>

        <h4>5. Claim it from QBBridge</h4>
        <p id="help-tournament-id-note">
          On the Tournament screen, enter the address, a tournament ID and the setup token, then{' '}
          <strong>Connect Relay</strong>. The Tournament screen generates an ID for you; there is one here
          too, for planning a deployment before you open the file. It names this tournament&rsquo;s Durable
          Object — 24 characters, digits and lowercase consonants only — and it is not a secret: it appears in
          every pairing link.
        </p>
        <SecretGenerator
          label="tournament ID"
          generate={generateTournamentId}
          describedBy="help-tournament-id-note"
        />

        <Notice tone="warning">
          Keep spectator traffic off this deployment. Cloudflare&rsquo;s free allowance of 100,000 requests a
          day is <em>account-level</em>, so a busy QBLive Worker in the same account and your scoring relay
          draw from the same pool — and when it runs out, scoring stops with it.
        </Notice>
      </>
    ),
  },
  {
    id: 'before',
    title: 'Before the tournament',
    body: (
      <ol className="help-steps">
        <li>Create and configure the tournament in YellowFruit — teams, rosters, format, rounds.</li>
        <li>
          Save the <code>.yft</code>.
        </li>
        <li>Deploy the relay, as above.</li>
        <li>Open QBSheet Bridge.</li>
        <li>
          On <strong>Tournament</strong>, click <strong>Open YellowFruit File</strong> and check that the team
          count, player count and format summary match what you expect.
        </li>
        <li>Connect the relay.</li>
        <li>
          On <strong>Rooms</strong>, click <strong>+ Room</strong> once per room in use and name them the way
          the signs on the doors do.
        </li>
        <li>
          Click <strong>Publish Room Setup</strong> before entering Round 1 pairings. This activates each
          room&rsquo;s code so its scorer can pair once; the room token remains valid for the rest of the
          tournament.
        </li>
      </ol>
    ),
  },
  {
    id: 'round',
    title: 'Running each round',
    body: (
      <>
        <ol className="help-steps">
          <li>Choose the round.</li>
          <li>
            Pick the two teams in every room. The pickers accept typing — <code>prov</code> is faster than
            scrolling.
          </li>
          <li>
            Click <strong>Publish Round</strong>.
          </li>
          <li>
            Scorekeepers scan the room&rsquo;s QR code, or type its eight-digit pairing code into QBSheet
            Scorer.
          </li>
          <li>
            Games are scored normally. The scorer already has the format — nobody chooses NAQT or configures
            bonuses in a room.
          </li>
        </ol>
        <p>
          A room you leave blank is published as having <em>no</em> game, so it cannot open last round&rsquo;s
          assignment by mistake. Changing the round clears every team selection for the same reason, after
          asking first.
        </p>
        <p>
          Pairing survives a round change. A device paired in round 1 is still paired in round 8 — you do not
          re-pair between rounds, and publishing a new round does not disturb a game somebody is in the middle
          of scoring.
        </p>
        <p>
          If you use <strong>New code</strong>, the old code and QR remain active until a successful room
          setup or round publish activates the replacement.
        </p>
      </>
    ),
  },
  {
    id: 'results',
    title: 'Getting results into YellowFruit',
    body: (
      <>
        <ol className="help-steps">
          <li>Completed games appear on the Results screen within a few seconds of finishing.</li>
          <li>
            Click <strong>Choose Result Folder</strong> once, then <strong>Save New Results</strong> whenever
            you want to import a batch.
          </li>
          <li>
            In YellowFruit choose <strong>File → Import Games Only</strong> (Cmd/Ctrl+M).
          </li>
          <li>Select the saved files — the dialog multi-selects.</li>
          <li>Review YellowFruit&rsquo;s normal import validation and import them.</li>
        </ol>
        <p>
          Each file is the scorer&rsquo;s own QBJ, written out unchanged. QBBridge recalculates nothing,
          merges nothing, and renames no identifier. One file per game, because YellowFruit imports several at
          once and a single bad game is easier to set aside.
        </p>
        <p>
          If a room submits a correction, it arrives as a second result with its own filename. The first file
          is never replaced.
        </p>
        <p>
          A result is acknowledged by the relay only after its QBJ bytes are safely written to this computer.
          Seeing it on this screen is not an acknowledgement, and an ACK request that fails is retried on a
          later poll. This says only that QBBridge saved a local copy — it does not mean YellowFruit imported,
          reviewed or accepted the game.
        </p>
      </>
    ),
  },
  {
    id: 'trouble',
    title: 'When something goes wrong',
    body: (
      <dl className="help-faq">
        <dt>Relay unavailable</dt>
        <dd>
          Nothing local is lost. Rooms already holding an assignment keep scoring, completed games stay on
          their devices until a transport accepts them, and QBBridge retries on its next poll. Check the
          laptop&rsquo;s internet before anything else.
        </dd>

        <dt>A publish failed</dt>
        <dd>
          The rooms still have whatever they had before — a failed publish changes nothing, here or on the
          relay. Fix the problem and publish again.
        </dd>

        <dt>&ldquo;The relay already holds a newer publication&rdquo;</dt>
        <dd>
          Something else published to this tournament after QBBridge last did. Do not force it: find out what,
          because two things publishing to one tournament will fight.
        </dd>

        <dt>A room cannot pair</dt>
        <dd>
          Almost always <code>RELAY_ALLOWED_ORIGINS</code>, from step 3 above. Otherwise check that the
          scorekeeper is typing the active code for the right room, and that{' '}
          <strong>Publish Room Setup</strong>
          has succeeded. A room-only setup is enough to pair before Round 1; it does not need an assignment
          yet.
        </dd>

        <dt>A team is missing after editing YellowFruit</dt>
        <dd>
          Save in YellowFruit, then click <strong>Reload YellowFruit File</strong>. QBBridge reads the file
          when you ask it to; it does not watch it.
        </dd>

        <dt>Results are piling up unsaved</dt>
        <dd>
          Save them. The relay shows the oldest 128 unsaved results at a time, and saving is what clears one
          out of that window. QBBridge warns you long before it matters.
        </dd>

        <dt>A result file would overwrite an existing one</dt>
        <dd>
          QBBridge refuses and says so rather than replacing it. Move or rename whatever is already in the
          folder, then save again.
        </dd>
      </dl>
    ),
  },
  {
    id: 'not',
    title: 'What QBSheet Bridge does not do',
    body: (
      <>
        <p>
          It does not schedule, seed, advance, rank, or keep statistics. It does not edit your{' '}
          <code>.yft</code>, and it cannot import anything into YellowFruit for you — the last step is always
          a person choosing files in YellowFruit&rsquo;s own dialog.
        </p>
        <p>
          It also reports only what it can actually see. A room is <strong>Ready</strong> until its assignment
          is published, <strong>Waiting</strong> until a result for that game arrives, then{' '}
          <strong>Result received</strong>. It never claims a result was imported, accepted or applied to
          standings, because it has no way to know — YellowFruit does.
        </p>
      </>
    ),
  },
];

export default function HelpView() {
  return (
    <section className="panel help">
      <h2>Help</h2>
      <nav aria-label="Help contents" className="help-contents">
        <ol>
          {sections.map((section) => (
            <li key={section.id}>
              <a href={`#help-${section.id}`}>{section.title}</a>
            </li>
          ))}
        </ol>
      </nav>
      {sections.map((section) => (
        <article key={section.id} id={`help-${section.id}`} className="help-section">
          <h3>{section.title}</h3>
          {section.body}
        </article>
      ))}
    </section>
  );
}
