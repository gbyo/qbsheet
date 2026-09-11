# YellowFruit Statistics Parity Contract

Reference: upstream `ANadig/YellowFruit`, audited at commit
`3f9113096839d4e3c944adee33366e8ebde77b75` (relevant report/stat
implementation; commit title "save lightning_points to file in snake case
(#117)", committed 2026-06-21 — existence re-verified via the GitHub API
during the September 2026 audit). YellowFruit is reference material only: no
YellowFruit code, text, or design is reproduced in QBSheet. No test fetches
YellowFruit; the hash is documentation only.

Audited YellowFruit functions behind the inventories below
(`src/renderer/DataModel/` at the pinned revision): `PoolTeamStats`
(`getRecord`, `getWinPct`, `getCorrectTuh`, `getPtsPerRegTuh`,
`getPtsPerBonus`, `getBouncebackConvPct`, `getLightningPtsPerMatch`,
`addMatchTeam`), `MatchTeam` (`getPointsForPPG`, `getBonusesHeard`,
`getBonusPoints`, `getOvertimePoints`), `Match` (`getResult`, `isForfeit`,
`getBouncebackPartsHeard`, `getScoreOnly`), `ScoringRules`
(`useOvertimeInPPTUH`, `bonusesAreRegular`, `canCalculateBounceBackPartsHeard`),
`PlayerStats` (`gamesPlayed` fractional, `getPptuh`), `RoundStats`
(`getPointsPerXTuh`, `getPowerPct`, `getNegsPerXTuh`, `getTotalBonusConvPct`,
`getLightningPointsPerTeamPerMatch`), and the `HTMLReports` table builders.
Two YellowFruit subtleties this matrix pins: round power/TU-conversion
percentages divide by **total** TUH (overtime included) while Pts/X-style
rates use regulation TUH; and the YellowFruit cumulative standings page omits
the win-% column (QBSheet showing the same formula there is qb-extra).

This document is the definition of done for epic #755. A row is `exact` only
when the formula and denominator match YellowFruit, proven by the owning test —
never because a column merely shares a name. QBSheet-extra statistics are
welcome but listed as such; they are not parity failures.

Owning work: #746 (TUH/normalized scoring/fractional GP), #747 (lightning),
#748 (bouncebacks), #749 (player metadata), #750 (Director), #751
(printable/exports), #753 (QBLive/iOS). Gate tests: `parityMatrix.test.ts`
(domain goldens incl. numerators/denominators/final values/applicability),
`tests/ParityMatrixSurfaces.test.ts` (Director/print/CSV/JSON/QBLive agreement),
`tests/QbLiveParity.test.ts` (Director/QBLive reconciliation),
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

| YellowFruit field                  | Definition (numerator / denominator)                                  | Applicability                           | Forfeit / OT                                    | QBSheet owner                                                           | Surfaces                                                                   | Status                                                           |
| ---------------------------------- | --------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Rank, tied rank                    | competition ranks (1, 1, 3) over record, points, margin, powers, gets | always                                  | forfeits count in W/L                           | `canonicalCompetitionRanks` (#750)                                      | Director display ranks, printable `=`, QBLive rank                         | exact                                                            |
| Record                             | W–L, plus ties when present                                           | always                                  | forfeit is a decision                           | `formatRecord`                                                          | all                                                                        | exact                                                            |
| Win %                              | (W + T/2) / GP                                                        | always; `—` with no games               | forfeits count                                  | domain `winPercentage`                                                  | all (`100.0%`)                                                             | exact                                                            |
| Games played                       | decided games counted                                                 | always                                  | forfeits count; pure forfeits add no TUH        | domain `gamesPlayed`                                                    | all                                                                        | exact                                                            |
| Normalized Pts/X                   | PPTUH × X over regulation TUH (OT excluded where YF excludes it)      | single-X scope                          | forfeit supplies no TUH                         | `normalizedPointsPerX` (#755)                                           | Director Pts/X, printable, QBLive `ppx` + team-stats (same value/rounding) | exact                                                            |
| Superpowers / powers / gets / negs | counts valued per game under that game's own definition (#671)        | tier defined by the format              | —                                               | domain aggregates                                                       | all, semantic columns                                                      | exact                                                            |
| Team TUH                           | Σ exact tossups-read; unknown if any non-forfeit game lacks it        | always                                  | pure forfeits contribute nothing                | domain `tossupsHeard[K nown]` (#746)                                    | all                                                                        | exact                                                            |
| PPTUH                              | points / TUH; null unless known and heard                             | TUH known                               | —                                               | `playerPptuh` (#751)                                                    | all (`17.50`)                                                              | exact                                                            |
| Bonuses heard / bonus points       | Σ heard / Σ points                                                    | bonuses used                            | —                                               | domain                                                                  | all                                                                        | exact                                                            |
| PPB                                | bonus points / bonuses heard; null when none heard                    | bonuses used                            | —                                               | `formatPpb`                                                             | all (`20.00`)                                                              | exact                                                            |
| Bounceback points                  | Σ known; unknown if any breakdown missing                             | bouncebacks used                        | forfeit without detail is skipped, never zeroed | domain `bouncebackPoints[Known]` (#748)                                 | all                                                                        | exact                                                            |
| BB parts heard                     | Σ opponent unconverted bonus value in parts                           | regular bonuses + known opponent detail | irregular bonuses decline to null               | `bouncebackPartsHeardForTeam` (#748)                                    | all                                                                        | exact                                                            |
| BB parts converted                 | Σ own bouncebacks in parts                                            | same                                    | same                                            | domain (#748)                                                           | all                                                                        | exact                                                            |
| BB %                               | converted / heard parts; null unless known and heard                  | same                                    | —                                               | domain `bouncebackConversion`                                           | all (`33.3%`)                                                              | exact                                                            |
| Total bonus %                      | (own + BB converted) / (own + BB heard) parts                         | every part known                        | —                                               | domain `totalBonusConversion`                                           | all (`59.0%`)                                                              | exact                                                            |
| Lightning points                   | Σ known; unknown if any game lacks the breakdown                      | lightning used                          | —                                               | domain `lightningPoints[Known]` (#747)                                  | all                                                                        | exact                                                            |
| Lightning / game                   | `lightningPoints / nonForfeitMatches`                                 | lightning used; known total             | pure forfeits excluded                          | `TeamStanding.lightningGames`: applicable non-forfeit games only (#755) | Director/print/QBLive (`40.0`)                                             | exact                                                            |
| Classifications                    | team reporting groups                                                 | present                                 | —                                               | `Team.classifications`                                                  | Director/print Group                                                       | exact; QBLive omits by design (#753, no second label vocabulary) |

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

| YellowFruit field      | QBSheet owner                                                                     | Status |
| ---------------------- | --------------------------------------------------------------------------------- | ------ |
| Games / results        | `deriveRoundStats`                                                                | exact  |
| Pts / team / X TUH     | normalized average                                                                | exact  |
| Superpower % / Power % | positives share                                                                   | exact  |
| TU conversion %        | converted / read                                                                  | exact  |
| Negs / X               | scaled rate                                                                       | exact  |
| PPB                    | points / heard                                                                    | exact  |
| Bonus Conv %           | points / Σ(BH × game max)                                                         | exact  |
| BB %                   | Σ converted / Σ heard parts over applicable games only (proven-N/A games excused) | exact  |
| Total Bonus %          | own+BB parts ratio (own parts stay whole-scope)                                   | exact  |
| Lightning / G          | points per team per game over applicable non-forfeit games                        | exact  |
| Overall row            | same formulas across the scope                                                    | exact  |

## September 2026 audit resolutions (#755)

Each remaining gap from the #755 audit was verified against current `main`,
fixed in the canonical domain/report layer, and pinned by a hermetic
regression test. Presentation code formats/selects/hides but never re-derives
these values.

| Gap                                                                              | Fix                                                                                                          | Test                                                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Printable Games/box scores showed internal `phaseId`                             | `boxScoreReport.ts` renders `phaseName`                                                                      | `boxScoreReport.test.ts` (#853)                                                              |
| QBLive/tier applicability followed current rules, not each game's own definition | `scopeScoringApplicability` in domain `stats.ts`; historical tiers union with mixed-definition flag          | `scopeApplicability.test.ts`, `historical-applicability.test.ts` (#868)                      |
| Team Pts/X and round Pts/team/X could include overtime points/TUH                | `normalizedPointsPerX` + `regulationDerivationForTeam`; regulation-split round derivations                   | `roundStatsOptional.test.ts`, `statsDisplay.test.ts`                                         |
| Lightning/G divided by all games played                                          | `TeamStanding.lightningGames`: lightning-applicable non-forfeit games; forfeit+lightning fixture pinned      | `scopeApplicability.test.ts` ("lightning denominator")                                       |
| Mixed bounceback-enabled/disabled scopes shared one denominator                  | disabled-definition games contribute neither opportunities nor unknowns                                      | `bouncebackParity.test.ts` ("mixed … stay known")                                            |
| Non-bounceback games storing numeric `bouncebacks: 0` entered parts denominators | pinned-definition N/A skip covers `0` and `null` in team aggregation, round stats, and report adapters       | `parityMatrix.test.ts` 15, `ParityMatrixSurfaces` mixed-N/A test                             |
| Non-lightning games with absent `lightningPoints` unknowned mixed scopes         | `accumulateTeamLightning`: N/A games contribute nothing; forfeit placeholders skipped                        | `parityMatrix.test.ts` 16, `ParityMatrixSurfaces` mixed-N/A test                             |
| QBLive published no normalized Pts/X                                             | canonical `ppx` column on standings + team-stats via `ppxFor` (regulation numerator/denominator, 2-decimal)  | `parity-columns.test.ts`, `ParityMatrixSurfaces` Pts/X tests                                 |
| Round sums/denominators included proven-N/A games                                | `applicableGames` scoping + null-when-empty sums; definition flags carry proven applicability                | `roundStats.test.ts` N/A tests, `ParityMatrixSurfaces` mixed-N/A test                        |
| Unknown overtime splits could smuggle overtime into Pts/X on some surfaces       | every surface consumes `regulationDerivationForTeam`; unknown split declines Pts/X, PPTUH stands             | `parityMatrix.test.ts` 17–18, QBLive fail-closed test, `ParityMatrixSurfaces` overtime tests |
| Roster UI could not view/edit year/UG/D2                                         | `TeamsView.tsx` year control + tri-state UG/D2 (`Yes`/`No`/`Unknown`), persisted via `useDirectorController` | `TeamsView.test.tsx` (#882)                                                                  |
| Player/Team Detail omitted UG/D2 markers and fabricated GP for partial appearances | `eligibilitySummary` prose markers under the Individuals predicate; `gamesPlayedKnown` gating via shared `reportGamesPlayedText` | `playerDetailReport.test.ts`, `teamDetailReport.test.ts` (#751) |
| Parity fixtures missed the above cases                                           | per-PR regression tests above; matrix extended below                                                         | —                                                                                            |

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
7. overtime excluded from regulation TUH;
8. substitutions → fractional GP (0.5);
9. 24-TU custom X + custom point values with mirror winners tied at rank 1;
10. pure forfeit (W/L counts, no TUH);
11. score-only partial result (detail unknown);
12. multi-round aggregation plus phase scoping;
13. known zero vs unknown (explicit zeroes stay comparable; nulls decline);
14. mixed historical definitions (per-game valuation);
15. mixed bounceback history where the off game stores `bouncebacks: 0` (N/A, not parts);
16. mixed lightning history where the off game carries no lightning field (N/A, not unknown);
17. overtime with a known split (normalized Pts/X excludes overtime points);
18. overtime-capable game with an unknown split (Pts/X declines, never guesses).

September 2026 audit modes (owning regression tests alongside the matrix):

18. overtime game where final points differ from regulation points
    (`roundStatsOptional.test.ts`);
19. pure forfeit mixed with lightning games — forfeit excluded from the
    Lightning/G denominator (`scopeApplicability.test.ts`);
20. historical lightning/bounceback/tossup-tier rules differing from current
    rules (`scopeApplicability.test.ts`,
    `historical-applicability.test.ts`);
21. mixed bounceback-enabled and bounceback-disabled games
    (`bouncebackParity.test.ts`);
22. roster year/UG/D2 edit persistence and round-trip (`TeamsView.test.tsx`);
23. `phaseName` vs `phaseId` on printable Games (`boxScoreReport.test.ts`).

Cross-surface proofs for the maximal fixtures: Director columns/values
(`StandingsView` tests), printable pages (`tournament-formats` report tests),
CSV/JSON exports (`team-csv-identity`, snapshot tests), QBLive columns/cells
(`qblive-projection` parity tests + `tests/QbLiveParity.test.ts`
reconciliation), iOS decode + privacy (`QBLiveFixtureTests`, maximal/privacy
fixtures). iOS renders the maximal tables generically — no stat-specific Swift
(the `TablesView` fallback contract, verified by review); the QBLive `ppx`
column therefore reaches installed apps with no client change.

`tests/ParityMatrixSurfaces.test.ts` additionally proves the hardest scopes agree
everywhere: mixed bounceback/lightning N/A history (numerators, denominators,
final values, and rounding identical across Director, printable, CSV/JSON, and
QBLive) and overtime known/unknown splits (Pts/X excludes overtime when known,
declines to `—`/null on every surface when the split is unknown).

## Maintenance

Goldens are hand-checked against the pinned revision's documented formulas;
`bouncebackParity.test.ts` records the audited #748 arithmetic. If YellowFruit
changes, update this matrix deliberately in its own PR with a source
diff — never silently change expected values. All parity tests are hermetic:
no network, no YellowFruit checkout, no Electron.
