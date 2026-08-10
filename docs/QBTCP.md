# QBTCP — Quiz Bowl Tournament Control Protocol

**Version 1.** An application-layer HTTP/JSON protocol for communication between electronic quiz bowl
scoresheets and tournament-control software.

This document uses the key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY in their ordinary
specification sense.

## Position in the network stack

QBTCP is an application-layer protocol. It runs over HTTP. HTTP runs over TCP/IP.

QBTCP is not a transport protocol, and it does not replace TCP/IP. The name states what the protocol
controls, which is a quiz bowl tournament. A QBTCP implementation opens no socket of its own. It
defines no framing, no retransmission, and no congestion control.

## Product neutrality

Fruity is one tournament-control implementation of QBTCP. QBSheet is one scoresheet implementation.
Neither product owns the protocol.

Another tournament manager must be able to implement this specification without a read of either
codebase. Report any rule that needs one of those codebases as a defect in this document.

## Scope

    QBJ is the game data and the tournament data.
    QBTCP is the live conversation around that data.

QBTCP owns the operational behaviour that exists only while a tournament runs:

- Protocol discovery and version negotiation
- Room pairing and authentication
- Delivery of the current assignment
- Presence
- Active-writer ownership and takeover
- In-progress snapshots
- Final result delivery
- Reconnection and server-assisted recovery
- Help requests
- The assignment lifecycle and the revision of a round

QBTCP does not define, redefine, or restate any of these:

- `Tournament`, `Phase`, `Round`, `Registration`, `Team`, `Player`
- `Match`, `MatchTeam`, `MatchPlayer`, `MatchQuestion`
- `ScoringRules`
- Result statistics of any kind

QBJ defines them. Where QBTCP must carry one of them, it carries a QBJ document and names it as a QBJ
document. A QBTCP implementation that defines a parallel team schema or a parallel match schema has
misread this specification.

## Terminology

| Term | Meaning |
| --- | --- |
| **Tournament control** | The software that owns the schedule and collects the results. Fruity is one. |
| **Scoresheet** | The client that scores one game at a time. QBSheet is one. |
| **Room** | A scoring position in the tournament. The room is the unit that pairs and authenticates. |
| **Session** | The work of one scoresheet on one assigned game. The session is the unit that writes snapshots and a result. |
| **Assignment** | The game that a room must score now, expressed as a QBJ document. |
| **Round revision** | An integer that increases monotonically. It identifies which issue of a round's pairings an assignment came from. |
| **Active writer** | The one device that holds authorisation to write to a session. |

## Versioning

The protocol version is a single integer in the path: `/qbtcp/v1/...`.

Increment the integer only for a change that a version-1 client cannot tolerate. A new optional
response field, a new optional request field, and a new capability are not such changes. A client MUST
ignore a response field that it does not recognise, rather than fail on it.

Version negotiation is discovery, not a handshake. A client fetches the discovery document, reads
`version` and `capabilities`, and then decides what it can do. There is no in-band upgrade.

## Discovery

    GET /qbtcp/v1

This endpoint takes no credential. Response:

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
support from the absence of an error. A client MUST NOT require a capability that discovery did not
advertise.

`qbj_version` is the QBJ serialization version that this server produces and accepts.

Discovery carries no credential. It MUST NOT reveal the schedule, the room list, the team list, or any
pairing code.

## Authentication

QBTCP uses **capability tokens**. A token is an opaque bearer string. Each token grants exactly one
scope, and there are two scopes.

| Token | Scope | Header |
| --- | --- | --- |
| Room token | One room: read its assignment, post presence and help, open sessions | `x-yf-room-token` |
| Session token | One session: read it, write snapshots, submit the final result, read recovery | `x-yf-session-token` |

There is no user account, no password, and no server-wide read. A session token reaches exactly one
session. A change to the identifier in the path does not reach the game of another room.

Two further headers carry information only. They never authorise an operation.

