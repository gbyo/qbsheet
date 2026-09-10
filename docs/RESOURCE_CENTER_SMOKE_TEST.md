# Resource Center live-upload smoke test (issue #764, workstream E)

Real uploads never run in CI (offline/deterministic by design). This document is the
manual operator protocol for proving QBSheet output against the real Quizbowl
Resource Center (`hsquizbowl.org/db`), plus the release checklist that re-verifies
the external parser whenever the compatibility renderer changes materially.

## Status

| Item | State | Date |
| ---- | ----- | ---- |
| Structural preflight + fixtures + offline compatibility tests | Implemented (#764) | 2026-09-10 |
| Single-phase live upload smoke test | **Not performed** — no operator account available | — |
| Multi-phase phase+combined smoke test | **Not applicable yet** — no combined exporter exists | — |

Until the single-phase smoke test below succeeds, Director must not label the
export "Resource Center compatible/ready" (enforced by
`PublishStatReport.test.tsx`; the UI says "preflighted … for manual upload").
`resourceCenterCompatibility.liveUploadVerified` in
`packages/tournament-formats/src/resourceCenterPreflight.ts` stays `false` until
then, and the row below is updated with the verification date.

## Rules (from #764)

- Do **not** commit credentials, cookies, CSRF tokens, session IDs, or private
  account data. Record only dates, report URLs, and pass/fail observations.
- The smoke test is a manual, authorized operator step. Automating the
  authenticated upload form is an explicit non-goal (#764, #767).
- Only the owner of a database entry may post statistics for it. Use a test or
  operator-owned tournament entry, never someone else's.

## Protocol — single-phase

Prerequisites: a Director tournament with at least one accepted game whose
Resource Center export downloads with zero preflight warnings (or with warnings
you have explicitly accepted).

1. In Director, open Exports → Resource Center report → Download ZIP.
2. Confirm the download was not refused by preflight (a refusal means the set
   is inconsistent — fix the tournament, do not work around the gate).
3. Sign into the forum account that owns the test tournament entry.
4. Select the tournament → `Edit tournament listing` → `Manage stat reports` →
   `Add stat report` (per `docs/HSQUIZBOWL_DIRECT_UPLOAD.md`).
5. Upload each prepared HTML file into its matching slot. The one verified
   field mapping is Resource Center `Scoreboard` → the file ending in
   `_games.html`; fill remaining slots by semantic report role, never by
   filename-substring guessing.
6. Submit and open the uploaded report from its public `/stats/<report>/…` URL.
7. Verify, view by view:
   - Standings, Individuals, Scoreboard, Team Detail, Player Detail, Round
     Report all render and navigate to each other;
   - standings records, individual totals, and game scores match Director;
   - special characters (accents, `&`, quotes) render correctly;
   - partial-detail games show the same limitation as Director;
   - forfeit games (if any) are represented sensibly;
   - Resource Center / third-party indexing shows the tables (spot-check one
     search or index view if available).
8. Verify replacing/updating the stat report follows the expected operator
   behavior (upload a corrected set, confirm the public URL reflects it).
9. Record below: date, tournament entry URL, report URL, QBSheet commit, and
   any parser behavior worth pinning (rejections, renames, encoding notes).

## Protocol — multi-phase (once a combined exporter exists)

In the same tournament or a second test entry:

1. Publish each phase report separately plus the combined report.
2. Confirm phase and combined reports coexist with sensible names/slugs.
3. Confirm each canonical accepted game appears exactly once in the combined
   report and phase populations match their scopes.

## Results log

| Date | Scope | Tournament entry | Public report URL | QBSheet commit | Result / notes |
| ---- | ----- | ---------------- | ----------------- | -------------- | -------------- |
| — | single-phase | — | — | — | Not performed |
| — | multi-phase | — | — | — | Exporter does not exist yet |

## Manual release checklist

Re-run the single-phase protocol (steps 1–9) before any release whose diff
touches the compatibility renderer or its inputs:

- `packages/tournament-formats/src/resourceCenterReport.ts`
- `packages/tournament-formats/src/resourceCenterPreflight.ts`
- `packages/tournament-formats/src/reportHtml.ts`
- `packages/tournament-formats/src/rulesAwareReport.ts`
- `packages/tournament-formats/src/boxScoreReport.ts`
- `packages/tournament-formats/src/teamDetailReport.ts`
- `packages/tournament-formats/src/playerDetailReport.ts`
- `src/director/reports/resourceCenterExport.ts`
- the canonical snapshot builders feeding the above

After a successful re-verification, update the verification date in
`resourceCenterCompatibility.structuralPreflightDate`, the fixture provenance
(`packages/tournament-formats/tests/fixtures/resource-center/README.md`), and
the results log above. Delete nothing: behavior of this undocumented external
parser can change, and the log is how we notice.
