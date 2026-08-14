/**
 * The self-hosting page.
 *
 * # Same build-time rendering as the product page
 *
 * Like `About`, this component never runs in a browser: `aboutPrerenderPlugin` in `vite.config.ts`
 * renders it to static HTML and the deployment ships that. So it holds no state, no effects and no
 * event handlers, and it is built out of the product page's own classes rather than a second set, so
 * the two pages cannot drift apart.
 *
 * # Written for the person who has to put it somewhere
 *
 * The reader is a coach with school web hosting, a director with a Cloudflare account, or a club
 * officer with a laptop and a router in the venue. What they are deciding is whether hosting this is
 * an afternoon or a project, so the middle of the page is the three commands it actually takes, and
 * the section after it is the list of things they will not have to run. Both are what the answer
 * turns on; a feature list is not.
 *
 * # Nothing here is aspirational either
 *
 * Every claim traces to something this repository does today. The relative `base` and the
 * fragment-only routing are in `vite.config.ts`; the `dist/` output and `BASE_PATH` are the README's
 * deployment steps; the update behaviour is the generated worker's deliberate lack of `skipWaiting`;
 * on-device state is `GameDatabase`; and the license is `AGPL-3.0-or-later` in `package.json`.
 *
 * The HTTPS section exists because the offline shell is a service worker and browsers install one
 * only on a secure origin. Leaving that to a footnote would mislead exactly the reader who is
 * self-hosting in order to get offline scoring, which is the one failure this page must not cause.
 */
import type { ReactNode } from 'react';
import {
  ActionLinks,
  PageFooter,
  PageHeader,
  buildStepsUrl,
  licenseUrl,
  qbtcpDocsUrl,
} from './PageChrome';

const slug = 'self-host' as const;

/**
 * The three commands, in the order somebody runs them.
 *
 * Deliberately the same three for a first deployment and for every update after it, because that is
 * what the build actually is and because a separate "upgrading" procedure would imply state on the
 * host that there is none of.
 */
const steps: { number: string; name: string; idea: string; detail: ReactNode }[] = [
  {
    number: '01',
    name: 'Build',
    idea: 'Build the site.',
    detail: (
      <>
        QBSheet needs Node.js 20 or later. Run <code>npm ci</code> to install dependencies, then{' '}
        <code>npm run build</code>. The finished site lands in <code>dist/</code>. Neither the build nor
        the site it produces contacts anything we run.
      </>
    ),
  },
  {
    number: '02',
    name: 'Serve',
    idea: 'Put dist/ on a web host.',
    detail: (
      <>
        GitHub Pages, Cloudflare Pages, a school web server, a machine on the venue network. Asset paths
        are relative, so one build works at a domain root or inside a repository path without rebuilding
        it. Set <code>BASE_PATH</code> only if your host needs an absolute prefix.
      </>
    ),
  },
  {
    number: '03',
    name: 'Update',
    idea: 'Rebuild when you want a newer version.',
    detail: (
      <>
        Pull, build again, replace the folder. Devices already in a game keep running the build they
        started on. The new one installs quietly and waits until somebody confirms the round is over.
      </>
    ),
  },
];

/** What a host does not have to provide, which is the whole reason this page is short. */
const absences = [
  {
    title: 'No routing rules',
    body: 'QBSheet keeps its state on the device, not in the address bar. Every screen lives at one URL, so nothing needs routing and there’s no single-page-app fallback to configure. Default static hosting settings work.',
  },
  {
    title: 'No database',
    body: 'Games stay on the device that scored them. You won’t be provisioning storage, running backups, or keeping a server reachable while a round is going.',
  },
  {
    title: 'No accounts',
    body: 'Scorekeepers don’t sign in. There are no users to create, no passwords to reset, and nobody locked out at the table waiting on you.',
  },
  {
    title: 'Nothing of ours in the loop',
    body: 'Your copy doesn’t talk to any server we run. If rooms connect to tournament control, they connect to your tournament server over QBTCP, and QBSheet is only the scoresheet.',
  },
];