| Header | Meaning |
| --- | --- |
| `x-yf-device-id` | An opaque per-browser identity, used for active-writer arbitration |
| `x-yf-operator-name` | The name of the scorekeeper, for the presence view of the director |

The `x-yf-` prefix comes from the implementation that this protocol replaces. The prefix is
historical, and it is not a claim of ownership. A future protocol version is expected to rename these
headers. Implementations MUST treat the names as opaque strings.

A client MUST send every credential as a header. A credential MUST NOT appear in a URL, a query
string, a log line, a rendered user interface, an error message, or any QBJ document. See "Security
model".

## Pairing

    POST /qbtcp/v1/pair
    { "code": "48213906", "roomId": "room-204" }

This endpoint exchanges a short code that a person typed for a room token. `roomId` is optional, and
it disambiguates a code that is not globally unique.

```json
{ "roomId": "room-204", "roomName": "Room 204", "token": "<opaque room token>" }
```

Pairing is the only endpoint that turns a memorable secret into a capability. Implementations MUST do
all of the following:

- Rate-limit attempts per client source, and return `429` above the limit.
- Return an **identical** failure for a malformed code, an unknown code, a disabled room, and a
  mismatch between the code and the room. A distinguishable error is an oracle for room enumeration.
- Keep the code out of every response and every log.

A server MAY offer a listing endpoint for a room picker:

    GET /qbtcp/v1/rooms

The response contains room identifiers, display names, and descriptions only. It MUST NOT contain a
token or a pairing code. The endpoint exists so that a scorekeeper can choose "Room 204" from a list
instead of a typed identifier.

## Assignment

    GET /qbtcp/v1/assignment            (room token)

**The response body is a QBJ document.** Content type:

    application/vnd.quizbowl.qbj+json

This is the central architectural commitment of QBTCP version 1. The assignment that a scoresheet
receives over the network is semantically the same document that tournament control could write to
disk as `*.assignment.qbj`. One parser on the client reads both. There is no `NetworkAssignmentModel`
and no `FileAssignmentModel`. See [`QBJ_ASSIGNMENT_PROFILE.md`](QBJ_ASSIGNMENT_PROFILE.md) for the
contents of the document.

Operational state is not part of the game, so it is not in the QBJ body. It travels in response
headers or in a sibling endpoint, because a QBJ body would need invented QBJ fields for it.

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

`state` is one of `assigned`, `none`, `blocked`, or `held`. When `state` is not `assigned`, the
assignment endpoint returns `204 No Content`. It does not return an empty QBJ document.

A scoresheet MUST persist the normalized assignment locally **before** any scoring depends on a
further network call. After that point the network is optional. See "Durability requirements for a
scoresheet".

### Open a session

A client obtains a session token when it opens a session against the current assignment:

    POST /qbtcp/v1/sessions             (room token)
    { "match_id": "sm-4471", "device_id": "..." }

```json
{ "session_id": "sess-9f13", "token": "<opaque session token>", "writer": true }
```

When a session for that assignment is already open, the server returns the open session. It does not
create a second one.

Two devices on one game occurs in a real tournament, because a Chromebook can die and a phone can
take over. Writer ownership resolves that case. A refusal does not.

## Presence

    GET  /qbtcp/v1/presence             (room token)
    POST /qbtcp/v1/presence             (room token)

`POST` records that this device and this operator are alive. `GET` returns what tournament control
believes about the room.

Presence is advisory. A lost heartbeat MUST NOT end a session, invalidate a token, or affect the
scoring.

## Writer ownership and takeover

One session has one writer. The device that holds writer status can write snapshots and the final
result. Another device with the same session token can read, and the server refuses its write with
`409`:

```json
{ "error": "Another device is scoring this game.", "writer_device": "…", "can_take_over": true }
```

A takeover is explicit, and a person starts it:

    POST /qbtcp/v1/sessions/{id}/writer  (session token)
    { "device_id": "...", "take_over": true }

The server transfers writer status. The previous writer learns of the loss at its next write, and it
MUST surface that loss rather than discard the work of the scorekeeper.

