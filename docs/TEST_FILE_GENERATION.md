# Generating test and debugging files

This guide is for developers and coding agents working on QBSheet and Fruity. It explains which
files are public interchange formats, which are application-private recovery files, and the safest
way to produce realistic fixtures.

The main rule is: **generate a valid file through the code that owns the format, then make the
smallest mutation needed for the test.** Hand-written approximations tend to test shapes that the
applications never produce.

## Quick reference

| File | Producer | Consumer | Use in tests |
| --- | --- | --- | --- |
| `*.assignment.qbj` | Fruity | QBSheet | One unplayed game with rules, rosters, identity, and optional room procedure |
| `*.result.qbj` / `*.partial.qbj` | QBSheet core | Fruity and QBSheet | A completed or in-progress game in an official QBJ envelope |
| `*.qbj` whole tournament | Fruity and other QBJ tools | Fruity and QBSheet | Tournament import, multi-game selection, and interoperability |
| Match-only `*.qbj` | MODAQ and compatibility exporters | Fruity and QBSheet | Older workflows; JSON contains a bare Match without `{version, objects}` |
| `*.yft` | Fruity | Fruity | Fruity's editable tournament state: QBJ data plus `YfData` extensions |
| `*.sqbs` | Fruity or SQBS | Fruity or SQBS | Statistics interchange and roster import |
| `*.qbg` | Legacy Fruity/QBSheet tooling | QBSheet only | Import compatibility and migration tests; never generate for a new workflow |
| `*.yftbak` | Fruity autosave | Fruity startup recovery | Internal recovery wrapper; not a tournament interchange file |
| `*.html` report set | Fruity | Browser | Report rendering and export tests; not an input format |

QBJ is JSON, but the extension should normally be `.qbj`. Fruity also accepts `.json` in some QBJ
file pickers. The supported serialization version is `2.1.1`; the protocol media type is
`application/vnd.quizbowl.qbj+json`.

## Before generating anything

1. Decide which real entry point the test represents: file picker, QBTCP response, result import,
   recovery startup, or report export.
2. Start with the nearest existing fixture builder listed below.
3. Keep identifiers stable and meaningful. Filenames are labels; identity comes from IDs inside the
   document.
4. Use snake_case for standard serialized QBJ fields. Fruity's in-memory models use camelCase, but
   its save path converts them before writing.
5. Never put credentials in portable files. This includes room/session tokens, pairing codes,
   authorization headers, device IDs, passwords, secrets, or the private scorer recovery journal.
6. Keep generated artifacts outside the repository unless they are deliberate, reviewed fixtures.
   A convenient destination is `$(mktemp -d)`.

## QBJ files

### Official serialized QBJ

The canonical outer shape is:

```json
{
  "version": "2.1.1",
  "objects": [
    { "type": "Tournament", "id": "Tournament_test", "name": "Test Tournament" }
  ]
}
```

A useful game document needs more than this minimal envelope. In particular, the Tournament must
lead through Phase and Round to the Match, and referenced objects must have matching IDs. Use the
builders rather than recreating that graph by memory:

- [`tests/qbjDocuments.ts`](../tests/qbjDocuments.ts) builds a one-game assignment, a whole
  tournament, standard scoring rules, missing-roster variants, and a MODAQ-style bare Match.
- [`src/qbj/QbjResult.ts`](../src/qbj/QbjResult.ts) builds official result and partial documents from
  a real `GameDefinition` and derived game.
