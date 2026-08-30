/**
 * Short answers to the questions the other pages do not have a natural place for.
 *
 * # Grouping
 *
 * Four groups, ordered by what most often blocks a decision: whether it runs on the hardware an event
 * already has, whether it scores that event's rules, where the game data goes, and what the licensing
 * and cost are. An answer that needs more than a few sentences links to the page written for it
 * rather than expanding here.
 *
 * # Answers are bounded by what this repository knows
 *
 * Where the answer depends on the browser or the deployment, the answer says so. Durable storage is
 * the clearest case: `GameDatabase` treats a restricted profile, private browsing and an exhausted
 * quota as ordinary states and reports when a store is not durable, so the answer is that QBSheet
 * reports it — not that it cannot happen. The device check the browser answer refers to is
 * `DeviceReadiness`.
 *
 * Nothing here describes how many events use QBSheet, what hardware they use, or how they host it.
 * None of that is knowable from this repository, and a marketing claim in a FAQ is still a claim.
 *
 * # Format neutrality
 *
 * The format answers restate `IScorekeeperFormat` and `IRoomProcedure`, both of which are a
 * tournament's own configuration rather than a fixed list. This page is under more pressure than any
 * other here to enumerate format names, and enumerating them is exactly what would narrow the answer.
 * `FaqPage.test.tsx` asserts their absence by name.
 */
import {
  ActionLinks,
  PageFooter,
  PageHeader,
  githubUrl,
  licenseUrl,
  pageUrl,
  qbjDocsUrl,
} from './PageChrome';
import type { ReactNode } from 'react';

const slug = 'faq' as const;

interface IQuestion {
  question: string;
  answer: ReactNode;
}

interface IGroup {
  id: string;
  heading: string;
  kicker: string;
  questions: IQuestion[];
}

