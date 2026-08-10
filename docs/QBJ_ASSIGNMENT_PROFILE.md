# QBJ Assignment Profile

This document is a profile of QBJ. It does not define a new file format. Every document that it
describes is ordinary QBJ, and any QBJ-aware tool can read it.

The document states which parts of QBJ QBSheet uses, what QBSheet does when an optional part is
absent, and the one extension that QBSheet adds for information that QBJ cannot represent.

QBSheet defines no `.qbs` format, and it will not define one.

This document uses the key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY in their ordinary
specification sense.

## The shape of a document

QBSheet writes every new file in the official QBJ serialization envelope. QBSheet also prefers to
receive an assignment in that envelope.

```json
{
  "version": "2.1.1",
  "objects": [ ... ]
}
```

This profile supports QBJ serialization version `2.1.1`. QBSheet writes this version. QBSheet refuses
an unrecognised version with a plain message, and it does not guess at the differences.

The media type for these documents is:

    application/vnd.quizbowl.qbj+json

The file extension is `.qbj` for every public file. It is not `.qbg`, and it is not `.qbs`.

## The three inputs that QBSheet accepts

| Input | Status | Notes |
| --- | --- | --- |
| **A.** Official serialized QBJ (`{version, objects}`) | Preferred | One-game assignments and whole tournaments |
| **B.** Match-only QBJ (a bare `Match` object) | Supported for compatibility | The form that MODAQ and legacy workflows produce and consume |
| **C.** Legacy `.qbg` game package | Import only, deprecated | See [`QBG_MIGRATION.md`](QBG_MIGRATION.md) |

QBSheet reads B and C. It prefers neither, and it writes neither as its default output.

All three inputs converge on one normalization pipeline:

```
     official serialized QBJ ─┐
                              ├─ parse → validate → GameDefinition → scorer
          Match-only QBJ ─────┤
                              │
             legacy .qbg ─────┘   (via a compatibility converter, same validation)
```

`GameDefinition` is internal. It replaces the role of `IGamePackage` as a public specification, and it
takes on none of that role. QBSheet does not write `GameDefinition` to disk and does not send it over
the network, and it carries no public version contract.

`GameDefinition` gives the scorer one thing to build against, so that a file assignment and a QBTCP
assignment cannot drift apart. QBTCP delivers document form A over HTTP, and that document goes
through this same parser.

## A one-game assignment

A QBJ assignment is a normal QBJ serialization that contains one unplayed scheduled `Match`. It is not
a distinct format, and it needs no distinct parser.

For a single game, include only what that game needs:

- Exactly one `Tournament`, which the serialization format requires
- `ScoringRules`
- The `Registration`, `Team`, and `Player` objects for the two teams that play
- The relevant `Phase`
- The relevant `Round`
- Exactly one `Match`
- The packet identity, when it is known

A producer MUST NOT include any of these:

- Standings and rankings
- The games of other rooms
- Future pairings or unreleased pairings
- Tournament-control credentials, pairing codes, room tokens, or session tokens
- Device identifiers or server URLs
- Browser recovery state

A room needs the game in front of it. Each item on the second list falls into one of three
categories. It is information that the end of the round will make wrong, it is information that the
room has no reason to hold, or it is a capability that must never travel in a file.

### Represent an unplayed match as unplayed

A scheduled match that nobody has played uses the standard QBJ semantics for an unplayed game.

A producer MUST NOT write zero scores, empty `match_teams` totals, or a `tossups_read` of `0` to make
an assignment resemble a result. An importer separates an assignment from a result by the absence of
scoring content, and a fabricated zero removes that signal.

### Identity comes from QBJ, not from an extension

| Identity | Carried as |
| --- | --- |
| Tournament | `Tournament.id` |
| Scheduled match | `Match.id` |
| Team | `Team.id`, and its `Registration` |
| Player | `Player.id` |
| Phase | `Phase.id` |
| Round | `Round.id` and `Round.name` |
| Room | `Match.location` |

