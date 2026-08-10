<!--
Thanks for contributing. CONTRIBUTING.md has the details:
https://github.com/gbyo/qbsheet/blob/main/CONTRIBUTING.md

Delete any section below that does not apply.
-->

## What this changes

<!-- What behavior is different after this PR, and why. Link the issue it closes: "Closes #123". -->

## How it was tested

<!--
Which test files cover this. For a bug fix, name the test that fails without the change.
For a scoring change, say whether you added to the property or state-space suites.
-->

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test -- --run`
- [ ] `BASE_PATH=/qbsheet/ npm run build` — the project-path build, which is what catches assets that only resolve at a domain root
- [ ] New behavior has a test; a bug fix has a test that fails without the change

Extra suites, if they apply:

- [ ] `npm run test:browser` — scorer UI or app shell changed
- [ ] `npm run test:property` and `npm run test:state-space` — anything in `src/scoring/` changed
- [ ] `npm run test:mutation` — `canApplyScoreEvent.ts`, `questionCorrection.ts`, or `bonusOptions.ts` changed
- [ ] `npm run build:core` — the core barrel or something it exports changed

## Boundaries touched

<!-- Tick what applies. These are the three things a downstream implementation can break on. -->

- [ ] **Core export surface** (`src/core/index.ts`) — still free of React, DOM, and persistence imports, so Fruity runs the same engine
- [ ] **Portable file contents** — still no room token, session token, pairing code, device id, server address, or recovery journal in any QBJ this writes
- [ ] **Wire surface** (QBTCP) — see the section below
- [ ] None of the above

## Recovery and offline behavior

<!-- Required if this touches scoring, persistence, the service worker, or the connected session. Write "No exposure" if there is none. -->

- [ ] The local event journal is still authoritative for recovery; no work is lost across a reload or a lost connection
- [ ] Scoring still works with no network at all, and with no backend
- [ ] The scoresheet still stays usable, and still says so, when IndexedDB is unavailable
- [ ] The service worker still does not cache tournament-control responses

## Protocol or format change

<!-- Delete this whole section if the specs and the wire surface are untouched. -->

- [ ] `docs/QBTCP.md` and/or `docs/QBJ_ASSIGNMENT_PROFILE.md` updated in this PR, not in a follow-up
- [ ] Additive in protocol v1 — an existing v1 client keeps working and can ignore it
  <!-- If it is breaking instead, say so here and explain why a v1 client cannot tolerate it. -->
- [ ] Nothing from QBJ's schema is restated; where the protocol needs it, it carries a QBJ document
- [ ] No existing wire field is renamed — legacy names are opaque strings deployed clients still read
- [ ] `/api/v1` aliases still resolve to the same behavior, with no independent implementation
- [ ] Implementable from the spec alone, without reading this repository
- [ ] The matching [`gbyo/fruity`](https://github.com/gbyo/fruity) PR is open and linked here

## Screenshots

<!-- For UI changes. A Chromebook-width viewport is more representative than a desktop one. -->
