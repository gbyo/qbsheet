# QBTCP — Quiz Bowl Tournament Control Protocol

**Version 1** An application-layer HTTP/JSON protocol for communication between electronic
quiz bowl scoresheets and tournament-control software.

## What QBTCP is not

QBTCP is **not** a transport protocol. It is not a replacement for, an alternative to, or a layer
beneath TCP/IP. The name describes what it controls — a quiz bowl tournament — not where it sits in
the network stack. QBTCP runs over ordinary HTTP, which runs over TCP/IP like everything else. A
QBTCP implementation opens no sockets of its own and defines no framing, no retransmission, and no
congestion control.

QBTCP is also not "the Fruity API". Fruity is one tournament-control implementation of QBTCP;
QBSheet is one scoresheet implementation. Another tournament manager must be able to implement this
specification without reading or importing either codebase, and this document is written to make
that possible.

## Scope, and the one rule that defines it

    QBJ is the game and tournament data.
    QBTCP is the live conversation around that data.

QBTCP owns operational behavior that only exists while a tournament is running:

- protocol discovery and version negotiation
- room pairing and authentication
- delivery of the current assignment
- presence
- active-writer ownership and takeover
- in-progress snapshots
- final result delivery
- reconnection and server-assisted recovery
- help requests
- assignment lifecycle and revision handling

QBTCP does **not** define, redefine, or restate:

- Tournament, Phase, Round, Registration, Team, Player
- Match, MatchTeam, MatchPlayer, MatchQuestion
- ScoringRules
- result statistics of any kind

Those are QBJ. Where QBTCP needs to carry any of them, it carries a QBJ document and says so. A
QBTCP implementation that invents a parallel team or match schema has misread this specification.

## Terminology

| Term | Meaning |
| --- | --- |
| **Tournament control** | The software that owns the schedule and collects results. Fruity is one. |
| **Scoresheet** | The client that scores one game at a time. QBSheet is one. |
| **Room** | A scoring position in the tournament. The unit that pairs and authenticates. |
| **Session** | One scoresheet's work on one assigned game. The unit that writes snapshots and a result. |
| **Assignment** | The game a room should be scoring now, expressed as a QBJ document. |
| **Round revision** | A monotonically increasing integer identifying which issue of a round's pairings an assignment came from. |
| **Active writer** | The one device currently authorized to write to a session. |

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are used in their ordinary
specification sense.

## Versioning

The protocol version is a single integer in the path: `/qbtcp/v1/...`. It is incremented only for
changes that a version-1 client cannot tolerate. Adding an optional response field, an optional
request field, or a new capability is not such a change, and clients MUST ignore response fields
they do not recognize rather than failing.

Version negotiation is discovery, not a handshake. A client fetches the discovery document, reads
`version` and `capabilities`, and decides what it can do. There is no in-band upgrade.

## Discovery

    GET /qbtcp/v1

Unauthenticated. Response:

```json
{
  "protocol": "QBTCP",
  "version": 1,
  "capabilities": ["pairing", "assignment", "progress", "result", "recovery", "help", "presence"],
  "qbj_version": "2.1.1",
  "name": "Greenwood Fall Invitational"
}
```

`capabilities` is the authoritative statement of what this server supports. A client MUST NOT infer
support from the absence of an error, and MUST NOT require a capability it did not see advertised.
`qbj_version` is the QBJ serialization version this server produces and accepts.

Discovery carries no credential and MUST NOT reveal the schedule, room list, team list, or any
pairing code.

## Authentication

QBTCP uses **capability tokens**. A token is an opaque bearer string that grants exactly one scope,
and there are two:

| Token | Scope | Header |
| --- | --- | --- |
| Room token | One room: read its assignment, post presence and help, open sessions | `x-yf-room-token` |
| Session token | One session: read it, write snapshots, submit the final result, read recovery | `x-yf-session-token` |

There is no user account, no password, and no server-wide read. A session token reaches exactly one
session; changing the id in the path does not reach another room's game.

Two further headers are informational, never authorizing:

| Header | Meaning |
| --- | --- |
| `x-yf-device-id` | Opaque per-browser identity, used for active-writer arbitration |
| `x-yf-operator-name` | Human name of the scorekeeper, for the director's presence view |

> **Header naming.** The `x-yf-` prefix is retained from the pre-QBTCP implementation for
> compatibility with deployed clients. It is historical, not a claim of ownership; a future protocol
> version is expected to rename these. Implementations MUST treat the names as opaque strings.

Credentials MUST be sent as headers. They MUST NOT appear in a URL, a query string, a log line, a
rendered UI, an error message, or any QBJ document. See "Security model".

## Pairing

    POST /qbtcp/v1/pair
    { "code": "48213906", "roomId": "room-204" }

Exchanges a short human-typed code for a room token. `roomId` is optional and only disambiguates
when a code is not globally unique.

```json
{ "roomId": "room-204", "roomName": "Room 204", "token": "<opaque room token>" }
```

Pairing is the only endpoint that turns a human-memorable secret into a capability, so it is the
one that gets attacked. Implementations MUST:

- rate-limit attempts per client source and return `429` when exceeded
- return an **identical** failure for a malformed code, an unknown code, a disabled room, and a
  code/room mismatch — a distinguishable error is an oracle for enumerating rooms
- never include the code in a response or a log

A supporting listing endpoint MAY be offered for a room picker:

    GET /qbtcp/v1/rooms

It returns room ids, display names, and descriptions only. It MUST NOT return tokens or pairing
codes, and it exists so a scorekeeper can pick "Room 204" from a list instead of typing an id.

## Assignment

    GET /qbtcp/v1/assignment            (room token)

**The response body is a QBJ document.** Content type:

    application/vnd.quizbowl.qbj+json

This is the central architectural commitment of QBTCP v1. The assignment a scoresheet receives over
the network is semantically the same document tournament control could have written to disk as
`*.assignment.qbj`, and both are parsed by the same parser on the client. There is no
`NetworkAssignmentModel` and no `FileAssignmentModel`. See
[`QBJ_ASSIGNMENT_PROFILE.md`](QBJ_ASSIGNMENT_PROFILE.md) for the document's contents.

Operational state that is not part of the game — whether the room is blocked, what it played last,
whether a session is already open — is **not** in the QBJ body. It travels in response headers or in
a sibling endpoint, because putting it in the QBJ would mean inventing QBJ fields for it:

    GET /qbtcp/v1/assignment/status     (room token)

```json
{
  "state": "assigned",
  "blocked_reason": null,
  "blocked_message": null,
  "session": { "session_id": "...", "resumable": true },
  "previous": { "label": "Round 3 · Ninety Six vs Emerald" },
  "next": { "label": "Round 5 · Clinton vs Greenwood" },
  "released_round": 4,
  "hold_new_starts": false
}
```

`state` is one of `assigned`, `none`, `blocked`, or `held`. When it is not `assigned`, the
assignment endpoint returns `204 No Content` rather than an empty QBJ document.

A scoresheet MUST persist the normalized assignment locally **before** any scoring depends on a
further network call. After that point the network is optional: see "Durability expectations".

### Session resumption

A session token is obtained by opening a session against the current assignment:

    POST /qbtcp/v1/sessions             (room token)
    { "match_id": "sm-4471", "device_id": "..." }

```json
{ "session_id": "sess-9f13", "token": "<opaque session token>", "writer": true }
```

If a session for that assignment is already open, the server returns the existing one rather than
creating a second. Two devices scoring the same game is a real event — a Chromebook dies and a
phone takes over — and it is resolved by writer ownership, not by refusing.

## Presence

    GET  /qbtcp/v1/presence             (room token)
    POST /qbtcp/v1/presence             (room token)

A heartbeat and a view of it. `POST` records that this device and operator are alive; `GET` returns
what tournament control believes about the room. Presence is advisory. Losing it MUST NOT end a
session, invalidate a token, or affect scoring.

## Writer ownership and takeover

One session, one writer. The device holding writer status may write snapshots and the final result;
another device holding the same session token may read but is refused on write with `409`:

```json
{ "error": "Another device is scoring this game.", "writer_device": "…", "can_take_over": true }
```

Takeover is explicit and human-initiated:

    POST /qbtcp/v1/sessions/{id}/writer  (session token)
    { "device_id": "...", "take_over": true }

The server transfers writer status and the previous writer learns it lost the role on its next
write, which it MUST surface rather than silently discarding the scorekeeper's work. A client MUST
NOT take over automatically on a failed write; automatic takeover between two live devices is how
both of them end up believing they are authoritative.

## Progress

    PUT /qbtcp/v1/sessions/{id}/progress   (session token, writer)

Body is the current game state as a QBJ Match document (see the profile). Progress is a **snapshot**,
not a delta: each write replaces the last, and a client that has been offline sends its current
state rather than replaying what it missed.

Snapshots are therefore idempotent and freely coalescable. A client SHOULD collapse queued snapshots
to the newest and MUST NOT allow a stale queued snapshot to overwrite a newer accepted one. Servers
SHOULD accept out-of-order arrivals by preferring the higher sequence:

    { "sequence": 41, "match": { ... } }

`sequence` is a client-assigned monotonically increasing integer within a session. A server
receiving a lower sequence than it already holds MUST discard it and respond `200` — the client is
not wrong, only late, and an error would trigger a pointless retry.

Progress delivery is best-effort by design. A failed snapshot MUST NOT block scoring, surface as a
scoring error, or discard local state.

## Result

    POST /qbtcp/v1/sessions/{id}/result   (session token, writer)

Body is the completed game as a QBJ document, content type
`application/vnd.quizbowl.qbj+json`. This is the same document the scoresheet would download as
`*.result.qbj`, minus nothing and plus nothing.

```json
{ "accepted": true, "match_id": "sm-4471", "fingerprint": "…", "duplicate": false }
```

`duplicate: true` means this exact statistical result was already recorded — the correct response to
a retry, and not an error. Result submission MUST be idempotent on `(Match.id, fingerprint)`; a
client that retries after a timeout must not create a second match. See "Result identity" below.

Acceptance over QBTCP MUST NOT be treated by the scoresheet as a reason to delete its local copy or
to stop offering the result for manual download.

## Recovery

    GET /qbtcp/v1/sessions/{id}/recovery   (session token)

The second recovery source, for a device whose own local copy is missing or unreadable. It returns
whatever private state the server was given, authorized by the same session capability as every
other operation on that session. There is no room-wide or server-wide recovery read.

Server-assisted recovery is a **fallback**, not the mechanism. A scoresheet's own local journal is
the authoritative exact recovery path; QBTCP recovery exists for the case where that journal is
gone. The two are described together in the profile document.

## Help requests

    GET    /qbtcp/v1/help                (room token)
    POST   /qbtcp/v1/help                (room token)
    DELETE /qbtcp/v1/help/{id}           (room token)

A room asks for a person: a protest to adjudicate, a missing player, a broken buzzer. Categories are
implementation-defined and advertised in discovery. Help is orthogonal to scoring and MUST NOT
affect a session's state.

## Errors and status semantics

Errors are JSON with a human-safe `error` string that a client MAY display verbatim:

```json
{ "error": "This browser origin is not approved.", "code": "origin_not_allowed" }
```

| Status | Meaning | Client obligation |
| --- | --- | --- |
| `400` | Malformed request | Do not retry unchanged |
| `401` | Missing or invalid credential | Re-pair. **MUST NOT discard the in-progress game.** |
| `403` | Valid credential, not permitted (including disallowed origin) | Surface; do not retry in a loop |
| `404` | No such endpoint, session, or room | Do not retry |
| `405` | Method not allowed | Programming error |
| `409` | Writer conflict, or result conflicts with a recorded one | Explicit human resolution |
| `410` | Assignment superseded by a newer revision | Fetch the new assignment; do not discard scored work |
| `413` | Body too large | Do not retry unchanged |
| `429` | Rate limited (pairing) | Back off |
| `5xx` | Server fault | Retry with backoff |