- Fruity's
  [`QbjAssignment.ts`](https://github.com/gbyo/fruity/blob/master/src/renderer/Services/QbjAssignment.ts)
  is the production assignment writer.
- Fruity's
  [`TestFixtures.ts`](https://github.com/gbyo/fruity/blob/master/src/__tests__/TestFixtures.ts)
  builds test tournaments and MODAQ-shaped results.

For a fixture-only test in QBSheet:

```ts
import { assignmentDocument, tournamentDocument } from './qbjDocuments';

const oneGame = assignmentDocument();
const noRules = assignmentDocument({ scoringRules: null });
const manyGames = tournamentDocument();

const text = JSON.stringify(oneGame, null, 2);
```

Feed `text` directly to `openGameText`, or wrap it in a browser `File` when the file-picker boundary
is what matters. [`tests/QbjFileWorkflow.test.tsx`](../tests/QbjFileWorkflow.test.tsx) demonstrates
the latter.

### Assignment QBJ

An assignment is ordinary official QBJ containing exactly one unplayed Match. It should include:

- one Tournament, ScoringRules, Phase, Round, and Match;
- the two Registrations, Teams, and available Players;
- stable Tournament, Match, Team, Player, Phase, and Round IDs;
- `Match.location` when a room name is known;
- optional `_qbtcp` data for round revision, stable room ID, procedure, handoff text, and `timed`.

Do **not** add zero scores, `tossups_read: 0`, empty result statistics, or fabricated question data.
The absence of scoring content is what distinguishes an assignment from a played nil-nil game.

The production UI path in Fruity is:

1. Create or open a tournament and configure teams, scoring rules, rooms, and scheduled matches.
2. Release the round.
3. On the Rooms page, choose **Export room scoring files**.

Fruity writes one `*.assignment.qbj` per playable assignment. This is the best source for an
end-to-end fixture because it exercises the production serializer.

### Result and partial QBJ

`buildResultDocument` in [`src/qbj/QbjResult.ts`](../src/qbj/QbjResult.ts) produces both. The JSON
shape is the same; `result` versus `partial` changes the descriptive filename and whether the game
was complete when the document was built.

For a real browser-produced partial:

1. Start QBSheet with `npm start`.
2. Use **Open game file** to open an assignment.
3. Record enough scoring to represent the state under test.
4. Choose **Game → Download current QBJ**.

For result-generation code, follow the `scoreAndExport` helper in Fruity's
[`QbjAssignmentContract.test.ts`](https://github.com/gbyo/fruity/blob/master/src/__tests__/QbjAssignmentContract.test.ts).
It runs a Fruity assignment through QBSheet's real parser, scoring engine, and result builder, then
imports the result back into Fruity.

### Whole-tournament QBJ

Use Fruity's **File → QBJ Schema → Export QBJ** for a production file. In tests, use
`tournamentDocument()` from [`tests/qbjDocuments.ts`](../tests/qbjDocuments.ts) or serialize a
Fruity `Tournament` with `toFileObject(true, true)` and the normal case-conversion step.

QBSheet should show a game picker when more than one scoreable Match is present. Fruity can open a
QBJ tournament or import only teams, rosters, or matches through its QBJ menu.

### Match-only QBJ

This compatibility shape is a bare Match object. It has `match_teams` and usually `tossups_read`,
but no serialization envelope:

```json
{
  "_round": 4,
  "tossups_read": 20,
  "match_teams": [
    { "team": { "name": "Alpha" }, "points": 300 },
    { "team": { "name": "Beta" }, "points": 200 }
  ]
}
```

Use `modaqMatchOnly()` in QBSheet or `makeStandardModaqMatch()` in Fruity as the starting point.
QBSheet also exposes **Game → Download legacy match-only QBJ**. Do not wrap a Match-only fixture in
`objects` unless the test is intentionally changing its format.

## Fruity `.yft` files

A `.yft` is Fruity's editable source of truth. It uses the QBJ `2.1.1` envelope and standard QBJ
fields, but its Tournament and nested objects may carry `YfData` for state QBJ cannot represent:
room configuration, scheduled assignments, release state, display settings, seeds, and Fruity's
writer version.

Prefer **File → Save As** in Fruity for a realistic file. For an in-code fixture, follow
[`RoomSchedulePersistence.test.ts`](https://github.com/gbyo/fruity/blob/master/src/__tests__/RoomSchedulePersistence.test.ts):

```ts
import { makeTestTournament } from './TestFixtures';

const tournament = makeTestTournament();
tournament.appVersion = '4.0.18'; // Use the current version from Fruity's package.json.
const tournamentObject = tournament.toFileObject(false, true);
const document = { version: '2.1.1', objects: [tournamentObject] };
```

When writing the document to disk, run Fruity's `camelCaseToSnakeCase(document)` first and then
`JSON.stringify(document)`, matching `TournamentManager.generateWholeFileObj`. Do not invent
`YfData` fields without checking the owning model's `toFileObject`/`toYftFileObject` method.

Redundant backup files named `Current.yft` or `YYYY-MM-DD_HHMMSS.yft` are byte-for-byte ordinary
`.yft` files. They need no unwrapping.

## SQBS files

SQBS is a positional, line-oriented format, so manually inserting a line can change the meaning of
everything after it. Generate full files with Fruity's **File → SQBS → Export SQBS Files** or with
[`SqbsFileGeneration.ts`](https://github.com/gbyo/fruity/blob/master/src/renderer/DataModel/SqbsFileGeneration.ts):

```ts
import SqbsGenerator from '../renderer/DataModel/SqbsFileGeneration';
import { makeTestTournament } from './TestFixtures';

const generator = new SqbsGenerator(makeTestTournament());
generator.generateFile();
if (generator.errorMessage) throw new Error(generator.errorMessage);
const text = generator.fileOutput;
```

For roster-import-only fixtures, the smallest valid prefix is documented by
[`SqbsParsing.ts`](https://github.com/gbyo/fruity/blob/master/src/renderer/DataModel/SqbsParsing.ts):

```text
2
3
Alpha A
Alice (12)
Arun (11)
3
Beta A
Bea
Ben
```

The first line is the team count. Each team then has a section-size line equal to player count plus
one, followed by the team name and one line per player.

## Legacy `.qbg` files

`.qbg` is a retired JSON game-package format. QBSheet still reads version 1, but neither app should
write it for a new workflow. Use it only to test migration and compatibility.

Start with `validPackage()` or `packageText()` in [`tests/packages.ts`](../tests/packages.ts). A
valid package begins with:

```json
{
  "format": "quizbowl-game",
  "version": 1,
  "tournament": { "name": "Test Tournament" },
  "round": { "number": 1, "name": "Round 1", "revision": 1 }
}
```

The complete valid fixture also needs two non-empty rosters and a structurally valid
`scorekeeperFormat`; use the builder instead of expanding this abbreviated example. Test invalid
versions, bad rosters, or malformed formats by overriding one field on `validPackage()`.

## Fruity autosave `.yftbak`

`prod_backup.yftbak` and `dev_backup.yftbak` are internal startup-recovery files in Fruity's app
data directory. Their wrapper is:

```json
{
  "filePath": "/previous/location/tournament.yft",
  "savedAtTime": "2026-08-09T12:34:56.000Z",
  "fileContents": { "version": "2.1.1", "objects": [] }
}
```

`fileContents` must be a `.yft` document object, not a JSON string. Use this format only for startup
recovery tests. For removable-drive or network-share backup tests, use an ordinary `.yft`, because
Fruity's secondary backups intentionally have no wrapper.

## HTML reports

Fruity produces a linked set of standings, individuals, games, team-detail, player-detail, rounds,
and stat-key pages. Generate them through **File → Export Stat Report** or the report request path;
do not use report HTML as tournament input. When testing the exporter, assert both page contents and
cross-page filenames because the pages link to one another.

## Mutation matrix for negative tests

Build the valid control first, clone it, and change only the field in the second column.

| Behavior to test | Small mutation |
| --- | --- |
| Invalid JSON | Truncate the final `}` or insert an unquoted key |
| Unsupported QBJ version | Set top-level `version` to `9.9.9` |
| Missing scoring rules | Use `assignmentDocument({ scoringRules: null })` |
| Manual roster setup | Remove `Team.players`, keeping both teams and their IDs |
| Game chooser | Use `tournamentDocument()` with multiple Matches |
| Played-game warning | Add `tossups_read`, points, or `match_questions` to one Match |
| Partial recovery | Build a result after a few score events, before game completion |
| Stale assignment | Lower `_qbtcp.round_revision` while preserving Match identity |
| Unknown extension | Add an unrelated underscore-prefixed object; standard QBJ should still parse |
| Legacy package failure | Override one field on `validPackage()`, such as `version: 2` |
| Fruity duplicate backup | Import the identical result twice with unchanged Match ID/fingerprint |
| Fruity result conflict | Keep Match identity but change a score-bearing field |
| Credential leak guard | Add a sentinel token to internal state and assert it is absent from the download |
| Oversized input | Generate beyond the consumer's documented byte bound; do not commit the artifact |

Avoid changing the filename to simulate identity errors. Both applications decide what a file is
from its contents, and IDs—not names—connect an assignment to its result.

## Validation commands

Run the focused contract and workflow suites after changing a generator or fixture:

```sh
# In qbsheet
npm test -- --run tests/QbjAssignment.test.ts tests/QbjFileWorkflow.test.tsx tests/GamePackage.test.ts

# In fruity
npm test -- --run \
  src/__tests__/QbjAssignmentContract.test.ts \
  src/__tests__/QbtcpRoutes.test.ts \
  src/__tests__/MatchImportService.test.ts \
  src/__tests__/RoomSchedulePersistence.test.ts
```

For cross-repository QBJ work, Fruity's `QbjAssignmentContract.test.ts` is the strongest single
check: it exercises production code from both repositories rather than comparing two hand-written
fixtures.

## Related specifications

- [`QBJ_ASSIGNMENT_PROFILE.md`](QBJ_ASSIGNMENT_PROFILE.md) — required QBJ graph, graceful
  degradation, `_qbtcp`, privacy, and filenames
- [`QBG_MIGRATION.md`](QBG_MIGRATION.md) — legacy `.qbg` migration and field mapping
- [`QBTCP.md`](QBTCP.md) — the live protocol that transports the same QBJ assignments and results
