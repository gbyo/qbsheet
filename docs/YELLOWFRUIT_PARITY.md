# YellowFruit Parity Matrix

Behavioral reference: upstream `ANadig/YellowFruit` (desktop statkeeping app,
`y.yellowfruit.app`), surveyed September 2026 from release notes, app docs,
NAQT usage guidance, and public file/component inventory. YellowFruit is
reference material only: no YellowFruit code, text, or design is reproduced in
QBSheet, and QBSheet implements everything below in its own architecture.

Classes:

- **better** — QBSheet already meets or exceeds the capability.
- **equivalent** — QBSheet covers it; differences are workflow, not power.
- **native** — intentionally replaced by a QBSheet-native equivalent.
- **planned (PR n)** — implemented in this effort, in the listed PR.
- **gap** — genuinely unsupported, with the technical reason.

Planned-work PRs: PR 1 rounds-first foundation · PR 2 orchestration +
progressive structure · PR 3 scoring rules · PR 4 stats + reporting ·
PR 5 interchange + parity completion.

## Tournament setup

| Capability | Class | Notes |
|---|---|---|
| Tournament name / venue / date | equivalent | Settings covers name, date, venue, timezone; item 24 adds organizer, end date, question set in PR 2 |
| Organizer, end date, question-set name | planned (PR 2) | Optional metadata fields; question set feeds packet/export metadata |
| Scoring-rule presets (ACF/powers, tossup-only, lightning variants) | planned (PR 3) | Must verify exact semantics before encoding; presets fill the canonical model, never replace it |
| Granular scoring rules (tossup tiers, neg, bonuses, bouncebacks, divisor, overtime, round length, max players) | planned (PR 3) | One canonical rule model shared with QBJ/scorer; no second lossy model |
| Rule lock once games exist | planned (PR 3) | Lock reinterpretation or scope new rules per stage; never silent re-score |
| Bonus-bounceback validation, overtime counts, tossup-only stats | planned (PR 3–4) | Follows the canonical rules + honest-unknown stats |
| Multi-quarter manual-bonus formats | gap | Open gap in YellowFruit itself; QBSheet does not invent scoring semantics its scorer cannot enforce |
| Forfeit games | equivalent | Recognized on ingest and in Teams; full played/forfeit/cancelled semantics unified under the canonical stats engine in PR 4 |
| Numeric-vs-named rounds, default round for new games | native | Rounds carry numbers; timeline events carry titles; day order is explicit sequence, not naming |
| Config lock once games exist | equivalent | Pool lock after first round exists; generalized in PR 3 |

## Teams, players, seeding

| Capability | Class | Notes |
|---|---|---|
| Add/edit/rename teams, bulk paste, CSV import | better | Paste + CSV + org model + per-row seed/status |
| Large rosters, player year tracking | planned (PR 4) | Structured year/grade, not notes; with Small School / JV / Undergraduate / D2 style classifications |
| Reporting classifications (Small School, JV, player year, Undergrad/D2) | planned (PR 4) | Progressive enable-then-use; persisted, exported, Live-safe (no private notes leak) |
| Seeding view / team ordering | equivalent | Per-team seed on registrations; pool-placement UI in PR 2 |
| NAQT-template / MODAQ roster bootstrap | gap | No NAQT-registration or MODAQ import; migration path is CSV / SQBS-roster / QBJ instead |

## Structure: stages, divisions, schedules

| Capability | Class | Notes |
|---|---|---|
| Named stages (prelims, playoffs, superplayoffs, placement) | planned (PR 2) | Phase stays the domain; user-facing "Stage" appears only once a second stage exists |
| Tiebreaker / Finals special stages | planned (PR 2) | Modelled as stages/rounds, surfaced contextually |
| Divisions/pools with per-phase membership | equivalent | Pool domain exists; contextual human-first setup UI in PR 2 |
| Grouping-phase hierarchy for final ordering | planned (PR 4) | Falls out of stage scopes + final-placement overrides |
| Schedule templates for 4–54-team fields | native | Replaced by `formatPlan.ts` recommendations with honest consequence previews (PR 2), not static templates |
| Template-assisted rebracketing + carryover | planned (PR 2) | Advancement preview with wildcards + manual rebracket + human carryover language; carryover domain already exists |
| Automatic advancement engine | equivalent | `advancementRule` + preview exists; richer rules and UI in PR 2 |
| Wildcard advancement | planned (PR 2) | Neither app has it today; QBSheet adds top-N + best-M-remaining with tiebreak order and commit-time preview |
| Manual rebracketing with audit | planned (PR 2) | Proposed assignments editable before commit; overrides explicit and auditable, never rewriting results |
| Final ranking overrides | planned (PR 4) | Explicit overlay (actor, timestamp, reason), resettable, feeds standings/Live/reports/CSV/SQBS; raw scores and W/L untouched |
| Phase-record ranking, per-stage columns | planned (PR 4) | Stage scopes appear only when meaningful |

