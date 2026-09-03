# Contributing to QBSheet

Thank you for your interest. QBSheet is an offline-first browser scoresheet for quiz bowl. It is also
the canonical home of the scorer core, the QBJ reader, and the QBTCP and QBJ-profile specifications
that other software implements. Those two roles set most of the rules below.

The [Code of Conduct](CODE_OF_CONDUCT.md) governs participation.

## Where a change belongs

| Change | Repository |
| --- | --- |
| The scoresheet app, the scorer core, QBJ parsing and output, practice mode, PWA and static hosting | this one |
| The QBTCP specification or the QBJ assignment profile | this one — `docs/` is the specification, not a copy of it |
| Desktop statkeeping, Match Plan, Tournament Control, reports, `.yft` and SQBS, the room host | [`gbyo/fruity`](https://github.com/gbyo/fruity) |

QBSheet is one scoresheet implementation of QBTCP, and Fruity is one tournament-control
implementation. Neither product owns the protocol. A change to the wire surface usually needs a pull
request in both repositories, and each request links to the other.

## Two boundaries that shape most reviews

Most review comments trace back to one of these two boundaries.

**The core is browser-independent.** `src/core/index.ts` is the package entry point that Fruity
consumes as a Git dependency. It must stay free of React, DOM, and persistence imports, so that the
desktop host runs the same engine rather than a second copy of it. Anything that you export there
becomes a dependency of another project.

**Portable files carry no operational secret.** A QBJ document that QBSheet writes never contains a
room or session token, a pairing code, a device identifier, a server address, or the local recovery
journal. The privacy rules are in
[`docs/QBJ_ASSIGNMENT_PROFILE.md`](docs/QBJ_ASSIGNMENT_PROFILE.md).

The tests also defend two invariants:

* **A QBTCP assignment body is a QBJ document.** The connected path and the file path go through one
  parser, and they cannot drift apart.
* **The local event journal is authoritative for recovery,** and a partial QBJ is not. A downloaded
  partial cannot represent the event history, the undo state, the clock internals, the connection
  state, or the outbox.

## Getting set up

Use Node 20 or a later version. CI runs Node 20, so develop against that version.

```sh
git clone https://github.com/gbyo/qbsheet.git
cd qbsheet
npm ci
npm start
```

`npm start` runs Vite, normally on `http://localhost:5173`. The application is fully usable from a QBJ
file with no server. Open a game file and score.

### Three products, three ways to run them

This repository holds three applications, and the root build serves only the first of them.

* **Scorer** — the root Vite application, and the whole of what the website deploys. `npm start`.
* **Director** — the desktop application under `apps/director`, with its own Vite config and its own
  Tauri shell. `npm run director:dev` serves its user interface on `http://127.0.0.1:1420`, and
  `npm run director:tauri:dev` runs the real native window, which is the only place the QBTCP
  listener and the local tournament database exist. The root build emits no Director entry: there is
  no `director.html` and no URL on the deployed site that launches tournament control.
* **QBSheet Live** — the participant-facing client under `apps/live-web`, deployed separately to
  `live.qbsheet.com`. `npm run live:dev`.

Director and QBLive have static marketing pages on the website, prerendered from `src/about/` to
`/about/director/` and `/about/qblive/`. Those are pages describing an application, not the
application.

To exercise the connected path, run Fruity's Local Tournament Server, add the Vite origin to its
QBSheet origin setting, then enter the local network address of the server in the scoresheet. The
origin allowlist covers CORS only. Every operation on a paired room still needs a valid room or
session credential.

## Repository layout

| Path | What lives there |
| --- | --- |
| `src/core/` | the package entry point — a barrel over the browser-independent modules |
| `src/scoring/` | score events, the guard that decides what applies, and the reducers that derive a game |
| `src/scorer/` | the scoring UI over those reducers |
| `src/qbj/` | QBJ serialization, assignment parsing, scoring rules, the `_qbtcp` extension |
| `src/qbtcp/` | the route table, exported so a server can route on the same table the client calls |
| `src/game/` | game definition, packages, portable QBJ, rosters |
| `src/app/` | the application shell: welcome, file open, connected setup, scoring screen |
| `src/persistence/` | IndexedDB store and tab claim |
| `src/practice/` | guided practice mode |
| `docs/` | the QBTCP and QBJ profile specifications, the `.qbg` migration, and the test-file guide |
| `src/about/` | the prerendered marketing pages, including the Director and QBLive product pages |
| `src/director/` | the Director user interface, consumed by `apps/director` and by nothing else |
| `apps/director/` | the Director desktop application: its Vite config, Tauri shell, and native crate |
| `apps/live-web/` | QBSheet Live Web, deployed separately to `live.qbsheet.com` |
| `tests/`, `e2e/` | application and integration tests, and the Playwright torture test |
| `e2e/director/` | the Director browser tests, run against `apps/director` by `playwright.director.config.ts` |
| `scripts/ci/` | the change-impact classifier that routes the `CI` workflow |

## Before you open a pull request

Run what CI runs:

```sh
npm run format
```

```sh
npm run lint
```

```sh
npm run typecheck
```

```sh
npm test -- --run
```

```sh
BASE_PATH=/qbsheet/ npm run build
```

Run the build under a project path. Vite emits relative asset paths by default, and this form of the
build catches a change that works only at a domain root. GitHub Pages deployments live below a
repository path.

Also run the following, by what you changed:

| If you changed | Run |
| --- | --- |
| the scorer UI or the app shell | `npm run test:browser` (needs `npx playwright install --with-deps chromium` once) |
| anything in `src/scoring/` | `npm run test:property` and `npm run test:state-space` |
| `canApplyScoreEvent.ts`, `questionCorrection.ts`, or `bonusOptions.ts` | `npm run test:mutation` |
| the core barrel or anything it exports | `npm run build:core` |

`npm run test:mutation` runs Stryker over the three files in `stryker.config.json`. It fails below a
mutation score of 75 percent. CI runs it weekly and on demand. Run it locally before you change a
scoring boundary, because a local run is much faster than a CI failure days later.

`npm run test:stress` is the deep state-space run. `QBSHEET_STRESS_SEEDS` and `QBSHEET_STRESS_ACTIONS`
drive it. A nightly workflow runs it with 5000 seeds. The default suite is enough locally, unless you
change the state machine.

## What CI runs, and when

`CI` is routed by change impact. Its first job, `changes`, classifies the files a pull request
touches and every other job runs only if that classification says it could be affected. The rule is
that a test runs when a changed file could affect what that test protects — so a Rust crate, an iOS
file, a Cloudflare Worker, or a README does not run the Playwright scorer torture test, and anything
that can reach the scoresheet does.

| Domain | What it runs | What turns it on |
| --- | --- | --- |
| `quality` | formatting, lint, typecheck | any `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, or `.css` file, and their configs |
| `scorer` | the root Vitest suite, and the project-path build | `src/` outside `src/director/`, `tests/`, `index.html`, `about/`, `public/`, `wiki/` |
| `browser` | `npm run test:browser` | anything that changes scorer runtime behaviour or its browser environment, plus `e2e/` and `playwright.config.ts` |
| `director-ui` | the Director application build, its tests, and `e2e/director/Director.spec.ts` against `apps/director` | `src/director/`, `apps/director/` outside `src-tauri/`, `e2e/director/`, and the packages Director imports |
| `tournament-js` | the tournament-core, -formats, and -domain suites | `packages/tournament-*/` |
| `qblive-js` | the QBLive package suites and Live Web | only a *shared* change, because `qblive.yml` owns the QBLive paths |
| `rust-director`, `rust-tournament-store`, `rust-qbtcp` | `cargo fmt`, `clippy`, `test` for one crate | that crate, plus `crates/qbtcp-server/` for the Director crate, which path-depends on it |

`verify` runs last and is the aggregate: it passes when every job that was relevant passed, and a
job that was skipped because it was irrelevant is a pass. It is the check to read first, because it
prints which domains were detected and which jobs ran.

The rules live in [`scripts/ci/impact.mjs`](scripts/ci/impact.mjs), with the dependency map they
were derived from, and [`tests/ci/impact.test.ts`](tests/ci/impact.test.ts) holds them to it. Two
things to know before editing them:

* **Uncertainty runs more, never less.** A path that matches no rule turns every domain on and says
  so in the job summary. If you add a directory, add a rule for it — the test that every tracked
  file is classified will tell you.
* **`.github/workflows/qblive.yml` is separate on purpose.** It carries the Cloudflare, Swift,
  Xcode, privacy, and conformance work. `CI` does not duplicate it; what `CI` keeps for the QBLive
  paths is the repository formatting and lint that `qblive.yml` does not run.

To see how a change would be routed without pushing it:

```sh
node scripts/ci/classify-impact.mjs --files src/scorer/Scoresheet.tsx ios/project.yml
```

## Tests

The suite uses Vitest, jsdom, and `tests/setup.ts`, with a deliberate split:

* **Engine tests sit next to the engine** in `src/**/*.test.ts`. **Application and integration tests
  live in `tests/`.**
* The jsdom origin is a real URL in `vitest.config.ts`, because jsdom refuses `localStorage` on an
  opaque origin. The journal that receives every scored question lives there.
* `fake-indexeddb` loads in the setup, so the tests exercise the durable path rather than an in-memory
  fallback. Each test starts from a device that has scored nothing, because the setup file clears
  storage between tests. A leftover journal must not make a recovery test pass for the wrong reason.
* Shared builders live in `tests/`: `qbjDocuments.ts`, `packages.ts`, `events.ts`, `rules.ts`,
  `appHarness.tsx`, and `localStorage.ts`. Extend those builders rather than start a parallel set.
* Property tests use `fast-check`. The state-space suite verifies the game machine exhaustively. To fix
  a scoring defect, add to those suites rather than add one hand-picked case.
* For a fixture, follow [`docs/TEST_FILE_GENERATION.md`](docs/TEST_FILE_GENERATION.md). Generate a
  valid file through the code that owns the format, then make the smallest mutation that the test
  needs. A hand-written approximation tests a shape that the applications never produce.
* A file header comment here says which claim the tests protect, not which module they cover. Keep that
  convention, because it is what makes a failure legible a year later.

New behaviour needs a test. A bug fix needs a test that fails without the fix.

## Offline-first constraints

The build needs no backend.

* No analytics, no telemetry, no font or script CDNs, and no runtime call to any origin except a
  tournament-control server that the operator entered.
* Assets must keep working from a domain root, from below a repository path, and from a local
  directory. Use relative paths or `BASE_PATH`.
* The service worker does not cache a response from a tournament-control origin. A cached room
  assignment or a cached result is a correctness defect.
* When persistence is unavailable, the scoresheet stays usable and reports the limit. Do not add a code
  path that fails hard when IndexedDB is absent.
* QBSheet keeps a completed record locally for seven days. It does not delete a record because a server
  accepted the result, and it does not delete a record because a scorekeeper downloaded a QBJ.

## Changing the specifications

`docs/QBTCP.md` and `docs/QBJ_ASSIGNMENT_PROFILE.md` are normative documents that other people
implement.

* **Write for an implementer who will not read this codebase.** Another tournament manager must be able
  to implement the specification without an import of QBSheet or Fruity. A rule that makes sense only
  next to our source is underspecified.
* **QBTCP does not restate QBJ.** `Tournament`, `Phase`, `Round`, `Team`, `Player`, `Match`,
  `ScoringRules`, and the statistics belong to QBJ. Where the protocol needs them, it carries a QBJ
  document and says so. A parallel team schema or a parallel match schema is a defect.
* **The protocol version is a single integer in the path.** Increment it only for a change that a
  version-1 client cannot tolerate. Optional fields, optional endpoints, and new capabilities are
  additive and stay in v1. Say in your pull request which of the two your change is.
* **`/api/v1` aliases stay working.** They are deprecated from their introduction, and they carry no
  independent behaviour. Never give an alias its own implementation.
* **Legacy names are opaque strings.** Do not rename a wire field for tidiness, because a deployed
  client reads it.
* Update the specification and the implementation in the same pull request. Open the matching Fruity
  pull request, so that the two sides land together.

## Code style

* TypeScript throughout, `.tsx` for a component, React 18 with hooks. No class components.
* Prettier formats the code — 110 columns, single quotes, trailing commas — and CI checks it. Run
  `npm run format` before opening a pull request. Nothing in review is about where a line break went.
* ESLint flat config in `eslint.config.js`, which includes `react-hooks` and `jsx-a11y`. `npm run lint`
  must be clean. It ends with `eslint-config-prettier`, so ESLint has no opinion about formatting.
* Volunteers use this scoresheet on Chromebooks and phones under time pressure. Keep the touch targets
  large, keep the keyboard paths intact, and keep the labels legible. Treat `jsx-a11y` findings as
  functional defects.
* Match the surrounding code. This codebase comments the reason for a line: the invariant that a
  function protects, or the cause of a fallback. It does not restate what the line does.

## Commits and pull requests

* Branch off `main`. A branch name in this repository looks like `topic/short-description`, for example
  `gibby/qbtcp-qbj-architecture-spec`.
* Write an imperative commit subject, for example "Read a round's number from Round.name". A `docs:`
  prefix marks a documentation-only change. Other prefixes are not required.
* One concern per pull request. The pull request template asks what changed, how you tested it, and
  which of the boundaries above it touches. Delete the sections that do not apply.
* State whether the change affects the core export surface, the contents of a portable file, or the
  wire surface. Those are the three surfaces that a downstream implementation can break on.
* CI must be green: lint, typecheck, tests, the project-path build, and the Playwright torture test —
  for whichever of those your change can affect. See "What CI runs, and when". `verify` is the check
  that says the whole of it passed.

## Reporting bugs

Open an issue, and choose the form that fits.

For a scoring problem, two details help most. State whether the game was **file-only or connected**.
State the **browser and device** in the room, because a Chromebook in a tournament and a desktop Chrome
tab are not the same environment.

**Do not paste a room access token, a session token, or a pairing code into a public issue.** Remove
roster data too, unless the tournament data is already public.

For a security vulnerability, do not open a public issue. Follow [`SECURITY.md`](SECURITY.md).

## License and attribution

AGPL-3.0-or-later. See [`LICENSE`](LICENSE). By a contribution you agree that the same terms license
your contribution.

QBSheet was extracted from the first-party scorer in YellowFruit/Fruity, and [`NOTICE.md`](NOTICE.md)
records that provenance. Leave an existing copyright header and attribution in place when you move or
refactor a file.