A client MUST NOT take over automatically after a failed write. Automatic takeover between two live
devices leaves both of them with the belief that they are authoritative.

## Progress

    PUT /qbtcp/v1/sessions/{id}/progress   (session token, writer)

The body is the current game state as a QBJ `Match` document. See the profile document.

Progress is a **snapshot**, not a delta. Each write replaces the last one. A client that was offline
sends its current state, and it does not replay what it missed.

Snapshots are therefore idempotent, and a client can coalesce them freely. A client SHOULD collapse a
queue of snapshots to the newest one. A client MUST NOT let a stale queued snapshot overwrite a newer
accepted one. Servers SHOULD accept an out-of-order arrival by preference for the higher sequence:

    { "sequence": 41, "match": { ... } }

`sequence` is an integer that the client assigns. It increases monotonically inside one session. A
server that receives a sequence lower than the one it holds MUST discard the body and respond `200`.
The client is late rather than wrong, and an error response would cause a pointless retry.

Progress delivery is best-effort. A failed snapshot MUST NOT block the scoring, surface as a scoring
error, or discard local state.

## Result

    POST /qbtcp/v1/sessions/{id}/result   (session token, writer)

The body is the completed game as a QBJ document, with content type
`application/vnd.quizbowl.qbj+json`. It is the same document that the scoresheet would download as
`*.result.qbj`, with nothing added and nothing removed.

```json
{ "accepted": true, "match_id": "sm-4471", "fingerprint": "…", "duplicate": false }
```

`duplicate: true` means that this exact statistical result is already on record. It is the correct
response to a retry, and it is not an error.

Result submission MUST be idempotent on the pair of `Match.id` and `fingerprint`. A client that
retries after a timeout must not create a second match. See "Result identity and deduplication" in
the profile document.

A scoresheet MUST NOT treat acceptance over QBTCP as a reason to delete its local copy, or as a reason
to stop offering the result for manual download.

## Recovery

    GET /qbtcp/v1/sessions/{id}/recovery   (session token)

This is the second recovery source. It serves a device whose own local copy is absent or unreadable.
It returns the private state that the server received. The same session capability authorises it as
every other operation on that session. There is no room-wide read and no server-wide read.

Server-assisted recovery is a fallback. The local journal of a scoresheet is the authoritative exact
recovery path. The profile document describes both paths together.

## Help requests

    GET    /qbtcp/v1/help                (room token)
    POST   /qbtcp/v1/help                (room token)
    DELETE /qbtcp/v1/help/{id}           (room token)

A room asks for a person: a protest to adjudicate, an absent player, a broken buzzer. Categories are
implementation-defined, and discovery advertises them.

Help is orthogonal to scoring. It MUST NOT affect the state of a session.

## Errors and status semantics

An error response is JSON with an `error` string that is safe for a person to read. A client MAY
display that string without a change.

```json
{ "error": "This browser origin is not approved.", "code": "origin_not_allowed" }
```

| Status | Meaning | Client obligation |
| --- | --- | --- |
| `400` | Malformed request | Do not retry unchanged |
| `401` | Missing or invalid credential | Pair again. **MUST NOT discard the game in progress.** |
| `403` | Valid credential without permission, including a disallowed origin | Surface it. Do not retry in a loop. |
| `404` | No such endpoint, session, or room | Do not retry |
| `405` | Method not allowed | A programming error |
| `409` | Writer conflict, or a conflict with a recorded result | A person must resolve it |
| `410` | A newer revision superseded the assignment | Fetch the new assignment. Do not discard scored work. |
| `413` | Body too large | Do not retry unchanged |
| `429` | Rate limited at pairing | Back off |
| `5xx` | Server fault | Retry with a backoff |

`401` and `410` need the most care. Each one describes a server that changed its mind about a room in
the middle of a game. Neither status permits the destruction of that game. A scoresheet MUST continue
to score locally, and MUST keep the result available for download.

## Durability requirements for a scoresheet

