# Contributing to QBSheet

Thanks for wanting to help. QBSheet is an offline-first browser scoresheet for quiz bowl, and it is
also the canonical home of the scorer core, the QBJ reader, and the QBTCP and QBJ-profile
specifications that other software implements. Those two roles set most of the rules below.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Where a change belongs

| Change | Repository |
| --- | --- |
| The scoresheet app, the scorer core, QBJ parsing and output, practice mode, PWA and static hosting | this one |
| The QBTCP specification or the QBJ assignment profile | this one — `docs/` is the spec, not a mirror of it |
| Desktop statkeeping, Match Plan, Tournament Control, reports, `.yft`/SQBS, the room host | [`gbyo/fruity`](https://github.com/gbyo/fruity) |

QBSheet is one scoresheet implementation of QBTCP and Fruity is one tournament-control
implementation. Neither owns the protocol. A change to the wire surface usually needs a pull request
in both repositories, linked to each other.

## Two boundaries that shape everything

Most review comments here trace back to one of these, so they are worth knowing before you start.

**The core is browser-independent.** `src/core/index.ts` is the package entry point Fruity consumes
as a Git dependency. It must stay free of React, DOM, and persistence imports so the desktop host
runs the exact same engine rather than a second copy of it. Anything you export from there becomes
someone else's dependency.

**Portable files carry no operational secrets.** A QBJ document written by QBSheet never contains a
room or session token, a pairing code, a device id, a server address, or the local recovery journal.
The privacy rules are in [`docs/QBJ_ASSIGNMENT_PROFILE.md`](docs/QBJ_ASSIGNMENT_PROFILE.md).

Two more invariants the tests actively defend:

* **A QBTCP assignment body *is* a QBJ document**, so the connected path and the file path go through
  one parser and cannot drift apart.
* **The local event journal is authoritative for recovery**, not a partial QBJ. A downloaded partial
  is a lifeboat for a dead Chromebook; it cannot represent event history, undo, clock internals,
  connection state, or the outbox.

## Getting set up

Node 20 or newer. CI runs Node 20, so that is the safest version to develop against.

```sh
git clone https://github.com/gbyo/qbsheet.git
cd qbsheet
npm ci
npm start
```

`npm start` runs Vite, normally on `http://localhost:5173`. The app is fully usable from a QBJ file
with no server at all — open a game file and score.

To exercise the connected path, run Fruity's Local Tournament Server, add the Vite origin to its
QBSheet origin setting, and enter the server's LAN address in the scoresheet. The origin allowlist is
CORS only; room and session credentials still authenticate every room operation.

## Repository layout

| Path | What lives there |
| --- | --- |
| `src/core/` | the package entry point — a barrel over the browser-independent modules |
| `src/scoring/` | score events, the guard that decides what may be applied, and the reducers that derive a game |
| `src/scorer/` | the scoring UI over those reducers |
| `src/qbj/` | QBJ serialization, assignment parsing, scoring rules, the `_qbtcp` extension |
| `src/qbtcp/` | the route table, exported so a server can route on the same table the client calls |
| `src/game/` | game definition, packages, portable QBJ, rosters |
| `src/app/` | the application shell: welcome, file open, connected setup, scoring screen |
| `src/persistence/` | IndexedDB store and tab claim |
| `src/practice/` | guided practice mode |
| `docs/` | the QBTCP and QBJ profile specs, the `.qbg` migration, and the test-file guide |
| `tests/`, `e2e/` | application and integration tests; the Playwright torture test |

## Before you open a pull request

Run what CI runs:

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

The build is run under a project path on purpose. Vite emits relative asset paths by default, and
this is what catches a change that only works at a domain root — GitHub Pages deployments live below
a repository path.

Depending on what you touched, also run:

| If you changed | Run |
| --- | --- |
| the scorer UI or the app shell | `npm run test:browser` (needs `npx playwright install --with-deps chromium` once) |
| anything in `src/scoring/` | `npm run test:property` and `npm run test:state-space` |
| `canApplyScoreEvent.ts`, `questionCorrection.ts`, or `bonusOptions.ts` | `npm run test:mutation` |
| the core barrel or anything it exports | `npm run build:core` |

`npm run test:mutation` is Stryker over the three files listed in `stryker.config.json`, and it
breaks below 75% mutation score. It runs weekly in CI and on demand; running it locally before
changing a scoring boundary is much faster than finding out on Monday.

`npm run test:stress` is the deep state-space run, driven by `QBSHEET_STRESS_SEEDS` and
`QBSHEET_STRESS_ACTIONS`. A nightly workflow runs it with 5000 seeds; locally the default suite is
enough unless you are changing the state machine.

## Tests

Vitest, jsdom, `tests/setup.ts`, and a deliberate split:

* **Engine tests sit next to the engine** (`src/**/*.test.ts`). **Application and integration tests
  live in `tests/`.**
* The jsdom origin is set to a real URL in `vitest.config.ts`, because jsdom refuses `localStorage`
  on an opaque origin and the journal every scored question is written to lives there.
* `fake-indexeddb` is loaded in setup, so the durable path is exercised rather than an in-memory
  fallback. Each test starts from a device that has scored nothing; the setup file clears storage
  between tests so a leftover journal cannot make a recovery test pass for the wrong reason.
* Shared builders live in `tests/` — `qbjDocuments.ts`, `packages.ts`, `events.ts`, `rules.ts`,
  `appHarness.tsx`, `localStorage.ts`. Extend those rather than starting a parallel set.
* Property tests use `fast-check`; the state-space suite verifies the game machine exhaustively.
  If you are fixing a scoring bug, prefer adding to those over a single hand-picked case.
* For fixtures, follow [`docs/TEST_FILE_GENERATION.md`](docs/TEST_FILE_GENERATION.md): generate a
  valid file through the code that owns the format, then make the smallest mutation the test needs.
  Hand-written approximations test shapes the applications never produce.
* File header comments here say which claim the tests protect, not which module they cover. Keep
  that up — it is what makes a failure legible a year later.

New behavior needs a test. A bug fix needs a test that fails without the fix.

## Offline-first constraints

The build has no backend requirement, and that is a feature rather than a current limitation.

* No analytics, no telemetry, no font or script CDNs, no runtime calls to any origin other than a
  tournament-control server the operator typed in.
* Assets must keep working from a domain root, from below a repository path, and from a local
  directory. Use relative paths or `BASE_PATH`.
* The service worker deliberately does not cache responses from a tournament-control origin. A
  cached room assignment or result is a correctness bug, not a performance win.
* If persistence is unavailable, the scoresheet stays usable and says so. Do not add a code path
  that hard-fails when IndexedDB is missing.
* Completed records are kept locally for seven days, and are not deleted merely because a server
  accepted the result or a QBJ was downloaded.

## Changing the specifications

`docs/QBTCP.md` and `docs/QBJ_ASSIGNMENT_PROFILE.md` are normative documents that other people
implement. Treat them accordingly.

* **Write for an implementer who will not read this codebase.** Another tournament manager must be
  able to implement the spec without importing QBSheet or Fruity. If a rule only makes sense next to
  our source, it is underspecified.
* **QBTCP does not restate QBJ.** Tournament, Phase, Round, Team, Player, Match, ScoringRules, and
  statistics are QBJ's. Where the protocol needs them it carries a QBJ document and says so. A
  parallel team or match schema is a misreading of the spec.
* **The protocol version is a single integer in the path.** It is incremented only for a change a
  version-1 client cannot tolerate. Optional fields, optional endpoints, and new capabilities are
  additive and stay in v1 — so say in your pull request which of the two your change is.
* **`/api/v1` aliases stay working.** They are deprecated on introduction and carry no independent
  behavior. Never give an alias its own implementation.
* **Legacy names are opaque strings.** Do not rename a wire field for tidiness; a deployed client is
  reading it.
* Update the spec and the implementation in the same pull request, and open the matching Fruity pull
  request so the two sides land together.

## Code style

* TypeScript throughout, `.tsx` for components, React 18 with hooks. No class components.
* ESLint flat config in `eslint.config.js`, including `react-hooks` and `jsx-a11y`. `npm run lint`
  must be clean.
* The scoresheet is used on Chromebooks and phones by volunteers under time pressure. Keep touch
  targets large, keyboard paths intact, and labels legible; `jsx-a11y` is not decoration here.
* Match the surrounding code. This codebase comments the *why* — the invariant a function protects,
  the reason a fallback exists — rather than restating what the line does.

## Commits and pull requests

* Branch off `main`. Names in this repo look like `topic/short-description`, for example
  `gibby/qbtcp-qbj-architecture-spec`.
* Imperative commit subjects — "Read a round's number from Round.name". A `docs:` prefix is used for
  documentation-only changes; other prefixes are not required.
* One concern per pull request. The pull request template asks what changed, how it was tested, and
  which of the boundaries above it touches; delete the sections that do not apply.
* Say explicitly whether the change affects the core export surface, portable file contents, or the
  wire surface — those are the three things a downstream implementation can break on.
* CI must be green: lint, typecheck, tests, the project-path build, and the Playwright torture test.

## Reporting bugs

Open an issue and pick the form that fits. For a scoring problem, the two most useful details are
whether the game was **file-only or connected**, and the **browser and device** in the room —
a Chromebook mid-tournament and a desktop Chrome tab are not the same environment.

**Do not paste room access tokens, session tokens, or pairing codes into a public issue.** Scrub
rosters too if the tournament data is not already public.

For a security vulnerability, do not open a public issue — follow [`SECURITY.md`](SECURITY.md).

## License and attribution

AGPL-3.0-or-later; see [`LICENSE`](LICENSE). By contributing you agree your contribution is licensed
under the same terms.

QBSheet was extracted from the first-party scorer in YellowFruit/Fruity, and
[`NOTICE.md`](NOTICE.md) records that provenance. Leave existing copyright headers and attribution in
place when you move or refactor a file.
