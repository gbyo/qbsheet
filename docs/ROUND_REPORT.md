# Printable Round Report

Director's printable `rounds.html` report is a statistical summary of accepted results, not a second score list. Final scores remain on the Games page; each round label in the Round Report links to that round's first game there.

The report is derived from the same canonical accepted-game selection and report snapshot used by standings, CSV, and the other static pages. HTML only formats the already-derived rows.

## Included games

`Games` is the number of accepted, competitively played games in the round. A pure forfeit remains an accepted result for standings but contributes no scoring, conversion, tossup, or bonus denominator. If a forfeited game contains real played statistics (for example, play began before a later forfeit), those recorded facts may contribute.

Corrections/carryover are selected by the canonical accepted-game path before round aggregation. The report never scans the raw tournament arrays and counts every historical record independently.

## Core formulas

For a round with regulation length **X**:

- **Pts/team/X TUH** — for each included game, average the two team scores, normalize that value to X using the game's known tossups read, then average those normalized game values. X comes from the game's scoring definition; it is never hard-coded to 20.
- **TU Conv %** — `(superpowers + powers + gets) / tossups read` across all included games.
- **Power %** — `powers / (superpowers + powers + gets)`. A separate **SP %** column uses the analogous superpower numerator when that tier exists.
- **Negs/X** — `negs / tossups read * X`. This is intentionally a rate per X, not a percentage.
- **PPB** — `bonus points / bonuses heard`.
- **Bonus Conv %** — `bonus points / sum(bonuses heard × that game's maximum bonus score)`. This denominator is calculated per game, so compatible games with different maximum bonus values can still be combined honestly.

The **Overall** row runs these formulas again over all included games. It never averages round percentages or PPBs, which would overweight short rounds.

## Denominator and unknown policy

A ratio is shown only when its denominator and required numerator detail are trustworthy for **every** competitively played game in that row. If one game is missing a required denominator, the whole affected aggregate is `—`; Director does not silently calculate from the known subset.

Exact `tossups_read` from the accepted QBJ is preferred. If it is absent, regulation X may stand in for tossups read only when the game definition proves a fixed regulation length and proves that overtime was not possible. An overtime-capable game without an exact tossup count therefore leaves tossup-dependent metrics unknown.

If games in the same row use incompatible regulation X values, per-X metrics are unavailable. Definition-independent totals such as PPB or conversion rates can remain available when all of their own inputs are known.

## Historical scoring definitions

The report DTO carries a per-game `RoundStatDefinition`. The canonical Director adapter resolves the strongest historical evidence it currently has before deriving round statistics:

1. normalized per-game report facts when available;
2. exact scoring rules and tossup counts retained in the accepted game's raw QBJ;
3. for pre-#671 legacy records only, the tournament rule object as an explicitly tagged `legacy-tournament` fallback.

The renderer never opens raw QBJ and never reads current tournament rules. The legacy fallback is intentionally labeled as such so #671 can replace it with a persisted issued/corrected game definition without changing the formulas or report renderer. A new default must not be mistaken for historical proof.

## Stage and packet context

`Stage` is shown only when the current report scope contains multiple meaningful phases. A single-stage event does not spend a column repeating the same label.

Packet context is compact:

- one known packet used by every accepted result in the round → its canonical packet name;
- multiple packet names, or a mix of known and missing packet identity → `Mixed`;
- no packet identity anywhere → `—`/the Packet column may be omitted when irrelevant.

## Optional statistics

Columns are format-driven. Superpower, power, bonus, and bonus-conversion columns appear only when the included game definitions make them applicable. QBSheet does **not** currently expose a canonical bounceback-opportunity denominator or lightning-point field in this report DTO, so the Round Report does not invent bounceback percentages or lightning rates. Those columns should be added only when the canonical model can support their definitions directly.
