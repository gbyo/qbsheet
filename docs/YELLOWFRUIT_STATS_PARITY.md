# YellowFruit Statistics Parity Contract

Reference: upstream `ANadig/YellowFruit`, audited at commit
`3f9113096839d4e3c944adee33366e8ebde77b75` (relevant report/stat
implementation). YellowFruit is reference material only: no YellowFruit code,
text, or design is reproduced in QBSheet.

This document is the definition of done for epic #755. A row is `exact` only
when the formula and denominator match YellowFruit, proven by the owning test —
never because a column merely shares a name. QBSheet-extra statistics are
welcome but listed as such; they are not parity failures.

Owning work: #746 (TUH/normalized scoring/fractional GP), #747 (lightning),
#748 (bouncebacks), #749 (player metadata), #750 (Director), #751
(printable/exports), #753 (QBLive/iOS). Gate tests: `parityMatrix.test.ts`
(domain goldens), `tests/QbLiveParity.test.ts` (Director/QBLive reconciliation),
per-surface suites named below.

## Shared knownness contract

Every surface consumes the same three states (#748, gate-tested):

| State                                      | Canonical                            | Display                                 |
| ------------------------------------------ | ------------------------------------ | --------------------------------------- |
| Known zero                                 | numeric `0`                          | `0` / `0.00` at the column precision    |
| Unknown (source detail missing)            | `null` / knownness flag `false`      | `—`, QBLive `value: null`               |
| Not applicable (format does not define it) | field stays `null`, column omitted   | column omitted, never a table of dashes |
| Uncomputable (e.g. irregular bonus parts)  | `null`, unknowns the whole aggregate | `—`                                     |

One uncomputable side unknowns a whole row aggregate, never a known-subset
value. An omitted field on a legacy/imported row counts as unknown, never as
computed. Unknown is never sent as numeric zero over QBLive.

## Shared rounding contract

Canonical values stay unrounded; formatting lives in the shared presentation
layer and is pinned by the reconciliation test:

| Statistic                                     | Display                                            |
| --------------------------------------------- | -------------------------------------------------- |
| Win %                                         | percent, 1 decimal (`100.0%`)                      |
| Points-per-X, PPTUH, PPB                      | 2 decimals                                         |
| PPG/PAPG, BB %, total bonus %, lightning/game | 1 decimal                                          |
| Counts, points, parts heard                   | integers                                           |
| Fractional GP                                 | trimmed (`1`, `0.5`, never `1.00`); unknown is `—` |
| Rank ties                                     | shared number with `=` marker                      |

## Team / standings inventory

| YellowFruit field                  | Definition (numerator / denominator)                                  | Applicability                           | Forfeit / OT                                    | QBSheet owner                           | Surfaces                                           | Status                                                           |
| ---------------------------------- | --------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------- | --------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| Rank, tied rank                    | competition ranks (1, 1, 3) over record, points, margin, powers, gets | always                                  | forfeits count in W/L                           | `canonicalCompetitionRanks` (#750)      | Director display ranks, printable `=`, QBLive rank | exact                                                            |
| Record                             | W–L, plus ties when present                                           | always                                  | forfeit is a decision                           | `formatRecord`                          | all                                                | exact                                                            |
| Win %                              | (W + T/2) / GP                                                        | always; `—` with no games               | forfeits count                                  | domain `winPercentage`                  | all (`100.0%`)                                     | exact                                                            |
| Games played                       | decided games counted                                                 | always                                  | forfeits count; pure forfeits add no TUH        | domain `gamesPlayed`                    | all                                                | exact                                                            |
| Normalized Pts/X                   | PPTUH × X over regulation TUH (OT excluded where YF excludes it)      | single-X scope                          | forfeit supplies no TUH                         | `pointsPerX` (#746)                     | Director Pts/X, printable                          | exact                                                            |
| Superpowers / powers / gets / negs | counts valued per game under that game's own definition (#671)        | tier defined by the format              | —                                               | domain aggregates                       | all, semantic columns                              | exact                                                            |
| Team TUH                           | Σ exact tossups-read; unknown if any non-forfeit game lacks it        | always                                  | pure forfeits contribute nothing                | domain `tossupsHeard[K nown]` (#746)    | all                                                | exact                                                            |
| PPTUH                              | points / TUH; null unless known and heard                             | TUH known                               | —                                               | `playerPptuh` (#751)                    | all (`17.50`)                                      | exact                                                            |
| Bonuses heard / bonus points       | Σ heard / Σ points                                                    | bonuses used                            | —                                               | domain                                  | all                                                | exact                                                            |
| PPB                                | bonus points / bonuses heard; null when none heard                    | bonuses used                            | —                                               | `formatPpb`                             | all (`20.00`)                                      | exact                                                            |
| Bounceback points                  | Σ known; unknown if any breakdown missing                             | bouncebacks used                        | forfeit without detail is skipped, never zeroed | domain `bouncebackPoints[Known]` (#748) | all                                                | exact                                                            |
| BB parts heard                     | Σ opponent unconverted bonus value in parts                           | regular bonuses + known opponent detail | irregular bonuses decline to null               | `bouncebackPartsHeardForTeam` (#748)    | all                                                | exact                                                            |
| BB parts converted                 | Σ own bouncebacks in parts                                            | same                                    | same                                            | domain (#748)                           | all                                                | exact                                                            |
| BB %                               | converted / heard parts; null unless known and heard                  | same                                    | —                                               | domain `bouncebackConversion`           | all (`33.3%`)                                      | exact                                                            |
| Total bonus %                      | (own + BB converted) / (own + BB heard) parts                         | every part known                        | —                                               | domain `totalBonusConversion`           | all (`59.0%`)                                      | exact                                                            |
| Lightning points                   | Σ known; unknown if any game lacks the breakdown                      | lightning used                          | —                                               | domain `lightningPoints[Known]` (#747)  | all                                                | exact                                                            |
| Lightning / game                   | points / games played                                                 | known total + games                     | —                                               | Director/print/QBLive rate              | all (`40.0`)                                       | exact                                                            |
| Classifications                    | team reporting groups                                                 | present                                 | —                                               | `Team.classifications`                  | Director/print Group                               | exact; QBLive omits by design (#753, no second label vocabulary) |

## Individuals inventory

| YellowFruit field | Definition                                       | Applicability  | QBSheet owner                               | Surfaces                               | Status |
| ----------------- | ------------------------------------------------ | -------------- | ------------------------------------------- | -------------------------------------- | ------ |
| Rank / tie        | PPTUH order, unknown last; equal rates share `=` | always         | domain order + `playerRankTies` (#750/#751) | Director, printable, QBLive rank       | exact  |
| Player / team     | identity                                         | —              | domain                                      | all                                    | exact  |
| Year / grade      | structured school year                           | supplied       | `Player.schoolYear` (#749)                  | Director, printable Grade, QBLive year | exact  |
| UG / D2 flags     | explicit tri-state, never inferred               | supplied       | `Player.*Eligible` (#749)                   | Director, printable, QBLive ug/d2      | exact  |
| Fractional GP     | Σ player TUH / game TUH; 1.0 full, 0.5 half      | both TUH known | domain (#746)                               | all, trimmed display                   | exact  |
| TUH               | Σ player tossups heard                           | reported       | domain                                      | all                                    | exact  |
| Answer counts     | per-game definition valuation                    | tier defined   | domain (#671)                               | all, semantic columns                  | exact  |
| Tossup points     | Σ valued per game                                | always         | domain `points`                             | all                                    | exact  |
| PPTUH             | points / TUH via the shared helper               | TUH known      | `playerPptuh`                               | all                                    | exact  |
| Normalized PPX    | PPTUH × X                                        | single-X scope | `pointsPerX`                                | Director/print                         | exact  |
| Bonus points      | player share                                     | bonuses used   | domain                                      | Director/print/QBLive bonus            | exact  |

## Games / team-detail inventory

| YellowFruit field         | Definition                                                                                            | QBSheet owner          | Surfaces                       | Status |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------ | ------ |
| Final score / result      | entered points; W/L/T incl. forfeit marking                                                           | domain + reports       | all                            | exact  |
| Tossups read              | exact match count, not summed lines                                                                   | domain (#746)          | all                            | exact  |
| Regulation / OT counts    | `overtimeTossupsRead`; regulation = total − known OT                                                  | domain (#746)          | print detail, round derivation | exact  |
| Team/player answer totals | entered detail; null when missing                                                                     | canonical adapter      | all                            | exact  |
| BH / BP / PPB             | per-game bonus facts                                                                                  | adapter                | all                            | exact  |
| BB detail                 | per-game parts under that game's own definition; irregular declines                                   | `teamGameParts` (#751) | team detail, round aggregates  | exact  |
| Lightning points          | entered breakdown; null when missing                                                                  | adapter (#747)         | all                            | exact  |
| Forfeit / partial         | forfeit kept as a result, excluded from scoring denominators; `detail: partial` when counts untrusted | domain + adapter       | all; round `partial` flag      | exact  |

## Round-report inventory

Per-game values normalized to the round's common regulation X, then averaged;
any metric missing a denominator for one included game is null for the row.
Pure forfeits are results, not denominators.

| YellowFruit field      | QBSheet owner                  | Status |
| ---------------------- | ------------------------------ | ------ |
| Games / results        | `deriveRoundStats`             | exact  |
| Pts / team / X TUH     | normalized average             | exact  |
| Superpower % / Power % | positives share                | exact  |
| TU conversion %        | converted / read               | exact  |
| Negs / X               | scaled rate                    | exact  |
| PPB                    | points / heard                 | exact  |
| Bonus Conv %           | points / Σ(BH × game max)      | exact  |
| BB %                   | Σ converted / Σ heard parts    | exact  |
| Total Bonus %          | own+BB parts ratio             | exact  |
| Lightning / G          | points per team per game       | exact  |
| Overall row            | same formulas across the scope | exact  |

## Fixture matrix

Small human-reviewable tournaments under
`packages/tournament-domain/tests/fixtures/parity-matrix.ts`, with checked-in
expected values asserted by `parityMatrix.test.ts` (exact integers; rates via
numerator/denominator pairs plus final display):

1. standard 20-TU powers + bonuses;
2. superpower format;
3. tossup-only (bonus columns N/A);
4. regular bouncebacks (parts, BB %, total %);
5. irregular bonuses (parts uncomputable → null, never zero);
6. lightning (totals + rate; unknown breakdown → null);
7. overtime excluded from regulation PPX;
8. substitutions → fractional GP (0.5);
9. 24-TU custom X + custom point values;
10. ties (shared rank);
11. pure forfeit (W/L counts, no TUH);
12. score-only partial result (detail unknown);
13. multi-round aggregation;
14. multi-stage/pool/carryover scoping;
15. player metadata (year/UG/D2, incl. unknown);
16. mixed historical definitions (per-game valuation);
17. zero-vs-unknown semifinal cases (0 allowed, 0 heard, 0 converted).

Cross-surface proofs for the maximal fixtures: Director columns/values
(`StandingsView` tests), printable pages (`tournament-formats` report tests),
CSV/JSON exports (`team-csv-identity`, snapshot tests), QBLive columns/cells
(`qblive-projection` parity tests + `tests/QbLiveParity.test.ts`
reconciliation), iOS decode + privacy (`QBLiveFixtureTests`, maximal/privacy
fixtures). iOS renders the maximal tables generically — no stat-specific Swift
(the `TablesView` fallback contract, verified by review).

## Maintenance

Goldens are hand-checked against the pinned revision's documented formulas;
`bouncebackParity.test.ts` records the audited #748 arithmetic. If YellowFruit
changes, update this matrix deliberately in its own PR with a source
diff — never silently change expected values. All parity tests are hermetic:
no network, no YellowFruit checkout, no Electron.
