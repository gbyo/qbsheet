# Resource Center reference fixtures (issue #764, workstream A)

Sanitized reference report sets for the tournament formats the Quizbowl
Resource Center accepts (per current ACF statkeeping guidance: YellowFruit or
SQBS HTML). All team/player names are synthetic. No private tournament or
question content is included.

## Sets

### `yellowfruit/naqt-synthetic/` — genuine YellowFruit output

- Software: **YellowFruit 4.0.18** (`https://github.com/ANadig/YellowFruit`,
  commit `3f9113096839d4e3c944adee33366e8ebde77b75`, 2026-06-21).
- How produced: YellowFruit's own `HtmlReportGenerator` driven headlessly
  (bundled `src/renderer/DataModel` with esbuild, no Electron): a synthetic
  4-team single-pool round robin (Alder, Birch, Cedar, Dogwood; 3 players per
  team) under the built-in **NAQT untimed** rule set (15-point powers,
  10-point gets, −5 negs, bonuses, 20 tossups), 3 rounds / 6 games, compiled
  with `compileStats(true)` exactly as the app does before export. The
  generator script is throwaway tooling (kept outside the repo); re-running it
  against the pinned commit reproduces these bytes.
- Files and report roles (YellowFruit's bare `StatReportFileNames`):

  | File                | Report role   |
  | ------------------- | ------------- |
  | `standings.html`    | Standings     |
  | `individuals.html`  | Individuals   |
  | `games.html`        | Scoreboard    |
  | `teamdetail.html`   | Team Detail   |
  | `playerdetail.html` | Player Detail |
  | `rounds.html`       | Round Report  |

- Structural notes (pinned by `resourceCenterCompatibility.test.ts`): pages
  are `<HTML>` documents with **no doctype and no declared charset**; the nav
  uses unquoted same-directory `HREF=` links; each page inlines its own
  `<style>` block; standings columns are `Rank Team W L Pct PP20TUH 15 10 -5
  TUH PPB`. The uploader evidently accepts this shape, so compatibility tests
  assert parser-relevant structure (roles, tables, links, identities) and
  never require YellowFruit's exact shell.
- Resource Center upload of this fixture: **not performed** (no operator
  account in CI). See `docs/RESOURCE_CENTER_SMOKE_TEST.md`.
- Date last verified (generated): **2026-09-10**.

### `sqbs/naqt-synthetic/` — SQBS structural reference (not SQBS output)

- Software: **SQBS (version not observable here)**. SQBS is closed-source and
  Windows-only, so no genuine SQBS HTML could be produced in this environment.
  These files are **hand-authored structural references**, one per report
  role, illustrating SQBS's documented conventions for the same synthetic
  4-team tournament:
  - one HTML document per report with the conventional
    `<base>_<role>.html` suffixes — the same seven suffixes SQBS advertises
    in its own `.sqbs` settings block (rounds, standings, individuals, games,
    teamdetail, playerdetail, statkey; see `src/sqbs.ts`);
  - a linked nav across the set; standings/individuals/scoreboard/team-detail/
    player-detail/round-report/stat-key tables with internally coherent
    records and scores (standings PF/PA reconcile with the scoreboard).
- Each file carries an HTML comment stating it is not SQBS output. Replace
  this set with genuine sanitized SQBS output (plus the SQBS version) the
  next time an operator with SQBS access re-verifies.
- Resource Center upload of this fixture: **not performed**.
- Date last verified (authored): **2026-09-10**.

## Fixture family coverage (issue #764 workstream A)

| Family                        | Covered by                                            |
| ----------------------------- | ----------------------------------------------------- |
| Standard powers/gets/negs + bonuses | Both sets (`naqt-synthetic`)                    |
| No powers                     | QBSheet unit tests (`resourceCenterReport.test.ts`)   |
| Divisions/pools               | YF set (Pool A) + QBSheet unit tests                  |
| Multi-phase                   | Deferred — no combined exporter exists yet (see #764) |
| Forfeits                      | QBSheet unit tests                                    |
| Ties/overtime                 | QBSheet unit tests                                    |
| Zero/empty stats              | QBSheet unit tests                                    |
| Unicode/special characters    | QBSheet unit tests + preflight sanitizer tests        |
| Partial detail                | QBSheet unit tests + preflight warnings               |

## Rules

- Never add real team/player names or private content to these fixtures.
- Never commit credentials, cookies, CSRF tokens, or session material
  alongside upload evidence. The live smoke test is a manual operator step
  documented in `docs/RESOURCE_CENTER_SMOKE_TEST.md`.
- CI stays offline: tests read these files from disk; no network.