The two that matter most are `401` and `410`, because both describe a server that has changed its
mind about a room that is in the middle of a game. Neither is permitted to destroy that game. A
scoresheet MUST keep scoring locally and MUST keep the result downloadable.

## Durability expectations for scoresheets

QBTCP is designed so that a scoresheet can be **disconnected at any moment without losing a game**.
An implementation claiming QBTCP conformance MUST hold to the following:

- The normalized assignment is persisted locally before scoring depends on any later network call.
- A locally accepted scoring event is durable before it is delivered anywhere.
- Loss of the server never unmounts, blocks, or resets the scorer.
- `401`, `403`, and `410` do not destroy the game.
- A tournament identity change does not destroy the game.
- Reload restores from local state, not from the network.
- Snapshots retry and coalesce; current state always wins over a stale queued one.
- A connected final still offers a manual QBJ download, because "the server said yes" is not a
  backup.

## CORS and local network access

A scoresheet is typically a static site on a public origin talking to tournament-control software on
a laptop on the same LAN. That is a cross-origin request to a private address, and both halves need
handling.

Servers MUST:

- maintain a configurable **allowlist** of scoresheet origins, e.g. `https://qbsheet.com` plus
  development origins
- echo the specific approved origin in `Access-Control-Allow-Origin` and send `Vary: Origin`
- **never** send `Access-Control-Allow-Origin: *` on any authenticated endpoint — a wildcard on a
  capability-token API means any page on the internet can drive a tournament from a scorekeeper's
  browser
- answer preflight (`OPTIONS`) for every QBTCP path, allowing the credential headers above
- reject a preflight from a non-allowlisted origin with `403`

For Chrome's Private Network Access / Local Network Access, a server on a private address MUST
answer a preflight carrying `Access-Control-Request-Private-Network: true` with
`Access-Control-Allow-Private-Network: true`, and MUST list
`Access-Control-Request-Private-Network` among its allowed headers. Without this, a public-origin
scoresheet cannot reach a LAN server at all in current Chrome.

Clients that install a service worker MUST NOT let it cache QBTCP responses as authoritative data. A
cached assignment or a cached result acknowledgement is worse than an error, because it is a
confident wrong answer.

## Security model

1. **Capability tokens, not identities.** A token names what it may do, not who holds it. There is
   no account to compromise.
2. **Least scope.** A room token cannot read another room. A session token cannot read another
   session. Neither can read the tournament.
3. **Credentials never enter QBJ.** No token, pairing code, device id, operator name, server URL, or
   `Authorization` header value may appear in any QBJ document produced or consumed by QBTCP. This
   is an absolute rule; the file formats travel by USB stick and email, and a capability that
   travels with them ends up somewhere nobody intended.
4. **Credentials never enter logs or UI.** Including error text.
5. **Uniform pairing failure.** See "Pairing".
6. **Origin allowlist over wildcard.** See "CORS".
7. **Bounded input.** Servers MUST bound request body size and URL length, and MUST validate all
   received JSON as untrusted: finite numbers, well-formed shapes, no prototype-pollution keys.

## Relationship to QBJ, restated

| Concern | Owned by |
| --- | --- |
| What a match, team, player, round or scoring rule *is* | QBJ |
| What the result of a game *was* | QBJ |
| Which game a room should score now | QBTCP delivering a QBJ document |
| Whether the room may score it, and who is writing | QBTCP |
| How a result gets back, and whether it is a duplicate | QBTCP |

If a change to this specification would require adding a field that describes the game rather than
the conversation, it belongs in QBJ or in the documented `_qbtcp` extension — not here.

## Legacy `/api/v1` compatibility

Version 1 of this protocol was deployed as an unversioned-in-name `/api/v1` surface. Tournament
control implementations migrating to QBTCP SHOULD retain their existing `/api/v1` routes as
**aliases** that dispatch to the identical handlers, so that deployed scoresheets keep working. The
aliases are deprecated on introduction and carry no independent behavior. New scoresheets MUST use
the canonical `/qbtcp/v1` paths.

A mapping table for the reference implementation lives in
[`QBG_MIGRATION.md`](QBG_MIGRATION.md).
