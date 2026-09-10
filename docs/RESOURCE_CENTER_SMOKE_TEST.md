# Resource Center live-upload smoke test (issue #764, workstream E)

Real uploads never run in CI (offline/deterministic by design). This document is the
manual operator protocol for proving QBSheet output against the real Quizbowl
Resource Center (`hsquizbowl.org/db`), plus the release checklist that re-verifies
the external parser whenever the compatibility renderer changes materially.

## Status

| Item | State | Date |
| ---- | ----- | ---- |
| Structural preflight + fixtures + offline compatibility tests | Implemented (#764) | 2026-09-10 |
| Multi-phase phase + Combined exporter | Implemented (#763) | 2026-09-10 |
| Prepare-for-HSQuizbowl operator workflow | Implemented (#766) | 2026-09-10 |
| Single-phase live upload + replacement smoke test | **Not performed** — authorized operator action required | — |
| Multi-phase phase + Combined live upload smoke test | **Not performed** — authorized operator action required | — |

The two live-upload rows above are release evidence, not code-generation tasks. They
must remain visibly incomplete until an authorized operator actually submits QBSheet
output to a Resource Center tournament entry they own and verifies the public result.
Do not substitute a local browser render, fixture comparison, HTTP probe, or claim in
a PR description for that evidence.

Until the live smoke test succeeds, Director must not label the export "Resource
Center compatible/ready." `resourceCenterCompatibility.liveUploadVerified` in
`packages/tournament-formats/src/resourceCenterPreflight.ts` remains `false`, and the
UI uses save-scoped language such as **Ready to save** / **Saved — not yet published**.

## Rules

- Do **not** commit credentials, cookies, CSRF tokens, session IDs, or private account
  data. Record only dates, public report/tournament URLs, QBSheet commit, and
  pass/fail observations.
- The smoke test is a manual, authorized operator step. Automating the authenticated
  upload form is an explicit non-goal (#764, #767).
- Only use a Resource Center tournament entry the operator is authorized to manage.
- Use the exact package produced by **Exports → Quizbowl Resource Center → Prepare
  for HSQuizbowl**. Do not hand-edit HTML to make the test pass.
- Save/download the ZIP, extract it, and select the individual HTML files in the
  Resource Center form. Do not upload the ZIP itself.

## Protocol — single-stage

Prerequisite: a Director tournament with at least one accepted game whose Resource
Center report passes preflight (warnings may be accepted intentionally; blockers may
not be bypassed).

1. In Director, open **Exports → Quizbowl Resource Center → Prepare for HSQuizbowl**.
2. Confirm the **Overall** report set contains the expected accepted games and passes
   preflight. Resolve every blocking diagnostic before continuing.
3. Save/download the generated Resource Center ZIP and record its displayed revision.
4. Extract the ZIP. Keep the generated files unchanged.
5. Sign into the forum account that owns the test tournament entry.
6. Select the tournament → `Edit tournament listing` → `Manage stat reports` →
   `Add stat report`.
7. Upload each of the six required HTML files into its matching semantic field:
   - Standings → `*_standings.html`
   - Individuals → `*_individuals.html`
   - Scoreboard → `*_games.html`
   - Team Detail → `*_teamdetail.html`
   - Player Detail → `*_playerdetail.html`
   - Round Report → `*_rounds.html`

   The generated `*_statkey.html` is an optional SQBS/interoperability companion and
   is not part of the verified six-slot Resource Center upload workflow unless the
   authenticated form itself demonstrates otherwise.
8. Submit the report and open its public `/stats/<report>/...` page.
9. Verify all six public views render, navigate among one another, and agree with
   Director for records, scores, player totals, and known/unknown detail. Also check
   non-ASCII names/special characters and any represented forfeits or partial detail.
10. Make a small legitimate result correction in Director, regenerate the package,
    and use the Resource Center's normal edit/replace flow to update the same report.
11. Confirm the public report reflects the corrected result and no stale page remains.
12. Record the evidence in the results log below: date, public tournament/report URL,
    tested QBSheet commit, generated revision(s), and observed parser behavior.

## Protocol — multi-phase

Use a tournament with at least two phases containing accepted games. The normal
Resource Center convention is separate phase reports plus a Combined report.

1. Open **Prepare for HSQuizbowl** and use the recommended report-set selection.
   Configured future phases with no accepted games should not be required for the
   current package; explicitly selected empty scopes remain a preflight error.
2. Confirm each played phase is present and **Combined** contains every canonical
   accepted game exactly once.
3. Save/download and extract the package.
4. Add one Resource Center stat report for each phase plus one named **Combined**,
   selecting each set's six matching HTML files.
5. Confirm the reports coexist under sensible names and each public report opens.
6. Verify each phase contains only its intended stage results and Combined contains
   all accepted games exactly once. Verify carryover/tiebreaker notes against the
   Director configuration if those features are present.
7. Correct one result, regenerate the affected report package, replace/update the
   corresponding public report, and verify the correction appears publicly.
8. Record the evidence below.

## Results log

Do not mark a row Pass without a public Resource Center report that was actually
accepted by the authenticated uploader.

| Date | Scope | Tournament entry | Public report URL | QBSheet commit | Revision(s) | Result / notes |
| ---- | ----- | ---------------- | ----------------- | -------------- | ----------- | -------------- |
| — | single-stage + replacement | — | — | — | — | Not performed |
| — | multi-phase + Combined | — | — | — | — | Not performed |

## SQBS fixture evidence still required

The repository currently contains a genuine YellowFruit 4.0.18 fixture and an
honestly labeled hand-authored SQBS structural reference. The latter is **not** a
substitute for #764's requested genuine SQBS-generated fixture. SQBS's official site
currently identifies Version 4.0 as its latest Windows release and hosts an official
"Example Web Report Generated by the Program," which is useful external evidence for
the traditional seven-page report shape. Before #764 is considered fully complete,
bring a genuine SQBS-generated report set into the sanitized fixture corpus with its
version/provenance recorded; do not relabel the existing structural reference.

## Manual release checklist

Re-run the appropriate protocol above before a release whose diff materially changes
the compatibility renderer, canonical report inputs, or phase-scoping semantics:

- `packages/tournament-formats/src/resourceCenterReport.ts`
- `packages/tournament-formats/src/resourceCenterPreflight.ts`
- `packages/tournament-formats/src/reportHtml.ts`
- `packages/tournament-formats/src/rulesAwareReport.ts`
- `packages/tournament-formats/src/boxScoreReport.ts`
- `packages/tournament-formats/src/teamDetailReport.ts`
- `packages/tournament-formats/src/playerDetailReport.ts`
- `src/director/reports/resourceCenterExport.ts`
- `src/director/reports/resourceCenterScopes.ts`
- canonical snapshot builders feeding the above

After successful re-verification, update the results log and the verification date in
`resourceCenterCompatibility`. Keep prior results in the log so changes in the
undocumented external parser can be noticed rather than overwritten.
