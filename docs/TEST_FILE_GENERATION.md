# Generate test and debugging files

This guide is for developers and coding agents who work on QBSheet and Fruity. It states which files
are public interchange formats, which files are application-private recovery files, and how to produce
a realistic fixture.

Follow one main rule: **generate a valid file through the code that owns the format, then make the
smallest mutation that the test needs.** A hand-written approximation tests a shape that the
applications never produce.

## Quick reference

| File | Producer | Consumer | Use in tests |
| --- | --- | --- | --- |
| `*.assignment.qbj` | Fruity | QBSheet | One unplayed game with rules, rosters, identity, and optional room procedure |
| `*.result.qbj` / `*.partial.qbj` | QBSheet core | Fruity and QBSheet | A completed or in-progress game in an official QBJ envelope |
| `*.qbj` whole tournament | Fruity and other QBJ tools | Fruity and QBSheet | Tournament import, multi-game selection, and interoperability |
| Match-only `*.qbj` | MODAQ and compatibility exporters | Fruity and QBSheet | Older workflows. The JSON holds a bare Match without `{version, objects}`. |
| `*.yft` | Fruity | Fruity | Fruity's editable tournament state: QBJ data plus `YfData` extensions |
| `*.sqbs` | Fruity or SQBS | Fruity or SQBS | Statistics interchange and roster import |
| `*.qbg` | Legacy Fruity and QBSheet tooling | QBSheet only | Import compatibility and migration tests. Never generate one for a new workflow. |
| `*.yftbak` | Fruity autosave | Fruity startup recovery | An internal recovery wrapper, not a tournament interchange file |
| `*.html` report set | Fruity | Browser | Report rendering and export tests, not an input format |

QBJ is JSON, and the extension is normally `.qbj`. Fruity also accepts `.json` in some QBJ file
pickers. The supported serialization version is `2.1.1`. The protocol media type is
`application/vnd.quizbowl.qbj+json`.

## Before you generate anything

1. Decide which real entry point the test represents: the file picker, a QBTCP response, a result
   import, a recovery startup, or a report export.
2. Start with the nearest existing fixture builder in the list below.
3. Keep the identifiers stable and meaningful. A filename is a label, and identity comes from the
   identifiers inside the document.
4. Use snake_case for standard serialized QBJ fields. Fruity's in-memory models use camelCase, and its
   save path converts them before it writes.
5. Never put a credential in a portable file. This includes a room token, a session token, a pairing
   code, an authorization header, a device identifier, a password, a secret, and the private scorer
   recovery journal.
6. Keep a generated artifact outside the repository, unless it is a deliberate reviewed fixture. Write
   it to `$(mktemp -d)`.

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

A useful game document needs more than this minimal envelope. The Tournament must lead through Phase
and Round to the Match, and every referenced object needs a matching identifier. Use the builders
instead of a recreation of that graph from memory:

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

Pass `text` directly to `openGameText`. Wrap it in a browser `File` when the file-picker boundary is
the subject of the test. [`tests/QbjFileWorkflow.test.tsx`](../tests/QbjFileWorkflow.test.tsx) shows
the second form.

### Assignment QBJ

An assignment is ordinary official QBJ that contains exactly one unplayed Match. Include all of the
following:

- One Tournament, ScoringRules, Phase, Round, and Match
- The two Registrations, the two Teams, and the available Players
- Stable Tournament, Match, Team, Player, Phase, and Round identifiers
- `Match.location`, when a room name is known
- Optional `_qbtcp` data for the round revision, the stable room identifier, the procedure, the handoff
  text, and `timed`

Do not add a zero score, `tossups_read: 0`, an empty result statistic, or fabricated question data. The
absence of scoring content separates an assignment from a game that ended nil-nil.

The production path in the Fruity interface is:

1. Create or open a tournament, then configure the teams, the scoring rules, the rooms, and the
   scheduled matches.
2. Release the round.
3. On the Rooms page, choose **Export room scoring files**.

Fruity writes one `*.assignment.qbj` per playable assignment. Use this path for an end-to-end fixture,
because it exercises the production serializer.

### Result and partial QBJ

