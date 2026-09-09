# Round report metric semantics

The printable Round Report is derived from accepted game facts in `@qbsheet/tournament-domain`.
The HTML renderer only formats the already-derived values.

## Included results

`Games` counts accepted competitive results in the report scope, including forfeits. A scoreless
administrative forfeit remains a standings result but does not contribute scoring denominators unless
there is evidence that questions were actually played.

## Base metrics

- **Pts/team/reg** — total recorded team points divided by exact team-tossup opportunities, multiplied
  by the common historical regulation tossup count for the row. If exact tossups read are missing, or
  the included games use different/unknown regulation lengths, the metric is unavailable.
- **TU Conv %** — superpowers + powers + ordinary positive gets divided by exact tossups read. The
  tossups-read value includes overtime when the source reports it that way; QBSheet scorer QBJ does.
- **SP % / Power %** — the applicable answer tier divided by all positive tossup conversions. A tier
  is shown only when the game definitions establish that it exists; mixed/unknown applicability is
  not collapsed into a deceptively precise rate.
- **Negs/reg** — total negs divided by exact tossups read, multiplied by the common historical
  regulation tossup count.
- **PPB** — total bonus points divided by bonuses heard. Every applicable played game must provide the
  bonus denominator; a known subset is not presented as the whole round.
- **Bonus Conv %** — total bonus points divided by the historical maximum points available on the
  bonuses heard. The maximum comes from each game’s own QBJ scoring definition.

The Overall footer runs the same derivation over all games in scope. Percentages and PPB are never
averages of round percentages.

## Historical definitions

Round normalization and applicability use the scoring definition embedded in each accepted game’s
raw QBJ when available. Current tournament defaults are not used as a fallback for a historical game
whose exact definition is missing; definition-dependent metrics become unavailable instead.

## Unsupported optional denominators

Director currently persists bounceback **points**, not bounceback opportunities, so a bounceback
conversion percentage cannot be reconstructed honestly. Director’s canonical `GameRecord` also does
not currently persist lightning points. The report therefore omits those optional columns instead of
fabricating them. When those canonical facts are added, they should be aggregated in the domain layer
under the same all-games-known policy before a renderer exposes them.