const groups: IGroup[] = [
  {
    id: 'devices',
    kicker: 'Hardware',
    heading: 'Devices and browsers',
    questions: [
      {
        question: 'What has to be installed?',
        answer: (
          <>
            Nothing. QBSheet runs in a browser. It can also be installed from the browser as an app,
            which is useful on a device that will be scoring all day, but this is optional.
          </>
        ),
      },
      {
        question: 'Does it work on Chromebooks, iPads, and phones?',
        answer: (
          <>
            Yes. The scoresheet is dense on a phone-sized screen. A physical keyboard makes scoring
            faster but is not required.
          </>
        ),
      },
      {
        question: 'Which browsers are supported?',
        answer: (
          <>
            Current versions of Chrome, Edge, Safari, and Firefox. QBSheet includes a device check
            that tests local storage, file downloads, and service-worker registration on the device
            that will be used, so a room can be verified before the tournament.
          </>
        ),
      },
      {
        question: 'Do rooms have to stay online?',
        answer: (
          <>
            No. Once a game is open, scoring does not require a network connection. Connected rooms
            send progress and results while the server is reachable and continue scoring when it is
            not. <a href={pageUrl(slug, 'tournaments')}>How connected rooms work</a>.
          </>
        ),
      },
    ],
  },
  {
    id: 'formats',
    kicker: 'Rules',
    heading: 'Formats and scoring',
    questions: [
      {
        question: 'Does QBSheet support our format?',
        answer: (
          <>
            QBSheet defines no format of its own. Tossup values, the available outcomes, whether
            bonuses are used and how they are structured, the number of active players, and overtime
            all come from the tournament&apos;s scoring rules. QBSheet does not infer rules from the
            name of a rule set.
          </>
        ),
      },
      {
        question: 'Can rules differ between games?',
        answer: (
          <>
            Scoring rules belong to the game, so a game configured with different rules is scored by
            those rules. Room procedure — where the round breaks, whether a clock is shown, when
            lineups may change — is configured separately, because it varies by room and event rather
            than by rule set.
          </>
        ),
      },
      {
        question: 'How are protests recorded?',
        answer: (
          <>
            A room can mark a question as under protest and continue scoring. A connected room can
            also send a help request to tournament control, for a protest to adjudicate, an absent
            player, or equipment trouble.
          </>
        ),
      },
      {
        question: 'Can a scorekeeper correct an earlier question?',
        answer: (
          <>
            Yes, at any point in the round. The scoresheet recalculates from the correction.{' '}
            <a href={pageUrl(slug, 'scoring')}>What scoring a game involves</a>.
          </>
        ),
      },
    ],
  },
  {
    id: 'data',
    kicker: 'Data',
    heading: 'Files and storage',
    questions: [
      {
        question: 'What happens if the tab is closed during a game?',
        answer: (
          <>
            Reopening QBSheet restores the game. Each accepted question is written to the device as it
            is scored, so the restored game is current as of the last recorded operation.
          </>
        ),
      },
      {
        question: 'What if the browser cannot store data?',
        answer: (
          <>
            QBSheet reports it. A restricted profile, private browsing, or an exhausted storage quota
            can all prevent durable storage. Scoring continues, and the scoresheet states that local
            recovery is unavailable so the room can move to another device or export as it goes.
          </>
        ),
      },
      {
        question: 'What format are results in?',
        answer: (
          <>
            QBJ, the interchange format for quiz bowl game data, which is not specific to QBSheet.
            Older <code>.qbg</code> files can be read for compatibility.{' '}
            <a href={qbjDocsUrl}>Read the profile</a>.
          </>
        ),
      },
      {
        question: 'Where is game data sent?',
        answer: (
          <>
            Games are stored on the device that scored them. There are no accounts and no analytics. A
            connected room communicates with the tournament server you run and with nothing else.{' '}
            <a href={pageUrl(slug, 'privacy')}>What is stored and transmitted</a>.
          </>
        ),
      },
    ],
  },
  {
    id: 'project',
    kicker: 'Project',
    heading: 'Licensing and support',
    questions: [
      {
        question: 'What does QBSheet cost?',
        answer: (
          <>
            Nothing. QBSheet is free software under the GNU AGPL, version 3 or later. There is no paid
            tier and no per-room charge. <a href={licenseUrl}>Read the license</a>.
          </>
        ),
      },
      {
        question: 'Can we host our own copy?',
        answer: (
          <>
            Yes. The build produces a folder of static files that any web host can serve, with no
            application server behind it. <a href={pageUrl(slug, 'self-host')}>Self-hosting guide</a>.
          </>
        ),
      },
      {
        question: 'How are problems reported?',
        answer: (
          <>
            On the issue tracker. During a tournament the room continues scoring from local state and
            the result remains downloadable, so a report can wait until afterwards.{' '}
            <a href={githubUrl}>The repository</a>.
          </>
        ),
      },
      {
        question: 'Does QBSheet replace tournament-control software?',
        answer: (
          <>
            No. QBSheet scores one room. The schedule, the room assignments, and the statistics belong
            to tournament-control software, which QBSheet connects to over an open protocol.
          </>
        ),
      },
    ],
  },
];

/**
 * One group, as a definition list.
 *
 * The same `about-definition-list` the other pages use for term-and-explanation blocks, with the
 * columns removed by `about-faq-list`: a question is a sentence rather than a term, and a sentence in
 * a 120px column wraps to four lines beside a two-line answer.
 */
function QuestionGroup({ group }: { group: IGroup }) {
  return (
    <section className="about-section about-faq" aria-labelledby={`${group.id}-heading`}>
      <div className="about-section-heading about-section-heading-narrow about-reveal">
        <p className="about-kicker">{group.kicker}</p>
        <h2 id={`${group.id}-heading`}>{group.heading}</h2>
      </div>
      <dl className="about-definition-list about-faq-list">
        {group.questions.map((entry) => (
          <div key={entry.question}>
            <dt>{entry.question}</dt>
            <dd>{entry.answer}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default function Faq() {
  return (
    <div className="about-page">
      <PageHeader slug={slug} />

      <main>
        <section className="about-hero" aria-labelledby="faq-title">
          <h1 id="faq-title">Frequently asked questions</h1>
          <p className="about-hero-copy">
            Answers about devices and browsers, formats and scoring, files and storage, and licensing.
          </p>
          <ActionLinks slug={slug} />
        </section>

        {groups.map((group) => (
          <QuestionGroup key={group.id} group={group} />
        ))}

        <section className="about-final" aria-labelledby="faq-cta-heading">
          <h2 id="faq-cta-heading">Open QBSheet</h2>
          <p>The guided practice game runs in the browser and does not require a tournament.</p>
          <ActionLinks slug={slug} />
        </section>
      </main>

      <PageFooter slug={slug} />
    </div>
  );
}