`buildResultDocument` in [`src/qbj/QbjResult.ts`](../src/qbj/QbjResult.ts) produces both. The JSON
shape is the same. The choice between `result` and `partial` changes the descriptive filename, and it
records whether the game was complete when the code built the document.

For a partial that a real browser produced:

1. Start QBSheet with `npm start`.
2. Use **Open game file** to open an assignment.
3. Record enough scoring to represent the state under test.
4. Choose **Game → Download current QBJ**.

For result-generation code, follow the `scoreAndExport` helper in Fruity's
[`QbjAssignmentContract.test.ts`](https://github.com/gbyo/fruity/blob/master/src/__tests__/QbjAssignmentContract.test.ts).
It runs a Fruity assignment through the real QBSheet parser, scoring engine, and result builder, and
then imports the result back into Fruity.

### Whole-tournament QBJ

Use Fruity's **File → QBJ Schema → Export QBJ** for a production file. In a test, use
`tournamentDocument()` from [`tests/qbjDocuments.ts`](../tests/qbjDocuments.ts), or serialize a Fruity
`Tournament` with `toFileObject(true, true)` and the normal case-conversion step.

QBSheet shows a game picker when the document holds more than one scoreable Match. Fruity can open a
QBJ tournament, and it can import only the teams, the rosters, or the matches through its QBJ menu.

### Match-only QBJ

This compatibility shape is a bare Match object. It has `match_teams` and usually `tossups_read`, and
it has no serialization envelope:

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

Start from `modaqMatchOnly()` in QBSheet, or from `makeStandardModaqMatch()` in Fruity. QBSheet also
offers **Game → Download legacy match-only QBJ**. Do not wrap a Match-only fixture in `objects`, unless
the test changes its format on purpose.

## Fruity `.yft` files

A `.yft` file is the editable source of truth in Fruity. It uses the QBJ `2.1.1` envelope and standard
QBJ fields. Its Tournament and nested objects can also carry `YfData` for state that QBJ cannot
represent: the room configuration, the scheduled assignments, the release state, the display settings,
the seeds, and the writer version of Fruity.

Use **File → Save As** in Fruity for a realistic file. For an in-code fixture, follow
[`RoomSchedulePersistence.test.ts`](https://github.com/gbyo/fruity/blob/master/src/__tests__/RoomSchedulePersistence.test.ts):

```ts
import { makeTestTournament } from './TestFixtures';

const tournament = makeTestTournament();
tournament.appVersion = '4.0.18'; // Use the current version from Fruity's package.json.
const tournamentObject = tournament.toFileObject(false, true);
const document = { version: '2.1.1', objects: [tournamentObject] };
```

To write the document to disk, run Fruity's `camelCaseToSnakeCase(document)` first, then
`JSON.stringify(document)`. This order matches `TournamentManager.generateWholeFileObj`. Do not invent
a `YfData` field without a check of the `toFileObject` or `toYftFileObject` method on the owning model.

The redundant backup files named `Current.yft` and `YYYY-MM-DD_HHMMSS.yft` are byte-for-byte ordinary
`.yft` files. They need no unwrapping.

## SQBS files

SQBS is a positional line-oriented format. An inserted line changes the meaning of every line after
it, so generate a full file. Use Fruity's **File → SQBS → Export SQBS Files**, or
[`SqbsFileGeneration.ts`](https://github.com/gbyo/fruity/blob/master/src/renderer/DataModel/SqbsFileGeneration.ts):

```ts
import SqbsGenerator from '../renderer/DataModel/SqbsFileGeneration';
import { makeTestTournament } from './TestFixtures';

const generator = new SqbsGenerator(makeTestTournament());
generator.generateFile();
if (generator.errorMessage) throw new Error(generator.errorMessage);
const text = generator.fileOutput;
```

For a roster-import-only fixture, the smallest valid prefix is the one that
[`SqbsParsing.ts`](https://github.com/gbyo/fruity/blob/master/src/renderer/DataModel/SqbsParsing.ts)
documents:

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

The first line is the team count. Each team then has a section-size line, which equals the player count
plus one. The team name follows, and then one line per player.

## Legacy `.qbg` files

`.qbg` is a retired JSON game-package format. QBSheet still reads version 1. Neither application writes
it for a new workflow. Use it only to test migration and compatibility.

Start with `validPackage()` or `packageText()` in [`tests/packages.ts`](../tests/packages.ts). A valid
package begins with:

```json
{
  "format": "quizbowl-game",
  "version": 1,
  "tournament": { "name": "Test Tournament" },
  "round": { "number": 1, "name": "Round 1", "revision": 1 }
}
```

A complete valid fixture also needs two non-empty rosters and a structurally valid
`scorekeeperFormat`. Use the builder instead of an expansion of this abbreviated example. To test an
invalid version, a bad roster, or a malformed format, override one field on `validPackage()`.

## Fruity autosave `.yftbak`

`prod_backup.yftbak` and `dev_backup.yftbak` are internal startup-recovery files in the application
data directory of Fruity. Their wrapper is:

```json
{
  "filePath": "/previous/location/tournament.yft",
  "savedAtTime": "2026-08-09T12:34:56.000Z",
  "fileContents": { "version": "2.1.1", "objects": [] }
}
```

`fileContents` must be a `.yft` document object, not a JSON string. Use this format only for a startup
recovery test. For a removable-drive test or a network-share backup test, use an ordinary `.yft`,
because the secondary backups in Fruity have no wrapper.

## HTML reports

Fruity produces a linked set of pages: standings, individuals, games, team detail, player detail,
rounds, and the stat key. Generate them through **File → Export Stat Report**, or through the report
request path. Do not use report HTML as tournament input.

To test the exporter, assert both the page contents and the cross-page filenames, because the pages
link to one another.

## Mutation matrix for negative tests

Build the valid control first, clone it, then change only the field in the second column.

| Behaviour to test | Small mutation |
| --- | --- |
| Invalid JSON | Truncate the final `}`, or insert an unquoted key |
| Unsupported QBJ version | Set the top-level `version` to `9.9.9` |
| Missing scoring rules | Use `assignmentDocument({ scoringRules: null })` |
| Manual roster setup | Remove `Team.players`, and keep both teams and their identifiers |
| Game chooser | Use `tournamentDocument()` with several Matches |
| Played-game warning | Add `tossups_read`, points, or `match_questions` to one Match |
| Partial recovery | Build a result after a few score events, before the game completes |
| Stale assignment | Lower `_qbtcp.round_revision`, and preserve the Match identity |
| Unknown extension | Add an unrelated underscore-prefixed object. Standard QBJ still parses. |
| Legacy package failure | Override one field on `validPackage()`, for example `version: 2` |
| Fruity duplicate backup | Import the identical result twice, with an unchanged Match identifier and fingerprint |
| Fruity result conflict | Keep the Match identity, and change a score-bearing field |
| Credential leak guard | Add a sentinel token to internal state, then assert that the download omits it |
| Oversized input | Generate beyond the documented byte bound of the consumer. Do not commit the artifact. |

Do not change a filename to simulate an identity error. Both applications decide what a file is from
its contents, and the identifiers inside a document connect an assignment to its result.

## Validation commands

Run the focused contract and workflow suites after a change to a generator or a fixture:

```sh
# In qbsheet
npm test -- --run tests/QbjAssignment.test.ts tests/QbjFileWorkflow.test.tsx tests/GamePackage.test.ts
```

```sh
# In fruity
npm test -- --run \
  src/__tests__/QbjAssignmentContract.test.ts \
  src/__tests__/QbtcpRoutes.test.ts \
  src/__tests__/MatchImportService.test.ts \
  src/__tests__/RoomSchedulePersistence.test.ts
```

For cross-repository QBJ work, use Fruity's `QbjAssignmentContract.test.ts`. It exercises production
code from both repositories, and it does not compare two hand-written fixtures.

## Related specifications

- [`QBJ_ASSIGNMENT_PROFILE.md`](QBJ_ASSIGNMENT_PROFILE.md) — the required QBJ graph, graceful
  degradation, `_qbtcp`, privacy, and filenames
- [`QBG_MIGRATION.md`](QBG_MIGRATION.md) — the legacy `.qbg` migration and the field mapping
- [`QBTCP.md`](QBTCP.md) — the live protocol that transports the same QBJ assignments and results
