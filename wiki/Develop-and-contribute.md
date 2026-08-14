# Develop and contribute

This page summarises the contribution rules. The normative document is
[`CONTRIBUTING.md`](https://github.com/gbyo/qbsheet/blob/main/CONTRIBUTING.md). Read it before you
open a pull request.

The Code of Conduct governs participation. Report a vulnerability with
[`SECURITY.md`](https://github.com/gbyo/qbsheet/blob/main/SECURITY.md). Do not open a public issue for
a vulnerability.

## Where a change belongs

| Change | Repository |
| --- | --- |
| The scoresheet, the scorer core, QBJ parsing, practice mode, hosting | `gbyo/qbsheet` |
| The QBTCP specification or the QBJ profile | `gbyo/qbsheet`, in `docs/` |
| Desktop statkeeping, Match Plan, Tournament Control, reports, `.yft`, SQBS, the room host | `gbyo/fruity` |

QBSheet is one scoresheet implementation. Fruity is one tournament control implementation. Neither
owns the protocol. A change to the wire surface usually needs a pull request in both repositories, and
each one links to the other.

## Four boundaries that shape every review

1. **The core is browser-independent.** `src/core/index.ts` is the package entry point that Fruity
   consumes. It must stay free of React, DOM, and persistence imports. Anything that you export there
   becomes the dependency of another project.

2. **A portable file carries no operational secret.** A QBJ document from QBSheet never holds a room
   token, a session token, a pairing code, a device identifier, a server address, or the local
   journal.

3. **A QBTCP assignment body is a QBJ document.** The connected path and the file path go through one
   parser, so they cannot drift apart.

4. **The local event journal is authoritative for recovery.** A partial QBJ file is not. It cannot
   hold the event history, the undo history, the clock internals, the connection state, or the queue.

The tests defend all four.

## Set up

```sh
git clone https://github.com/gbyo/qbsheet.git
```

```sh
cd qbsheet && npm ci && npm start
```

CI runs Node 20. Develop against that version.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/core/` | The package entry point, a barrel over the browser-independent modules |
| `src/scoring/` | Score events, the guard that decides what applies, and the reducers |
| `src/scorer/` | The scoring interface over those reducers |
| `src/qbj/` | QBJ serialisation, assignment parsing, scoring rules, the `_qbtcp` extension |
| `src/qbtcp/` | The route table, exported so a server can route on the table that the client calls |
| `src/game/` | The game definition, the packages, the portable QBJ, the rosters |
| `src/app/` | The shell: welcome, file open, connected setup, scoring screen |
| `src/persistence/` | The IndexedDB store and the tab claim |
| `src/practice/` | Guided practice mode |
| `docs/` | The specifications, the migration, and the test-file guide |
| `tests/`, `e2e/` | Application tests, integration tests, and the Playwright torture test |

## Run what CI runs

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

## Run more, by what you touched

| You changed | Also run |
| --- | --- |
| The scorer interface or the shell | `npm run test:browser` |
| Anything in `src/scoring/` | `npm run test:property` and `npm run test:state-space` |
| `canApplyScoreEvent.ts`, `questionCorrection.ts`, or `bonusOptions.ts` | `npm run test:mutation` |
| The core barrel or anything that it exports | `npm run build:core` |

The browser test needs Playwright once:

```sh
npx playwright install --with-deps chromium
```

`npm run test:mutation` runs Stryker over three files. It fails below a mutation score of 75 percent.
CI runs it weekly and on demand. A local run before a change to a scoring boundary is much faster than
a failure on Monday.

`npm run test:stress` is the deep state-space run. `QBSHEET_STRESS_SEEDS` and
`QBSHEET_STRESS_ACTIONS` drive it. A nightly workflow runs it with 5000 seeds.

## How the tests are arranged

- An engine test sits next to the engine, in `src/**/*.test.ts`.
- An application test and an integration test live in `tests/`.
- The jsdom origin is a real URL, because jsdom refuses `localStorage` on an opaque origin. The journal
  lives there.
- `fake-indexeddb` loads in the setup, so a test exercises the durable path.
- The setup clears storage between tests. A leftover journal must not make a recovery test pass for
  the wrong reason.
- Shared builders live in `tests/`. Extend those builders. Do not start a parallel set.
- Property tests use `fast-check`. The state-space suite checks the game machine exhaustively. Prefer
  those over one hand-picked case for a scoring bug.
- For a fixture, follow the test-file guide. Generate a valid file through the code that owns the
  format, then make the smallest mutation that the test needs. A hand-written approximation tests a
  shape that the applications never produce.

New behaviour needs a test. A bug fix needs a test that fails without the fix.

## Rules for a change to a specification

`docs/QBTCP.md` and `docs/QBJ_ASSIGNMENT_PROFILE.md` are normative. Other people implement them.

- Write for an implementer who will never read this codebase. If a rule only makes sense next to the
  source, the rule is underspecified.
- QBTCP does not restate QBJ. Where the protocol needs QBJ data, it carries a QBJ document.
- The protocol version is one integer in the path. Say in your pull request whether your change is
  additive, or whether it breaks a version-1 client.
- An `/api/v1` alias must still work, and it must never have its own logic.
- A legacy name is an opaque string. Do not rename a wire field for tidiness.
- Change the specification and the implementation in one pull request. Open the related Fruity pull
  request, so both sides land together.

## Code style

- TypeScript throughout. `.tsx` for a component. React 18 with hooks. No class components.
- `npm run lint` must be clean. The configuration includes `react-hooks` and `jsx-a11y`.
- Volunteers use this scoresheet on Chromebooks and phones under time pressure. Keep the touch
  targets large, keep the keyboard paths intact, and keep the labels legible. Accessibility here is
  not decoration.
- Match the code around you. This codebase comments the reason, not the line.

## Commits and pull requests

- Branch from `main`. A branch name looks like `topic/short-description`.
- Write an imperative commit subject. Use a `docs:` prefix for a documentation-only change.
- One concern per pull request.
- Say whether the change affects the core export surface, the contents of a portable file, or the wire
  surface. Those are the three things that other software can break on.
- CI must be green: lint, typecheck, tests, the project-path build, and the Playwright torture test.

## Report a bug

Open an issue and choose the form that fits.

For a scoring problem, two details help most:

1. Whether the game was file-only or connected.
2. The browser and the device in the room. A Chromebook in a tournament and a desktop tab are not the
   same environment.

**Do not paste a room token, a session token, or a pairing code into a public issue.** Remove roster
data too, unless the tournament data is already public.

## Related pages

- [Install and host](Install-and-host)
- [QBTCP for implementers](QBTCP-for-implementers)
- [Files and formats](Files-and-formats)
