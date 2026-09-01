# `@qbsheet/tournament-formats`

The interchange boundary for QBSheet Director. It is intentionally independent of the Director
database: a database repository can map its records to `DirectorTournament`, export a portable
archive, and map an imported archive back without exposing SQLite rows to React.

## Portable archive

`.qbst` is a ZIP container with:

- `manifest.json`: format, schema, version, file inventory, tournament identity, and extensions;
- `data/tournament.json`: structured tournament data, never a raw SQLite database;
- optional `assets/**`: packet PDFs, logos, or other explicitly declared assets.

The manifest and data are versioned independently from the application. Unknown JSON fields and
unrecognized files are retained and surfaced as warnings, so importing an archive from a newer
Director build is diagnosable rather than destructive.

## Adapters

- `importQbj` / `exportQbjDocument` / `serializeQbjDocument` use the repository's QBJ 2.1.1 envelope
  and the existing `Tournament → Phase → Round → Match` spine. Bare Match files are accepted for
  compatibility.
- `importTeamsCsv` / `exportTeamsCsv` handle a quoted, row-oriented roster CSV.
- `importSqbsTeams` / `exportSqbsTeams` handle the positional SQBS roster interchange used by
  existing tournament tools.
- `buildStatsSnapshot`, `exportStatsJson`, `exportStatsCsv`, and `exportStatsHtml` derive and emit
  offline standings, player statistics, and game results.

Every importer returns a report with `errors` and `warnings`; every report retains source/extension
data that its adapter does not interpret.
