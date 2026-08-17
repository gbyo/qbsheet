# Move from QBG and api-v1

Two migrations happen together. The file that a room opens and the response that a room fetches
become the same document.

    FILES:       QBJ
    NETWORK:     QBTCP
    APP:         QBSheet
    TOURNAMENT:  Fruity

The normative document is
[`docs/QBG_MIGRATION.md`](https://github.com/gbyo/qbsheet/blob/main/docs/QBG_MIGRATION.md).

## Part 1. The `.qbg` game package

### Why it goes

The old package held the tournament identity, the match identity, the round, the room, both rosters,
the format, the room procedure, and the handoff instruction.

It was a reasonable design. It goes for one reason: almost all of it is already QBJ. A second schema
meant a second parser, a second set of bugs, and a second thing for the file path and the network
path to disagree about.

### Field by field

| Old field | New home |
| --- | --- |
| `tournament.key` | `Tournament.id` |
| `tournament.name` | `Tournament.name` |
| `scheduledMatchId` | `Match.id` |
| `round.number`, `round.name` | `Round`, with a `Phase` |
| `round.packetName` | The packet identity on the round |
| `round.revision` | `_qbtcp.round_revision` |
| `room.name` | `Match.location` |
| `room.id` | `_qbtcp.room_id` |
| `left`, `right` rosters | `Registration`, `Team`, and `Player` objects |
| `left.startingLineup` | The standard QBJ lineup on the `Match` |
| `scorekeeperFormat` | `ScoringRules`, except `timed`, which goes to `_qbtcp.scorekeeper.timed` |
| `procedure` | `_qbtcp.procedure` |
| `handoffInstruction` | `_qbtcp.handoff_instruction` |

Five fields survive as extension data. QBJ already held everything else. That ratio is the argument
for the change.

### What still works

| Capability | QBSheet | Fruity |
| --- | --- | --- |
| Read an official serialised `.qbj` document | Yes | Yes |
| Read a match-only `.qbj` document | Yes | Yes |
| Read a legacy `.qbg` package | Yes | Not applicable |
| Write `.qbj` | Yes, the only output | Yes, for assignments |
| Write `.qbg` | No | No |

Fruity stops the creation of `.qbg` files. QBSheet keeps the import. A director with a folder of old
files loses nothing.

When you open a `.qbg` file, QBSheet shows a small note:

> **Legacy QBSheet game file**
> This file is supported, but new assignments use QBJ.

It is a note, not a dialog. It does not interrupt the scoring. Inside the application, the file goes
through the same validation as every other input.

### `GameDefinition` is internal

The old package was a public file specification. `GameDefinition` is not, and that is the real change
rather than the new name.

`GameDefinition` never goes to disk. It never goes over the network. It carries no public version
contract. It exists so that one parser serves both paths, and so the scorer is built against exactly
one thing.

## Part 2. `/api/v1` becomes `/qbtcp/v1`

The old room API already had the right behaviour. It was simply named as the API of one product.
QBTCP gives it a neutral name and a specification. The handlers do not change.

Keep every `/api/v1` route as an alias that dispatches to the identical handler. An alias must never
have its own logic. Every alias is deprecated from the day it appears. New software must use the
canonical paths.

### Route map

| Legacy `/api/v1` | Canonical `/qbtcp/v1` | Credential |
| --- | --- | --- |
| `GET /status` | `GET /qbtcp/v1` | none |
| `GET /tournament` | `GET /qbtcp/v1` and `GET /qbtcp/v1/tournament` | none |
| `GET /join/rooms` | `GET /qbtcp/v1/rooms` | none |
| `POST /join` | `POST /qbtcp/v1/pair` | none |
| `GET /rooms/:roomId/assignment` | `GET /qbtcp/v1/assignment` | room |
| — new — | `GET /qbtcp/v1/assignment/status` | room |
| `POST /rooms/:roomId/sessions` | `POST /qbtcp/v1/sessions` | room |
| `POST /rooms/:roomId/players` | `POST /qbtcp/v1/roster/players` | room |
| `GET` and `POST /rooms/:roomId/presence` | `GET` and `POST /qbtcp/v1/presence` | room |
| `GET` and `POST /rooms/:roomId/help` | `GET` and `POST /qbtcp/v1/help` | room |
| `DELETE /rooms/:roomId/help/:helpId` | `DELETE /qbtcp/v1/help/{id}` | room |
| `POST /sessions` | `POST /qbtcp/v1/sessions` | room |
| `GET /sessions/:sessionId` | `GET /qbtcp/v1/sessions/{id}` | session |
| `GET /sessions/:sessionId/recovery` | `GET /qbtcp/v1/sessions/{id}/recovery` | session |
| `PUT /sessions/:sessionId/snapshot` | `PUT /qbtcp/v1/sessions/{id}/progress` | session |
| `POST /sessions/:sessionId/final` | `POST /qbtcp/v1/sessions/{id}/result` | session |
| — new — | `POST /qbtcp/v1/sessions/{id}/writer` | session |
| `GET /public/snapshot` | Not QBTCP. It stays at `/api/v1`. | none |
| `GET /public/pairings` | Not QBTCP. It stays at `/api/v1`. | none |
| `GET /rounds`, `GET /teams` | Not QBTCP. They stay at `/api/v1`. | none |

### Three decisions in that table

1. **The room identifier leaves the path.** A room token already scopes to one room. The path segment
   was redundant, and it suggested that a person could select a room with an edit to a URL. The token
   is the authority. The handler finds the room from the token.

2. **The public display endpoints are not QBTCP.** They serve a spectator display and a join screen,
   not a scoresheet. A move under `/qbtcp/v1` would suggest that a scoresheet needs them.

3. **`snapshot` becomes `progress` and `final` becomes `result`.** These are renames only. The
   behaviour does not change.

### What does not change

- The capability-token model: room tokens and session tokens, no accounts, no server-wide reads.
- The header names `x-yf-room-token`, `x-yf-session-token`, `x-yf-device-id`, and
  `x-yf-operator-name`.
- The origin allowlist, the refusal of a wildcard on an authenticated endpoint, and the Private
  Network Access preflight.
- The pairing rate limit and the uniform pairing failure message.

## Part 3. What a director sees

Before:

```
Tournament Scoring/
  Room 204/
    TO SCORE/
      Round 4 — Ninety Six vs Greenwood.qbg
```

After:

```
Tournament Scoring/
  Room 204/
    TO SCORE/
      R04_Room-204_Ninety-Six_vs_Greenwood.assignment.qbj
```

The workflow does not change. It is still one file per scheduled match. It is still only the released
round. Later matches that depend on a rebracket are still absent. You can still group by room.

The one difference is the file itself. Any QBJ tool can open it now, and the same bytes are what the
room would receive over the network.

## Related pages

- [QBTCP for implementers](QBTCP-for-implementers)
- [Files and formats](Files-and-formats)