These fields are the identities. The `_qbtcp` extension MUST NOT restate any of them. It carries no
`scheduled_match_id`, no `tournament_id`, no team name, and no room display name where
`Match.location` already carries one.

A duplicated identity creates two fields that can disagree. A generic consumer ignores the extension
and reads the standard field, so the two copies do not stay in step.

A filename is never an identity. See "Filenames".

## The `_qbtcp` extension

The extension is a small optional block that a consumer can ignore. It holds no secret. It carries
only the operational information that standard QBJ cannot express, and it attaches to the `Match`.

```json
{
  "type": "Match",
  "id": "sm-4471",
  "location": "Room 204",
  "_qbtcp": {
    "version": 1,
    "round_revision": 3,
    "room_id": "room-204",
    "procedure": { "...": "halves, clock, timeout policy" },
    "handoff_instruction": "Upload to the Round 4 folder in the shared drive.",
    "scorekeeper": { "timed": true }
  }
}
```

Every field is optional except `version`. A consumer that does not recognise `_qbtcp` reads the match
as it would read a match without the block.

### Why each field is outside QBJ

| Field | Reason |
| --- | --- |
| `round_revision` | QBJ has no concept of a redrawn pairing. Without this field, a result scored against a superseded bracket looks the same as a current one. |
| `room_id` | `Match.location` is a display string. A stable room identifier survives a rename from "Room 204" to "Library". Include it only when it differs in kind from `location`. |
| `procedure` | Halves, the clock, and the timeout policy are tournament operations. QBJ models scoring, not the way a room runs a game. |
| `handoff_instruction` | Free text that tells the room what to do with the finished file. The application does not interpret it. |
| `scorekeeper.timed` | See below. |

### `scorekeeper.timed`

`IQbjScoringRules` has no field for a timed round. In the reference implementation the flag lives
outside QBJ, in a file-format extension at `IYftFileScoringRules.YfData.timed`.

The gap has a practical effect. A timed round ends when the moderator calls time, and it does not end
after a fixed tossup count. A scorer with the wrong assumption either cuts a game short or runs past
the end of it.

`timed` therefore travels in this extension, and it is the only scoring semantic that `_qbtcp`
permits. A producer MUST express anything that QBJ can express in `ScoringRules`. Add another scoring
value to this extension only with an entry in the table above and a reason of the same kind.

### Extension placement

The extension attaches to the `Match`, because the assignment metadata describes this game. Attachment
to `Tournament` would imply that the block describes the whole event, which `round_revision` and
`room_id` do not.

Two compatibility facts apply to the reference parser:

1. **Unknown keys survive it.** Fruity's `snakeCaseToCamelCase` converts only an explicit table of
   known QBJ key names, and it deletes the snake-case originals. It leaves a key that it does not
   recognise untouched, so `_qbtcp` arrives intact.

2. **That conversion recurses into every nested object,** which includes the inside of `_qbtcp`. The
   parser silently rewrites any key inside the extension whose name collides with that table, and it
   deletes the original.

Therefore a key inside `_qbtcp` MUST NOT collide with a QBJ snake-case key name. The current fields
are safe, because the conversion table holds none of `round_revision`, `room_id`, `procedure`,
`handoff_instruction`, or `timed`. Check any later field against that table. This constraint comes
from a deployed parser rather than from a preference.

The QBJ schema defines no formal extension mechanism, so an underscore-prefixed key is the convention
in use. `_qbsheet_source` and YellowFruit's `YfData` follow the same convention. A producer never
overloads a standard field to carry non-standard meaning.

## Whole-tournament input

QBSheet accepts a QBJ document for a whole tournament, so that it serves as a generic scoresheet
rather than the client of one product.

- **Exactly one scoreable match:** QBSheet opens it directly, with no prompt.
- **More than one:** QBSheet shows a game picker, grouped by round.

```
Choose a game

Round 4

  Room 101    Ninety Six vs Clinton
  Room 102    Emerald vs Greenwood
```

The picker is a dense flat list, and it matches the existing non-scorer shell.

Selection rules:

- QBSheet prefers unplayed scheduled matches, and lists them first.
- QBSheet distinguishes a match that already carries score data from a match that is clearly
  unplayed. QBSheet never opens a match that carries score data without an explicit instruction,
  because that action can overwrite a completed result that another person entered.
- QBSheet MAY offer a partially scored match as a resume source or a recovery source. It offers one
  only when it can reconstruct the match faithfully from standard QBJ. Otherwise it reports the limit
  instead of a partial restore.

The normal Fruity workflow still exports one assignment file per game. Whole-tournament support serves
interoperability. It is not a recommendation to give every room the entire schedule.

## Graceful degradation

Generic QBJ will lack things that Fruity always provides. Each gap has a defined behaviour, and none
of the behaviours is a guess.

| Missing | Behaviour |
| --- | --- |
| **Scoring rules**, absent or insufficient | Stop, and state *"This QBJ does not specify enough scoring information."* Let the scorekeeper choose or configure a format. Never assume NAQT, ACF, or any other named rule set. |
| **Rosters**, with teams present and players absent | Allow manual player entry. Scoring proceeds normally. |
| **Procedure** | Scoring works. QBSheet states that the document included no tournament procedure, and that it will not enforce a procedural rule that it does not know. It does not model substitution, timeout, or clock policy. |
| **Room** | Scoring works. QBSheet displays no room. |
| **Round** | Scoring works. QBSheet displays a neutral fallback label. |
| **`timed`** | QBSheet assumes neither value. When the distinction affects scoring for the chosen format, QBSheet asks. |

The rule behind the table is that QBSheet asks instead of guesses. A repaired ambiguity that QBSheet
does not report produces a mis-scored game that nobody knows to examine.

### Never branch on the name of a rule set

Scoring behaviour derives from the structural `ScoringRules` fields: `answer_types`, `awards_bonus`,
`maximum_players_per_team`, `regulation_tossup_count`, `maximum_regulation_tossup_count`,
`minimum_overtime_question_count`, `overtime_includes_bonuses`, `maximum_bonus_score`,
`bonus_divisor`, `minimum_parts_per_bonus`, `maximum_parts_per_bonus`, `points_per_bonus_part`,
`bonuses_bounce_back`, the lightning fields, and `total_divisor`.

`ScoringRules.name` is a label. No code path branches on `"NAQT"`, on `"ACF"`, or on any other
string in that field.

## Validation of untrusted input

Every imported document is untrusted. This includes a document that arrived over an authenticated
QBTCP connection. QBSheet enforces all of the following:

- A file-size bound before the parse
- JSON shape checks on every object that it reads
- Finite numbers only, with no `NaN` and no `Infinity`
- Format values that are positive and in range
- Team names and player names that are not blank
- No duplicate player identity within one team
- Lineups that are subsets of their roster, without a repeat, and within the active limit of the format
- Safe identifier strings
- Rejection of prototype-pollution shapes, which are `__proto__`, `constructor`, and `prototype` as keys
- A supported-version check, with a plain unsupported-version message rather than a guess

## Output: what QBSheet writes

QBSheet writes `.qbj`. It does not write `.qbg`.

The default portable download is an official serialized QBJ document, `{version, objects}`. QBSheet no
longer presents a bare `Match` object as the canonical QBJ file.

A secondary export remains available for ecosystem compatibility. It sits under a **More…** menu, and
it is not visually dominant:

    More…
      Download legacy match-only QBJ

### A result is the assignment, filled in

When QBSheet starts from an official QBJ assignment, the completed result preserves the identity of
that document:

- The same `Tournament.id`, `Phase.id`, `Round.id`, and `Match.id`
- The same team identifiers and the same player identifiers
- The same scoring rules

QBSheet then fills the `Match` with what happened: `tossups_read`, `overtime_tossups_read`, team and
player performance, points and bonus points, lineups, `match_questions`, notes, the moderator and
scorekeeper where known, `location`, packet information, and protests or corrections in the standard
QBJ representation where one exists.

Because the result preserves the identity, reconciliation on the tournament-control side is
deterministic. It is a lookup rather than a match against a filename.