QBTCP is designed so that a scoresheet can lose its connection at any moment without the loss of a
game. An implementation that claims QBTCP conformance MUST hold to all of the following:

- It persists the normalized assignment locally before scoring depends on any later network call.
- It makes a locally accepted scoring event durable before it delivers that event anywhere.
- Loss of the server never unmounts, blocks, or resets the scorer.
- `401`, `403`, and `410` do not destroy the game.
- A change of tournament identity does not destroy the game.
- A reload restores from local state, not from the network.
- Snapshots retry and coalesce. The current state always takes precedence over a stale queued one.
- A connected final still offers a manual QBJ download.

## CORS and local network access

A scoresheet is typically a static site on a public origin. Tournament-control software typically runs
on a laptop on the same local network. A request between them is cross-origin and reaches a private
address, and both halves need handling.

Servers MUST do all of the following:

- Maintain a configurable **allowlist** of scoresheet origins, for example `https://qbsheet.com` plus
  development origins.
- Echo the one approved origin in `Access-Control-Allow-Origin`, and send `Vary: Origin`.
- Never send `Access-Control-Allow-Origin: *` on an authenticated endpoint. A wildcard on a
  capability-token API lets any page on the internet drive a tournament from the browser of a
  scorekeeper.
- Answer the preflight `OPTIONS` request for every QBTCP path, and allow the credential headers above.
- Reject a preflight from an origin outside the allowlist with `403`.

Chrome implements Private Network Access, also called Local Network Access. A server on a private
address MUST answer a preflight that carries `Access-Control-Request-Private-Network: true` with
`Access-Control-Allow-Private-Network: true`. That server MUST also list
`Access-Control-Request-Private-Network` among its allowed headers. Without these two responses, a
scoresheet on a public origin cannot reach a local network server in current Chrome.

A client that installs a service worker MUST NOT let that worker cache a QBTCP response as
authoritative data. A cached assignment or a cached result acknowledgement is worse than an error,
because the client then holds a wrong answer and treats it as correct.

## Security model

1. **Capability tokens, not identities.** A token names what the holder can do, not who the holder is.
   There is no account to compromise.
2. **Least scope.** A room token cannot read another room. A session token cannot read another
   session. Neither token can read the tournament.
3. **Credentials never enter QBJ.** No token, pairing code, device identifier, operator name, server
   URL, or `Authorization` header value appears in any QBJ document that QBTCP produces or consumes.
   This rule is absolute. The file formats travel by memory stick and by email, and a capability that
   travels with them reaches a place that nobody intended.
4. **Credentials never enter a log or the user interface.** This includes error text.
5. **Uniform pairing failure.** See "Pairing".
6. **An origin allowlist, never a wildcard.** See "CORS and local network access".
7. **Bounded input.** Servers MUST bound the request body size and the URL length. Servers MUST
   validate all received JSON as untrusted: finite numbers, well-formed shapes, and no
   prototype-pollution keys.

## Ownership of each concern

| Concern | Owner |
| --- | --- |
| What a match, team, player, round, or scoring rule is | QBJ |
| What the result of a game was | QBJ |
| Which game a room must score now | QBTCP, which delivers a QBJ document |
| Whether the room can score it, and which device writes | QBTCP |
| How a result returns, and whether it is a duplicate | QBTCP |

A change to this specification that needs a field describing the game belongs in QBJ, or in the
documented `_qbtcp` extension. It does not belong in the protocol.

## Legacy `/api/v1` compatibility

Version 1 of this protocol was deployed on an `/api/v1` surface, whose name did not carry a version of
the protocol itself. Tournament-control implementations that migrate to QBTCP SHOULD retain their
existing `/api/v1` routes as **aliases that dispatch to the identical handler**. Deployed scoresheets
then keep working. An alias holds no duplicated logic and no behaviour of its own. Every alias is
deprecated from its introduction. A new scoresheet MUST use the canonical `/qbtcp/v1`
paths.

[`QBG_MIGRATION.md`](QBG_MIGRATION.md) holds the route mapping for the reference implementation.
