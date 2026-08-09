# QBJ Assignment Profile

**This is a profile of QBJ, not a new file format.** Every document described here is ordinary QBJ
that any QBJ-aware tool can read. This document says which parts of QBJ QBSheet uses, what it does
when optional parts are missing, and the one small extension it adds for information QBJ cannot
represent.

There is no `.qbs` format. There will not be one.

## The shape of a document

All new files QBSheet writes, and all assignments it prefers to receive, use the official QBJ
serialization envelope:

```json
{
  "version": "2.1.1",
  "objects": [ ... ]
}
```

`2.1.1` is the QBJ serialization version currently supported by the reference tournament-control
implementation (`validQbjVersions` in Fruity's `QbjUtils.ts`). QBSheet writes this version and
refuses an unrecognized one with a plain message rather than guessing at the differences.

The MIME type for these documents is:

    application/vnd.quizbowl.qbj+json

The file extension is `.qbj` for every public file. Not `.qbg`, not `.qbs`.

## The three inputs QBSheet accepts

| Input | Status | Notes |
| --- | --- | --- |
| **A.** Official serialized QBJ (`{version, objects}`) | Preferred | Both one-game assignments and whole tournaments |
| **B.** Match-only QBJ (a bare `Match` object) | Supported for compatibility | The de-facto form produced and consumed by MODAQ and by legacy workflows |
| **C.** Legacy `.qbg` game package | Import only, deprecated | See [`QBG_MIGRATION.md`](QBG_MIGRATION.md) |

B and C are read. Neither is preferred, and neither is written as the default output.

All three converge on **one** normalization pipeline:

```
     official serialized QBJ ─┐
                              ├─ parse → validate → GameDefinition → scorer
          Match-only QBJ ─────┤
                              │
             legacy .qbg ─────┘   (via a compatibility converter, same validation)
```

`GameDefinition` is **internal**. It replaces `IGamePackage`'s role as a public specification and
takes on none of it: it is not written to disk, not sent over the network, and not versioned as a
public contract. Its only job is to be the single thing the scorer is built against, so that a file
assignment and a QBTCP assignment cannot drift apart. QBTCP delivers document form A over HTTP and
it goes through this same parser — that is the point.

## A one-game assignment

A QBJ assignment is a normal QBJ serialization containing **one unplayed scheduled Match**. It is
not a distinct format and needs no distinct parser.

For a single game, include only what that game needs:

- exactly one `Tournament` (required by the serialization format)
- `ScoringRules`
- the `Registration` / `Team` / `Player` objects for the two teams playing
- the relevant `Phase`
- the relevant `Round`
- exactly one `Match`
- packet identity, if known

Deliberately **excluded**, and a producer MUST NOT include them:

- standings and rankings
- other rooms' games
- future or unreleased pairings
- tournament-control credentials, pairing codes, room or session tokens
- device identifiers, server URLs
- browser recovery state

A room needs the game in front of it. Everything else on that list is either information that will
be wrong by the end of the round, information the room has no business holding, or a capability
that should never travel in a file.

### Unplayed means unplayed

A scheduled-but-unplayed `Match` uses standard QBJ semantics for an unplayed game. A producer MUST
NOT fabricate zero scores, empty `match_teams` totals, or a `tossups_read` of 0 in order to make an
assignment look like a result. An importer distinguishes an assignment from a result by the absence
of scoring content, not by a flag, and inventing zeroes destroys exactly that signal.

### Identity comes from QBJ, not from an extension

| Identity | Carried as |
| --- | --- |
| Tournament | `Tournament.id` |
| Scheduled match | `Match.id` |
| Team | `Team.id` (and its `Registration`) |
| Player | `Player.id` |
| Phase | `Phase.id` |
| Round | `Round.id` / `Round.name` |
| Room | `Match.location` |

These are the identities. The `_qbtcp` extension MUST NOT restate any of them — no
`scheduled_match_id`, no `tournament_id`, no team names, no room display name where
`Match.location` already carries it. Duplicating an identity creates two places for it to disagree,
and the extension is the one a generic consumer will ignore.

Filenames are never identity. See "Filenames".

## The `_qbtcp` extension

A small, optional, ignorable, non-secret block carrying **only** operational information that
standard QBJ cannot express. It attaches to the `Match`.

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

Every field is optional except `version`. A consumer that has never heard of `_qbtcp` reads the
match exactly as it would have anyway.

### Why each field is here and not in QBJ

| Field | Why QBJ cannot carry it |
| --- | --- |
| `round_revision` | QBJ has no concept of a pairing being redrawn. Without this, a result scored against a superseded bracket is indistinguishable from a current one. |
| `room_id` | `Match.location` is a display string. A stable room id survives renaming "Room 204" to "Library". Included only when it differs in kind from `location`. |
| `procedure` | Halves, clock, and timeout policy are tournament operations, not scoring rules. QBJ models scoring, not how a room runs a game. |
| `handoff_instruction` | Free text telling the room what to do with the finished file. Deliberately opaque to the application. |
| `scorekeeper.timed` | See below. |

### `scorekeeper.timed`, and why it is the only scoring field permitted here

`IQbjScoringRules` has no field for whether a round is timed. In the reference implementation the
flag lives outside QBJ entirely, in a file-format extension (`IYftFileScoringRules.YfData.timed`).
It is a genuine gap: a timed round ends when the moderator calls time, not after a fixed tossup
count, and a scorer that guesses wrong either cuts a game short or runs past the end of it.

So `timed` travels here, and it is the **only** scoring semantic permitted in `_qbtcp`. Anything
QBJ can express MUST be expressed in `ScoringRules`. If a future need arises for another such
value, it goes in this table with the same justification or it does not go in at all.

When `timed` is absent, QBSheet does not assume either way — see "Graceful degradation".

### Extension placement, and a real compatibility constraint

The extension attaches to the `Match` because the assignment metadata is about this game. Attaching
it to `Tournament` would imply it describes the whole event, which `round_revision` and `room_id`
plainly do not.

Two things were verified before settling on this:

1. **Unknown keys survive the reference parser.** Fruity's `snakeCaseToCamelCase` converts only an
   explicit table of known QBJ key names and deletes the snake-case originals. A key it has never
   heard of is left untouched, so `_qbtcp` arrives intact.

2. **But that conversion recurses into every nested object.** `snakeCaseToCamelCase` walks all
   nested objects, including inside `_qbtcp`. Any key *inside* the extension whose name collides
   with that table would be silently rewritten to camelCase and the original deleted.

   Therefore: **keys inside `_qbtcp` MUST NOT collide with QBJ's snake_case key names.** The current
   fields are safe (`round_revision`, `room_id`, `procedure`, `handoff_instruction`, `timed` are
   none of them in the conversion table). Any field added later must be checked against it. This is
   a documented compatibility compromise with a deployed parser, not a design preference.

The QBJ schema does not define a formal extension mechanism, so an underscore-prefixed key is the
convention in use — the same convention as the existing `_qbsheet_source` and YellowFruit's
`YfData`. Standard fields are never overloaded to smuggle non-standard meaning.

## Whole-tournament input

QBSheet accepts a whole-tournament QBJ, so that it is a useful generic scoresheet rather than a
client of one product.

- **Exactly one scoreable match** → open it directly, no prompt.
- **More than one** → show a restrained game picker, grouped by round:

```
Choose a game

Round 4

  Room 101    Ninety Six vs Clinton
  Room 102    Emerald vs Greenwood
```

Dense, flat, and consistent with the existing non-scorer shell. It is a list, not a gallery.

Selection rules:

- Unplayed scheduled matches are preferred and listed first.
- A match that already carries score data is visually distinguished from a clearly unplayed one and
  is never opened silently. Overwriting somebody's completed result because it was in the same file
  is not an acceptable failure mode.
- A **partially** scored match MAY be offered as a resume/recovery source, but only when QBSheet can
  faithfully reconstruct it from standard QBJ. When it cannot, it says so instead of half-restoring.

Fruity's normal workflow still exports **one assignment file per game**. Whole-tournament support is
for interoperability, not a recommendation to hand every room the entire schedule.

## Graceful degradation

Generic QBJ will be missing things Fruity always provides. Each gap has a defined behavior, and
none of them is a guess.

| Missing | Behavior |
| --- | --- |
| **Scoring rules** (absent or insufficient) | Stop and say *"This QBJ does not specify enough scoring information."* Let the scorekeeper choose or configure a format. **Never** assume NAQT, ACF, or any other named rule set. |
| **Rosters** (teams present, players absent) | Allow manual player entry; scoring proceeds normally. |
| **Procedure** | Scoring works. QBSheet states that tournament procedure was not included and that it will not enforce procedural rules it does not know. It does not pretend to know substitution, timeout, or clock policy. |
| **Room** | Scoring works; no room is displayed. |
| **Round** | Scoring works; a neutral fallback label is displayed. |
| **`timed`** | Not assumed in either direction. If the distinction affects scoring for the chosen format, QBSheet asks. |

The rule behind the table: **QBSheet asks rather than guesses.** A silently repaired ambiguity is a
mis-scored game that nobody knows to look for.

### Never branch on a rule-set name

Scoring behavior derives from structural `ScoringRules` fields — `answer_types`, `awards_bonus`,
`maximum_players_per_team`, `regulation_tossup_count`, `maximum_regulation_tossup_count`,
`minimum_overtime_question_count`, `overtime_includes_bonuses`, `maximum_bonus_score`,
`bonus_divisor`, `minimum_parts_per_bonus`, `maximum_parts_per_bonus`, `points_per_bonus_part`,
`bonuses_bounce_back`, the lightning fields, and `total_divisor`.

`ScoringRules.name` is a label. No code path may branch on `"NAQT"`, `"ACF"`, or any other string in
it.

## Validation of untrusted input

Every imported document is untrusted, including one that arrived over an authenticated QBTCP
connection. QBSheet enforces:

- a file-size bound before parsing
- JSON shape checks on every object it reads
- finite numbers only — no `NaN`, no `Infinity`
- positive, in-range format values
- non-blank team and player names
- no duplicate player identity within a team
- lineups that are subsets of their roster, without repeats, within the format's active limit
- safe id strings
- rejection of prototype-pollution shapes (`__proto__`, `constructor`, `prototype` as keys)
- a supported-version check, with a plain unsupported-version message rather than a guess

## Output: what QBSheet writes

**QBSheet writes `.qbj`. It does not write `.qbg`.**

The default portable download is an official serialized QBJ document (`{version, objects}`). A bare
`Match` object is no longer presented as the canonical QBJ file.

For ecosystem compatibility a secondary export remains available, placed under a **More…** menu and
deliberately not visually dominant:

    More…
      Download legacy match-only QBJ

### A result is the assignment, filled in

When QBSheet starts from an official QBJ assignment, the completed result preserves the same
document identity:

- same `Tournament.id`, `Phase.id`, `Round.id`, `Match.id`
- same team ids, same player ids
- same scoring rules

and then fills the `Match` with what actually happened: `tossups_read`, `overtime_tossups_read`,
team and player performance, points and bonus points, lineups, `match_questions`, notes,
moderator/scorekeeper where known, `location`, packet information, and protests or corrections in
standard QBJ representation where one exists.

The result is not a newly-minted match that happens to resemble the assignment. Because identity is
preserved, reconciliation on the tournament-control side is deterministic — a lookup, not a fuzzy
filename match.

For a Match-only import with no `Tournament` wrapper, export creates the minimum valid serialized
document and preserves whatever identities were available.

## Partial download, and how it differs from real recovery

During an active game, **Game → More… → Download current QBJ** writes a portable partial:

    R04_Room-204_Ninety-Six_vs_Greenwood.partial.qbj

It contains as much standard QBJ state as can be faithfully represented: current team and player
statistics, lineups, `match_questions`, notes, `location`, and stable identities. QBSheet can reopen
one and reconstruct the game to the extent standard QBJ supports.

**This is not QBSheet's recovery mechanism, and it must not be described as one.**

| | Portable partial QBJ | Local browser recovery |
| --- | --- | --- |
| Lives in | A file the scorekeeper holds | IndexedDB + `localStorage` journal |
| Contains | Standard QBJ statistical state | Full `ScoreEvent` history and frozen setup |
| Restores | The game as QBJ can describe it | The game exactly as it was |
| Undo/redo history | No | Yes |
| Exact clock internals | No | Yes |
| Connection state, outbox | No | Yes |
| Leaves the device | Yes | Never |

Local `ScoreEvents` remain the authoritative exact-recovery mechanism. A portable QBJ is a lifeboat
for a dead Chromebook, not a substitute for the journal.

## Privacy boundary

A single sanitization boundary applies to **everything** that leaves the device — download, QBTCP
progress, QBTCP result. Portable QBJ MUST NEVER contain:

room tokens · session tokens · pairing codes · `Authorization` header data · device ids · browser
identifiers · server URLs · credentials or secrets of any kind · the private recovery journal ·
private `ScoreEvents` included for implementation convenience

The existing legacy key `_yf_scorekeeper_recovery` continues to be **stripped** from portable
downloads.

### Source metadata

| Key | Status |
| --- | --- |
| `_qbtcp` | Written. The documented home for new operational metadata. |
| `_qbsheet_source` | **Read** for compatibility. No longer written as the preferred form. |
| `_scoresheet_source` | **Read** for compatibility with pre-QBSheet files. Never written. |

## Result identity and deduplication

The same result can arrive twice — once automatically over QBTCP, once as a QBJ the scorekeeper
downloaded and uploaded by hand. That must not create two matches.

Matching order:

1. `Tournament.id` and `Match.id` — the strongest identity, and the reason assignments preserve ids.
2. Failing that, the **portable statistical result fingerprint**.

The fingerprint is computed over the statistical content only. It **ignores**:

- `_qbtcp` transport and source metadata
- legacy source extensions (`_qbsheet_source`, `_scoresheet_source`)
- private recovery data
- object key ordering

so that the same game scored once produces one fingerprint regardless of how it travelled.

Outcomes:

| Situation | Behavior |
| --- | --- |
| Automatic and manual copies agree | *"Backup copy matches existing result."* No duplicate. |
| Same `Match.id`, different statistics | Explicit conflict for human review. **Never** silently overwritten. |
| Result carries an older `round_revision` | Flagged as stale/superseded. Not silently accepted as current. |

## Filenames

`.qbj` for every new public file, with a descriptive suffix:

| Purpose | Example |
| --- | --- |
| Assignment | `R04_Room-204_Ninety-Six_vs_Greenwood.assignment.qbj` |
| Completed result | `R04_Room-204_Ninety-Six_vs_Greenwood.result.qbj` |
| Mid-game backup | `R04_Room-204_Ninety-Six_vs_Greenwood.partial.qbj` |

The suffix is **human guidance only**. No implementation may treat a filename as authoritative
identity, or decide how to parse a document from its name. Two rooms will rename these files and one
of them will not.

## See also

- [`QBTCP.md`](QBTCP.md) — the live protocol, including how an assignment is delivered over HTTP
- [`QBG_MIGRATION.md`](QBG_MIGRATION.md) — retiring the legacy `.qbg` package