For a Match-only import with no `Tournament` wrapper, the export creates the minimum valid serialized
document, and it preserves whatever identities were available.

## Partial download

During an active game, **Game → More… → Download current QBJ** writes a portable partial:

    R04_Room-204_Ninety-Six_vs_Greenwood.partial.qbj

It contains as much standard QBJ state as QBSheet can represent faithfully: the current team and
player statistics, the lineups, `match_questions`, the notes, `location`, and the stable identities.
QBSheet can reopen one and reconstruct the game to the extent that standard QBJ supports.

A portable partial is not the recovery mechanism of QBSheet. Do not describe it as one.

| | Portable partial QBJ | Local browser recovery |
| --- | --- | --- |
| Lives in | A file that the scorekeeper holds | IndexedDB and the `localStorage` journal |
| Contains | Standard QBJ statistical state | The full `ScoreEvent` history and the frozen setup |
| Restores | The game as QBJ can describe it | The game exactly as it was |
| Undo and redo history | No | Yes |
| Exact clock internals | No | Yes |
| Connection state and outbox | No | Yes |
| Leaves the device | Yes | Never |

The local `ScoreEvents` remain the authoritative exact-recovery mechanism. A portable partial serves a
device that is no longer available, and it does not replace the journal.

## Privacy boundary

One sanitization boundary applies to everything that leaves the device: a download, a QBTCP progress
snapshot, and a QBTCP result.

Portable QBJ MUST NEVER contain any of the following:

room tokens · session tokens · pairing codes · `Authorization` header data · device identifiers ·
browser identifiers · server URLs · credentials or secrets of any kind · the private recovery journal ·
private `ScoreEvents` that an implementation included for convenience

QBSheet continues to strip the legacy key `_yf_scorekeeper_recovery` from a portable download.

### Source metadata

| Key | Status |
| --- | --- |
| `_qbtcp` | Written. The documented home for new operational metadata. |
| `_qbsheet_source` | Read for compatibility. No longer written as the preferred form. |
| `_scoresheet_source` | Read for compatibility with files that predate QBSheet. Never written. |

## Result identity and deduplication

The same result can arrive twice. It can arrive automatically over QBTCP, and then again as a QBJ file
that the scorekeeper downloaded and uploaded. Two arrivals must not create two matches.

Matching order:

1. `Tournament.id` and `Match.id`. This is the strongest identity, and it is the reason that an
   assignment preserves its identifiers.
2. The portable statistical result fingerprint, when the identifiers do not match.

A consumer computes the fingerprint over the statistical content only. It ignores all of the
following:

- `_qbtcp` transport metadata and source metadata
- The legacy source extensions `_qbsheet_source` and `_scoresheet_source`
- Private recovery data
- The ordering of object keys

One game scored once therefore produces one fingerprint, whatever route the document took.

| Situation | Behaviour |
| --- | --- |
| The automatic copy and the manual copy agree | Report *"Backup copy matches existing result."* Record no duplicate. |
| The same `Match.id`, with different statistics | Raise an explicit conflict for human review. Never overwrite it silently. |
| The result carries an older `round_revision` | Flag the result as stale or superseded. Do not accept it as current. |

## Filenames

Every new public file uses `.qbj`, with a descriptive suffix:

| Purpose | Example |
| --- | --- |
| Assignment | `R04_Room-204_Ninety-Six_vs_Greenwood.assignment.qbj` |
| Completed result | `R04_Room-204_Ninety-Six_vs_Greenwood.result.qbj` |
| Mid-game backup | `R04_Room-204_Ninety-Six_vs_Greenwood.partial.qbj` |

The suffix is guidance for a person. No implementation treats a filename as authoritative identity,
and none decides how to parse a document from its name. A room can rename any of these files at any
time.

## See also

- [`QBTCP.md`](QBTCP.md) — the live protocol, and the delivery of an assignment over HTTP
- [`QBG_MIGRATION.md`](QBG_MIGRATION.md) — the retirement of the legacy `.qbg` package