## Games and corrections

| Capability | Class | Notes |
|---|---|---|
| Manual result entry, per-question scoring, tiebreaker flag | better | Multi-transport inbox (manual, QBTCP, USB, QBJ) with review/accept/correct/protest in one place |
| Save-and-new speed entry | equivalent | Enter-result flow stays one action |
| Editable games after entry, rename/stage validation | equivalent | Correction pipeline with superseded history |
| Invalid matches excluded on import | equivalent | Ingest validation already excludes bad matches |
| Inline per-game errors/warnings, dismissible | equivalent | Inline validation + correction reasons; dismiss semantics reviewed in PR 2 |
| Protests with rulings and audit | better | No YellowFruit equivalent at this depth; preserved as-is |

## Standings and reports

| Capability | Class | Notes |
|---|---|---|
| Team standings (W-L, pct, PPG, TUH/PPTUH, PPB, powers/negs) | equivalent | Derived tables exist; canonical engine unifying Director/Live/CSV/HTML/advancement/SQBS lands in PR 4 |
| PP20 / points-per-X display | gap | Minor; not scheduled — PPG/PPTUH cover the need |
| Individual stats (GP, powers/gets/negs, TUH, PPTUH, points, PPG) | planned (PR 4) | Full Individuals view; zero-TUH handling honest (unknown vs zero) |
| Team detail (game log + aggregates) | planned (PR 4) | Stats workspace section |
| Player detail (game-by-game lines) | planned (PR 4) | Stats workspace section |
| Round/game aggregates | planned (PR 4) | Stats workspace section |
| Report column/page configuration | planned (PR 4) | Sensible defaults; optional column picker, persisted |
| In-app printing | equivalent | Publish Print path preserved |
| Static HTML bundle (standings, individuals, games, teamdetail, playerdetail, rounds) | planned (PR 4) | Six linked pages, no JS, deterministic, escaped, canonical-engine-backed; single standings.html exists today |
| Scoreboard HTML page | planned (PR 4) | Included in the bundle scope |
| Unknown-stats honesty (no fabricated zeroes) | planned (PR 4) | Canonical model distinguishes known-zero from unknown; renders as —/N/A; rankings decline or warn on missing data |

## Interop

| Capability | Class | Notes |
|---|---|---|
| SQBS roster import | implemented (PR 5) | Parser in `tournament-formats`; Teams offers Import CSV and Import SQBS through one shared mapping with stable identity; Scenario K covers same-organization teams |
| Full SQBS tournament export | implemented (PR 5) | Canonical-engine exporter (teams, players, games, scores, detail, divisions); roster-only helper retained and labeled as such |
| Multi-stage SQBS (per-stage files, combine warnings) | implemented (PR 5) | Publish offers per-stage scope, overall-with-warning, or each-stage-as-its-own-file; pools map to divisions within one stage |
| QBJ single-game import (incl. Neg5/MODAQ variants) | equivalent | Multi-round batch import exists |
| QBJ tournament export (v2, match IDs) | better | Preserved and extended (day order, classifications, final placement via safe extensions) |
| Assignment QBJ minimality | better | Minimal assignments already; no future-pairing or private leakage |
| MODAQ game-file import | gap | Covered by generic QBJ import where schemas overlap; no MODAQ-specific path |
| `.yft` (YellowFruit file) import | implemented (PR 5) | Read-only importer (`tournament-formats/yft`, no YellowFruit source): metadata, scoring rules, teams/players, stages, pools, rounds, games with detail, seeds, classifications, final ranks; unrepresentable items reported, never dropped silently; verified against a real 12-team two-stage file |
| `.yft` export | gap | Deliberate: QBSheet archive/QBJ is the modern format; no symmetry export |

## Persistence and operations

| Capability | Class | Notes |
|---|---|---|
| Tournament persistence + recovery | better | SQLite (native) / IndexedDB (browser) + checkpoints + audit history vs single-file autosave |
| Auto-save | better | Every mutation persists durably; no 5-minute window |
| Open older-version files, migrations | better | Versioned schema with explicit per-version migrations; day-order migration in PR 1 |
| Electronic rooms (QBTCP), USB transfers, packets, Live publication, checkpoints, audit | better | No YellowFruit equivalent; all preserved and contextualized, never removed |

## Deliberate non-parity

QBSheet does not reproduce: static schedule-template picker (replaced by
consequence-showing recommendations), `.yft` as a format (read-only import at
most), legacy QBJ 1.2-only flows, or MODAQ/NAQT-registration bootstrap. None of
these limits a director moving from YellowFruit when CSV, SQBS, QBJ, and
`.yft` import paths exist. Known `.yft` import limits: schedule-template
pairings are not carried (games come from the file), per-buzz overtime
detail is preserved but not stat-counted, packet inventory is not stored in
`.yft` and must be recreated, and advancement rules must be re-entered as
Director advancement rules.