/** The three commands, laid out as the one sequence on the page. */
function StepSection() {
  return (
    <section className="about-section about-flow" aria-labelledby="steps-heading">
      <div className="about-section-heading about-flow-heading about-reveal">
        <p className="about-kicker">From clone to kickoff</p>
        <h2 id="steps-heading">Three steps, and then the same three steps again</h2>
        <p>Setting QBSheet up and updating it later are the same short process.</p>
      </div>
      <ol className="about-stages">
        {steps.map((step) => (
          <li key={step.number}>
            <h3 className="about-stage-name">
              <span className="about-stage-number" aria-hidden="true">
                {step.number}
              </span>
              {step.name}
            </h3>
            <p className="about-stage-idea">{step.idea}</p>
            <p className="about-stage-detail">{step.detail}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The absences, in the tinted band.
 *
 * A set of properties rather than a stage of the sequence, so it is a section of its own for the same
 * reason the product page's assurances are: a grid directly below three numbered steps reads as a
 * fourth step.
 */
function AbsenceSection() {
  return (
    <div className="about-band">
      <section className="about-section about-assurances" aria-labelledby="absences-heading">
        <div className="about-section-heading about-reveal">
          <h2 id="absences-heading">What you don’t have to run</h2>
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
  );
}

export default function SelfHost() {
  return (
    <div className="about-page">
      <PageHeader slug={slug} />

      <main>
        <section className="about-hero" aria-labelledby="self-host-title">
          <h1 id="self-host-title">Host QBSheet yourself</h1>
          <p className="about-hero-copy">
            QBSheet builds into a folder of static files. Put that folder on a web host and you have your
            own working copy, with no application server behind it and no accounts for the people scoring
            with it.
          </p>
          <ActionLinks
            slug={slug}
            primary={{ href: buildStepsUrl, label: 'Read the build steps', external: true }}
          />
        </section>

        <StepSection />

        <AbsenceSection />

        <section className="about-section about-hosts" aria-labelledby="hosts-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Anywhere static</p>
            <h2 id="hosts-heading">Somewhere to put it</h2>
            <p>If a host serves static files over HTTPS, it can serve QBSheet.</p>
          </div>
          <dl className="about-definition-list">
            <div>
              <dt>GitHub Pages</dt>
              <dd>
                Project repositories are served from a subpath, which the relative asset paths already
                handle. The default build works there with no configuration.
              </dd>
            </div>
            <div>
              <dt>Cloudflare Pages</dt>
              <dd>
                Set the build command to <code>npm run build</code> and the output directory to{' '}
                <code>dist/</code>. Netlify and similar hosts take the same two settings.
              </dd>
            </div>
            <div>
              <dt>Your own server</dt>
              <dd>Apache, nginx, Caddy, or whatever static hosting your school is already paying for.</dd>
            </div>
            <div>
              <dt>A venue laptop</dt>
              <dd>
                A laptop can serve <code>dist/</code> to the rooms around it. Once a game is open, QBSheet
                doesn’t need anything past that laptop.
              </dd>
            </div>
          </dl>
        </section>

        <section className="about-section about-offline" aria-labelledby="https-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">The offline part</p>
            <h2 id="https-heading">Serve it over HTTPS</h2>
          </div>
          <div className="about-prose">
            <p>
              The offline shell is a service worker, and browsers only install one on a secure origin. In
              practice that means HTTPS, or <code>localhost</code> while you’re testing. Over plain HTTP
              the scorer still loads and still scores, but nothing is cached, so the next device that
              starts cold needs the network again.
            </p>
            <p>
              If offline scoring is why you’re hosting this, put a certificate in front of it. Rooms that
              connect to tournament control need one anyway, because{' '}
              <a href={qbtcpDocsUrl}>QBTCP</a> is a connection your tournament server owns rather than
              anything QBSheet hosts.
            </p>
          </div>
        </section>

        <section className="about-section about-license" aria-labelledby="license-heading">
          <div className="about-section-heading about-section-heading-narrow">
            <p className="about-kicker">Open by design</p>
            <h2 id="license-heading">Yours to change</h2>
            <p>
              QBSheet is licensed under the{' '}
              <a href={licenseUrl}>GNU AGPL, version 3 or later</a>. You can host it, modify it, and
              run your league’s own version of it.
            </p>
          </div>
          <div className="about-prose">
            <p>
              One obligation comes with that. If you change QBSheet and then let other people use your
              changed version over a network, the AGPL asks you to offer them the source for what they’re
              using. Hosting an unmodified build doesn’t involve that step.
            </p>
          </div>
        </section>

        <section className="about-final" aria-labelledby="host-it-heading">
          <h2 id="host-it-heading">Ready to host it?</h2>
          <p>
            The whole setup is four commands, and the first one is <code>git clone</code>.
          </p>
          <ActionLinks
            slug={slug}
            primary={{ href: buildStepsUrl, label: 'Read the build steps', external: true }}
          />
        </section>
      </main>

      <PageFooter slug={slug} />
    </div>
  );
}
