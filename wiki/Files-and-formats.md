# Files and formats

QBJ is QBSheet's public interchange format. QBSheet also writes a QBSheet-specific `.qbsheet`
recovery file when an unfinished game must move between devices. This page tells you which shapes
QBSheet reads, which shape QBSheet writes, and what QBSheet does when a file leaves something out.

The normative document is
[`docs/QBJ_ASSIGNMENT_PROFILE.md`](https://github.com/gbyo/qbsheet/blob/main/docs/QBJ_ASSIGNMENT_PROFILE.md).
Read it before you write software that makes a file for QBSheet.

## The numbers

| Item | Value |
| --- | --- |
| Serialisation version | `2.1.1` |
| Media type | `application/vnd.quizbowl.qbj+json` |
| File extension | `.qbj` |

There is no `.qbs` format. `.qbsheet` is not a QBJ replacement: it is the versioned, credential-free
QBSheet recovery envelope described in [Recovery and backups](Recovery-and-backups).

## What QBSheet reads

| Shape | Status |
| --- | --- |
| An official serialised QBJ document, `{version, objects}` | Preferred. One game or a whole tournament. |
| A match-only QBJ document, a bare `Match` object | Supported for compatibility. MODAQ writes this shape. |
| A versioned `.qbsheet` recovery envelope | Supported for exact, credential-free local restore. It opens offline. |
| A legacy `.qbg` game package | Import only. Deprecated. |

All supported file shapes go through one parser and one set of validation rules. A network assignment goes
through the same parser. So the file path and the network path cannot drift apart.

## What QBSheet writes

| Shape | Where |
| --- | --- |
| An official serialised QBJ document | The default download |
| A match-only QBJ document | Under a **More…** menu, for another tool |
| A QBSheet recovery backup | Under **Export / backup…**, for moving an unfinished game |

QBSheet does not write `.qbg`.

## File names

| Purpose | Example |
| --- | --- |
| An assignment | `R04_Room-204_Ninety-Six_vs_Greenwood.assignment.qbj` |
| A completed result | `R04_Room-204_Ninety-Six_vs_Greenwood.result.qbj` |
| A mid-game backup | `R04_Room-204_Ninety-Six_vs_Greenwood.partial.qbj` |
| A QBSheet recovery backup | `R04_Room-204_Ninety-Six_vs_Greenwood.qbsheet` |

**A file name is guidance for a person.** No software reads a file name to decide what a document is,
or to decide which game it belongs to. The identifiers inside the document carry the identity. Two
rooms will rename these files and one of them will get it wrong.

## What an assignment holds

An assignment is a normal QBJ document with one unplayed scheduled match. Include only these
objects:

- Exactly one `Tournament`
- The `ScoringRules`
- The `Registration`, `Team`, and `Player` objects for the two teams
- The relevant `Phase`
- The relevant `Round`
- Exactly one `Match`
- The packet identity, when it is known

Do not include any of these:

- Standings and rankings
- The games of other rooms
- Future pairings or unreleased pairings
- Any credential, pairing code, room token, or session token
- A device identifier or a server address
- Browser recovery state

A room needs the game in front of it. Everything on the second list is either wrong by the end of the
round, or information that the room must not hold.

**An unplayed match must look unplayed.** Do not write zero scores, empty team totals, or a
`tossups_read` of `0`. QBSheet tells an assignment from a result by the absence of scoring content. A
false zero destroys that signal.

## Where identity comes from

| Identity | Field |
| --- | --- |
| The tournament | `Tournament.id` |
| The scheduled match | `Match.id` |
| A team | `Team.id`, with its `Registration` |
| A player | `Player.id` |
| The phase | `Phase.id` |
| The round | `Round.id` and `Round.name` |
| The room | `Match.location` |

## The `_qbtcp` extension

QBJ cannot say a few operational things. Those things travel in a small optional block on the
`Match`. A tool that has never heard of the block reads the match as normal.

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

| Field | Why QBJ cannot hold it |
| --- | --- |
| `round_revision` | QBJ has no idea of a redrawn pairing. Without this field, a stale result looks current. |
| `room_id` | `Match.location` is a display string. A stable identifier survives a rename. |
| `procedure` | Halves, the clock, and the timeout policy are operations, not scoring rules. |
| `handoff_instruction` | Free text for the room. The application does not read it. |
| `scorekeeper.timed` | QBJ scoring rules have no field for a timed round. |

Three rules apply to this block:

1. Only `version` is mandatory. Every other field is optional.
2. The block must not restate an identity that QBJ already carries.
3. `timed` is the only scoring value allowed here. Everything else that QBJ can say must go in
   `ScoringRules`.

**Caution for an implementer:** a key inside `_qbtcp` must not use the name of a QBJ snake-case key.
The reference parser converts key names and it recurses into nested objects. A collision silently
renames your field.

## What QBSheet does when a file leaves something out

QBSheet asks. QBSheet does not guess.

| Missing | Behaviour |
| --- | --- |
| The scoring rules | QBSheet stops and says that the document does not give enough scoring information. You then choose a format. |
| The players | QBSheet lets you type the players. Scoring goes on as normal. |
| The room procedure | Scoring works. QBSheet says that it will not enforce a rule that it does not know. |
| The room | Scoring works. QBSheet shows no room. |
| The round | Scoring works. QBSheet shows a neutral label. |
| `timed` | QBSheet assumes nothing. QBSheet asks when the answer changes the scoring. |

**QBSheet never branches on the name of a rule set.** Scoring behaviour comes from the structural
fields in `ScoringRules`. No code path tests `ScoringRules.name` for `"NAQT"`, for `"ACF"`, or for any
other string. The name is a label.

## A whole-tournament file

QBSheet accepts a QBJ document for a whole tournament.

- One scoreable match: QBSheet opens it directly.
- More than one: QBSheet shows a game list, grouped by round.

QBSheet lists unplayed matches first. QBSheet marks a match that already holds a score, and never
opens such a match silently.

A whole-tournament file is for interoperability. One file per game is still the normal workflow.

## Validation of an untrusted document

Every document is untrusted. This includes a document that arrived over an authenticated connection.
QBSheet enforces these rules:

- A size limit before the parse
- A shape check on every object
- Finite numbers only, with no `NaN` and no `Infinity`
- Format values that are positive and in range
- Team names and player names that are not blank
- No duplicate player inside one team
- A lineup that is a subset of its roster, with no repeat, inside the active limit
- Safe identifier strings
- A rejection of prototype-pollution keys
- A supported-version check, with a plain message for an unsupported version

## How two copies of one result stay one game

The same result can arrive twice. It can arrive over the network and then again as a file that a
person uploaded. That must not create two games.

Tournament control software matches in this order:

1. `Tournament.id` and `Match.id`.
2. A fingerprint of the statistical content.

The fingerprint ignores the `_qbtcp` block, the legacy source blocks, the private recovery data, and
the order of the keys. So one game gives one fingerprint, whatever route it took.

| Situation | Behaviour |
| --- | --- |
| The two copies agree | The software reports a matched backup copy. It records no duplicate. |
| The same `Match.id`, different statistics | The software raises a conflict for a person. It never overwrites silently. |
| The result carries an older `round_revision` | The software marks the result stale. It does not accept it as current. |

## Source metadata keys

| Key | Status |
| --- | --- |
| `_qbtcp` | Written. This is the home for new operational metadata. |
| `_qbsheet_source` | Read for compatibility. No longer written. |
| `_scoresheet_source` | Read for compatibility. Never written. |
| `_yf_scorekeeper_recovery` | Always removed from a portable download. |

## Related pages

- [QBTCP for implementers](QBTCP-for-implementers)
- [Move from QBG and api-v1](Move-from-QBG-and-api-v1)
- [Score a game from a file](Score-a-game-from-a-file)
