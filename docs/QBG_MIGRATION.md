# Migration: `.qbg` → QBJ, `/api/v1` → QBTCP

Two migrations happen together. They are one change seen from two sides, because the file that a room
opens and the response that a room fetches become the same document.

    FILES:       QBJ
    NETWORK:     QBTCP
    APP:         QBSheet
    TOURNAMENT:  Fruity

## Part 1 — the `.qbg` game package

### What `.qbg` was

`IGamePackage`, with `format: "quizbowl-game"` and `version: 1`, carried the tournament identity and
name, the scheduled match identity, the round, the round revision, the room, both rosters, the
scorekeeper format, the room procedure, and a handoff instruction.

The format is retired for one reason. QBJ already represents almost all of that content. `Tournament`,
`Round`, `Team`, `Player`, and `ScoringRules` have had standard representations throughout. A second
schema for them meant a second parser, a second set of defects, and a second opportunity for the
network path and the file path to disagree.

### Field-by-field disposition

| `.qbg` field | Becomes |
| --- | --- |
| `tournament.key` | `Tournament.id` |
| `tournament.name` | `Tournament.name` |
| `scheduledMatchId` | `Match.id` |
| `round.number`, `round.name` | `Round`, with a `Phase` |
| `round.packetName` | The packet identity on the round |
| `round.revision` | `_qbtcp.round_revision` — no QBJ equivalent |
| `room.name` | `Match.location` |
| `room.id` | `_qbtcp.room_id` — a stable identifier, where it differs in kind from `location` |
| `left`, `right` rosters | `Registration`, `Team`, and `Player` objects |
| `left.startingLineup` | The standard QBJ lineup representation on the `Match` |
| `scorekeeperFormat` | `ScoringRules`, except `timed`, which becomes `_qbtcp.scorekeeper.timed` |
| `procedure` | `_qbtcp.procedure` — operations rather than scoring; no QBJ equivalent |
| `handoffInstruction` | `_qbtcp.handoff_instruction` — no QBJ equivalent |

Five fields survive as extension data. QBJ already expressed everything else.

### Support timeline

| Capability | QBSheet | Fruity |
| --- | --- | --- |
| **Read** official serialized `.qbj` | Yes | Yes |
| **Read** Match-only `.qbj`, in the MODAQ style | Yes | Yes |
| **Read** legacy `.qbg` | Yes — retained | Not applicable |
| **Write** `.qbj` | Yes — the only output | Yes — assignments |
| **Write** `.qbg` | No | No — stops on this change |

Fruity stops the generation of `.qbg` as soon as QBJ assignment export is in place. QBSheet retains
`.qbg` import, so that a director who holds a folder of them loses no access.

When a scorekeeper opens a `.qbg` file, QBSheet shows a small note that does not block:

> **Legacy QBSheet game file**
> This file is supported, but new assignments use QBJ.

The note is not a dialog, and it does not interrupt scoring. Internally QBSheet converts the file to
`GameDefinition` through the same validation rules as every other input.

### `GameDefinition` is internal

`IGamePackage` was a public file specification. `GameDefinition` is not, and that difference is the
substantive change rather than the new name.

QBSheet never writes `GameDefinition` to disk and never sends it over the network, and it carries no
public version contract. It exists so that one parser serves the file path and the network path, and
so that the scorer builds against exactly one thing.

## Part 2 — `/api/v1` → `/qbtcp/v1`

The existing room API already had the correct semantics. Its name presented it as the API of one
product. QBTCP gives it a product-neutral name and a specification, and the handlers do not change.

### Route mapping

The canonical routes are `/qbtcp/v1/...`. Implementations retain the existing `/api/v1/...` routes as
**aliases that dispatch to the identical handler**. An alias holds no duplicated logic and no
behaviour of its own. Every alias is deprecated from its introduction.

