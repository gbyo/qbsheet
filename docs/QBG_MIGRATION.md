# Migration: `.qbg` → QBJ, `/api/v1` → QBTCP

Two migrations happen together, because they are the same change seen from two sides: the file a
room opens and the response a room fetches become the same document.

    FILES:       QBJ
    NETWORK:     QBTCP
    APP:         QBSheet
    TOURNAMENT:  Fruity

## Part 1 — the `.qbg` game package

### What `.qbg` was

`IGamePackage` (`format: "quizbowl-game"`, `version: 1`) carried tournament identity and name,
scheduled match identity, round, round revision, room, both rosters, the scorekeeper format, room
procedure, and a handoff instruction.

It was a reasonable design and it is being retired for one reason: **almost all of it is already
QBJ**. Tournament, Round, Team, Player, and ScoringRules have had standard representations the whole
time. Maintaining a second schema for them meant maintaining a second set of bugs, a second parser,
and a second thing for the network and file paths to disagree about.

### Field-by-field disposition

| `.qbg` field | Becomes |
| --- | --- |
| `tournament.key` | `Tournament.id` |
| `tournament.name` | `Tournament.name` |
| `scheduledMatchId` | `Match.id` |
| `round.number`, `round.name` | `Round` (with `Phase`) |
| `round.packetName` | Packet identity on the round |
| `round.revision` | `_qbtcp.round_revision` — no QBJ equivalent |
| `room.name` | `Match.location` |
| `room.id` | `_qbtcp.room_id` — stable id, where it differs in kind from `location` |
| `left`, `right` (rosters) | `Registration` / `Team` / `Player` objects |
| `left.startingLineup` | Standard QBJ lineup representation on the `Match` |
| `scorekeeperFormat` | `ScoringRules`, except `timed` → `_qbtcp.scorekeeper.timed` |
| `procedure` | `_qbtcp.procedure` — operations, not scoring; no QBJ equivalent |
| `handoffInstruction` | `_qbtcp.handoff_instruction` — no QBJ equivalent |

Five fields survive as extension data. Everything else was already expressible in QBJ. That ratio is
the argument for the migration.

### Support timeline

| Capability | QBSheet | Fruity |
| --- | --- | --- |
| **Read** official serialized `.qbj` | Yes | Yes |
| **Read** Match-only `.qbj` (MODAQ-style) | Yes | Yes |
| **Read** legacy `.qbg` | Yes — retained | n/a |
| **Write** `.qbj` | Yes — the only output | Yes — assignments |
| **Write** `.qbg` | **No** | **No** — stops on this change |

Fruity stops generating `.qbg` as soon as QBJ assignment export is in place. QBSheet keeps `.qbg`
import for now; nothing breaks for a director holding a folder of them.

When a `.qbg` is opened, QBSheet shows a small non-blocking note:

> **Legacy QBSheet game file**
> This file is supported, but new assignments use QBJ.

It is a note, not a dialog, and it does not interrupt scoring. Internally the file is converted to
`GameDefinition` through the same validation rules as every other input.

### `GameDefinition` is internal

`IGamePackage` was a public file specification. `GameDefinition` is not, and that is the substantive
change rather than the rename. It is never written to disk, never sent over the network, and carries
no public version contract. It exists so that one parser serves the file path and the network path,
and so the scorer is built against exactly one thing.

## Part 2 — `/api/v1` → `/qbtcp/v1`

The existing room API already had the right semantics; it was simply named as one product's API.
QBTCP gives it a product-neutral name and a specification, and the handlers do not change.

### Route mapping

Canonical routes are `/qbtcp/v1/...`. Existing `/api/v1/...` routes are retained as **aliases that
dispatch to the identical handler** — not duplicated logic, not a compatibility shim with its own
behavior. They are deprecated on introduction.

| Legacy `/api/v1` | Canonical `/qbtcp/v1` | Auth |
| --- | --- | --- |
| `GET /status` | `GET /qbtcp/v1` (discovery) | none |
| `GET /tournament` | `GET /qbtcp/v1` (discovery) + `GET /qbtcp/v1/tournament` | none |
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
| `GET /rounds`, `GET /teams` | *(not QBTCP)* — stays at `/api/v1` | none |

Three decisions in that table are worth stating explicitly:

1. **`:roomId` leaves the path.** A room token already scopes to exactly one room, so the path
   segment was redundant and gave the impression that a room could be selected by editing a URL.
   The token is the authority; the handler resolves the room from it.

2. **Public display endpoints are not QBTCP.** `/public/snapshot`, `/public/pairings`, `/rounds`,
   and `/teams` serve a spectator display and a join screen, not a scoresheet under this protocol.
   Moving them under `/qbtcp/v1` would imply a scoresheet needs them. They stay where they are.

3. **`snapshot` → `progress` and `final` → `result`** are renames only. The semantics — snapshot
   replacement, idempotent final submission — are unchanged and are now specified in
   [`QBTCP.md`](QBTCP.md).

### What does not change

- The capability-token security model: room tokens and session tokens, no accounts, no server-wide
  reads.
- Header names `x-yf-room-token`, `x-yf-session-token`, `x-yf-device-id`, `x-yf-operator-name`.
  These are historical and retained deliberately so deployed clients keep working; a future protocol
  version is expected to rename them.
- Origin allowlisting, the refusal to send `Access-Control-Allow-Origin: *` on authenticated
  endpoints, and Private Network Access preflight handling.
- Pairing rate limits and uniform pairing failure messages.

### Client migration

QBSheet switches to the canonical `/qbtcp/v1` routes. Older deployed QBSheet builds continue to work
against `/api/v1` aliases for as long as those are retained.

## Part 3 — what a director actually sees

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

Still one file per scheduled match, still only the current released round, still no pre-generation
of later rebracket-dependent matches, still groupable by room. The file is now something any QBJ
tool can open, and the same bytes are what the room would have received over QBTCP.

## See also

- [`QBTCP.md`](QBTCP.md) — the protocol specification
- [`QBJ_ASSIGNMENT_PROFILE.md`](QBJ_ASSIGNMENT_PROFILE.md) — the QBJ profile and `_qbtcp` extension