| Legacy `/api/v1` | Canonical `/qbtcp/v1` | Auth |
| --- | --- | --- |
| `GET /status` | `GET /qbtcp/v1` (discovery) | none |
| `GET /tournament` | `GET /qbtcp/v1` (discovery) and `GET /qbtcp/v1/tournament` | none |
| `GET /join/rooms` | `GET /qbtcp/v1/rooms` | none |
| `POST /join` | `POST /qbtcp/v1/pair` | none |
| `GET /rooms/:roomId/assignment` | `GET /qbtcp/v1/assignment` | room |
| — *(new)* | `GET /qbtcp/v1/assignment/status` | room |
| `POST /rooms/:roomId/sessions` | `POST /qbtcp/v1/sessions` | room |
| `POST /rooms/:roomId/players` | `POST /qbtcp/v1/roster/players` | room |
| `GET\|POST /rooms/:roomId/presence` | `GET\|POST /qbtcp/v1/presence` | room |
| `GET\|POST /rooms/:roomId/help` | `GET\|POST /qbtcp/v1/help` | room |
| `DELETE /rooms/:roomId/help/:helpId` | `DELETE /qbtcp/v1/help/{id}` | room |
| `POST /sessions` | `POST /qbtcp/v1/sessions` | room |
| `GET /sessions/:sessionId` | `GET /qbtcp/v1/sessions/{id}` | session |
| `GET /sessions/:sessionId/recovery` | `GET /qbtcp/v1/sessions/{id}/recovery` | session |
| `PUT /sessions/:sessionId/snapshot` | `PUT /qbtcp/v1/sessions/{id}/progress` | session |
| `POST /sessions/:sessionId/final` | `POST /qbtcp/v1/sessions/{id}/result` | session |
| — *(new)* | `POST /qbtcp/v1/sessions/{id}/writer` | session |
| `GET /public/snapshot` | *(not QBTCP)* — stays at `/api/v1` | none |
| `GET /public/pairings` | *(not QBTCP)* — stays at `/api/v1` | none |
| `GET /rounds`, `GET /teams` | *(not QBTCP)* — stay at `/api/v1` | none |

Three entries in that table need an explanation.

1. **`:roomId` leaves the path.** A room token already scopes to exactly one room, so the path segment
   was redundant. It also suggested that a person could select a room with an edit to a URL. The token
   is the authority, and the handler resolves the room from it.

2. **The public display endpoints are not QBTCP.** `/public/snapshot`, `/public/pairings`, `/rounds`,
   and `/teams` serve a spectator display and a join screen. They do not serve a scoresheet under this
   protocol. A move under `/qbtcp/v1` would imply that a scoresheet needs them, so they stay where
   they are.

3. **`snapshot` becomes `progress`, and `final` becomes `result`.** Both are renames. The semantics,
   which are snapshot replacement and idempotent final submission, do not change.
   [`QBTCP.md`](QBTCP.md) now specifies them.

### What does not change

- The capability-token security model: room tokens and session tokens, no accounts, and no server-wide
  reads.
- The header names `x-yf-room-token`, `x-yf-session-token`, `x-yf-device-id`, and
  `x-yf-operator-name`. These names are historical, and implementations retain them so that deployed
  clients keep working. A future protocol version is expected to rename them.
- Origin allowlisting, the refusal to send `Access-Control-Allow-Origin: *` on an authenticated
  endpoint, and Private Network Access preflight handling.
- Pairing rate limits and uniform pairing failure messages.

### Client migration

QBSheet switches to the canonical `/qbtcp/v1` routes. An older deployed QBSheet build continues to work
against the `/api/v1` aliases for as long as a server retains them.

## Part 3 — what a director sees

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

The workflow does not change. Fruity still writes one file per scheduled match, still writes only the
released round, still pre-generates no match that depends on a rebracket, and still groups by room.

The file is now the same QBJ document that the room receives over QBTCP, and any QBJ tool can open it.

## See also

- [`QBTCP.md`](QBTCP.md) — the protocol specification
- [`QBJ_ASSIGNMENT_PROFILE.md`](QBJ_ASSIGNMENT_PROFILE.md) — the QBJ profile and the `_qbtcp` extension
