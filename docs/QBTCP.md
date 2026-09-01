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
- The assignment lifecycle and its revisions

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
| **Round revision** | An integer that increases monotonically for a round's pairing publication. It identifies which issue of a round's pairings an assignment came from. |
| **Assignment revision** | An integer scoped to one room. It increases whenever that room is issued or reissued an assignment, including the same pairing after a room-local retry. |
| **Result receipt** | The durable acknowledgement of an authenticated final. A receipt says what control retained; it does not by itself say that the result was imported into standings. |
| **Review-required** | A retained result state that needs an explicit director decision before it becomes the tournament's canonical match. |
| **Abandoned session** | A session explicitly closed by tournament control without deleting its progress or results. A later final is retained for review and never reopens the session. |
| **Active writer** | The one device that holds authorisation to write to a session. |

## Versioning

The protocol version is a single integer in the path: `/qbtcp/v1/...`.

Increment the integer only for a change that a version-1 client cannot tolerate. A new optional
response field, a new optional request field, and a new capability are not such changes. A client MUST
ignore a response field that it does not recognise, rather than fail on it.

Version negotiation is discovery, not a handshake. A client fetches the discovery document, reads
`version` and `capabilities`, and then decides what it can do. There is no in-band upgrade.

A client that recognizes `protocol: "QBTCP"` but a version greater than the newest version it
implements MUST stop using the QBTCP routes and MUST tell the operator that this is an unsupported
future QBTCP server. It MUST NOT guess that the server is a legacy `/api/v1` server. An absent,
unreadable, or `404` discovery response is the separate legacy-compatibility case.

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
model", which states the single narrow exception: the short pairing code, and only in the fragment of
a pairing launch URL.

## Pairing

    POST /qbtcp/v1/pair
    { "code": "48213906", "roomId": "room-204" }

This endpoint exchanges a short code that a person typed for a room token. `roomId` is optional, and
it disambiguates a code that is not globally unique.

    { "roomId": "room-204", "roomName": "Room 204", "token": "<opaque room token>" }

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

## Pairing launch links and QR codes

A scorekeeper pairing a room by hand copies two things off a projector: an address and a short code.
This section defines an **optional** convention for delivering both in one string, so that the same
pairing can start from a QR code on a screen or a link in a message.

It is a bootstrap convenience and nothing more. It does not replace `POST /qbtcp/v1/pair`, it defines
no endpoint, and it creates no authentication mechanism. Everything it carries is spent on the
pairing endpoint above, under the rules above.

### Format

A launch link is a URL whose **fragment** carries the launch parameters:

    <scoresheet>#qbtcp-pair?v=1&server=<url-encoded base URL>&code=<pairing code>&room=<room id>

`<scoresheet>` is the address of a scoresheet application. Which one, and at which origin and base
path, is a matter of configuration and deployment, not of this protocol. A tournament-control
implementation SHOULD make it configurable, because a venue may run a self-hosted copy.

| Parameter | Required | Meaning |
| --- | --- | --- |
| `v` | Yes | Launch format version. This document defines `1`. |
| `server` | Yes | The base URL of tournament control, percent-encoded. `http` or `https` only. |
| `code` | Yes | The short pairing code, exactly as `POST /qbtcp/v1/pair` expects it. |
| `room` | No | A room identifier, used as the `roomId` of the pair request. |

`v` is the version of *this launch convention*. It is not the protocol version in the path, and a
change to it is not a change to QBTCP. A receiving scoresheet MUST accept only a version it
implements, and MUST fail safely on any other — the launch format is small enough that a future
version may reasonably carry a parameter whose meaning cannot be guessed, so partial understanding is
not permitted. Within a supported version, an unrecognised parameter MUST be ignored, as everywhere
else in this specification, and MUST NOT be treated as conferring authority.

A complete example, for a scoresheet deployed at `https://qbsheet.com/`:

    https://qbsheet.com/#qbtcp-pair?v=1&server=http%3A%2F%2F192.168.1.24%3A3000&code=48213906&room=room-204

### One string, two ways of delivering it

A QR code offered for this purpose MUST encode exactly this URL. It MUST NOT encode a private payload
of its own. The point is that the QR code a director puts on a projector and the link they paste into
a message are the same string, read by the same parser on the receiving side; a separate QR payload
format would be a second thing to specify, a second thing to validate, and a second thing to get
wrong.

Tournament control needs nothing beyond this section to offer both. Given a room's pairing code, it
can render a QR code for the URL above and can offer a "copy link" action that produces the identical
string.

### The fragment is not optional

Launch data MUST be in the URL fragment. It MUST NOT be in the query string and MUST NOT be in the
path.

A fragment is not sent to an HTTP server. A scoresheet is typically a static site served by a general
web server or a CDN that its operators do not control, and a pairing code in a query string is written
into that server's access log, into its analytics, and into the `Referer` header of the next request —
all before the scoresheet has run a line of its own code. Everything else in this section depends on
the fragment property.

### Obligations of a receiving scoresheet

A scoresheet that implements this convention MUST do all of the following.

- **Consume and remove it immediately.** The fragment MUST be read and the URL replaced in place —
  without a reload and without a new history entry — as the first thing the application does, before
  it installs error handling, renders, or performs any other startup work. It MUST NOT wait for a
  render or an effect.
- **Scrub what it refuses.** A URL carrying the recognised fragment MUST be scrubbed even when the
  launch data is malformed or its version is unsupported. Refusal is not a reason to leave a possibly
  live code in an address bar.
- **Say nothing about the code.** An error arising from a launch link MUST NOT quote the code or the
  raw fragment.
- **Not persist, log, diagnose, export, or render the code.** It MUST NOT be written to any local
  store, any diagnostics bundle, any connection history, any error record, any QBJ document, or any
  part of the interface.
- **Require an explicit user action.** A scoresheet MUST NOT contact tournament control merely because
  a launch link was opened or a QR code was decoded. It MUST wait for a deliberate action. A browser
  gates access to a local network behind a permission granted in response to a user gesture, and a
  page that probed on load would be refused in a way the person using it never saw.
- **Exchange it normally.** The code MUST be spent through `POST /qbtcp/v1/pair`, with `roomId` set
  from `room` when present. The server remains authoritative for the room it actually paired.
- **Then behave exactly as any other pairing.** Once the exchange succeeds, the room token is subject
  to the ordinary persistence and lifetime rules, and nothing distinguishes the resulting pairing from
  one that began with a typed code.
- **Discard the code once spent.** A launch code MUST NOT be retained after the exchange, successful or
  not.

A scoresheet SHOULD also refuse a launch link that would replace a pairing an unfinished local game
still depends on. Nothing in a link makes it more authoritative than the game in front of the person
holding the device.

### Validation

The entire payload is untrusted. A receiving scoresheet MUST validate at least the fragment
namespace, the exact launch version, the presence and shape of `server` and `code`, the URL scheme,
bounded field lengths, and well-formed percent-encoding, and MUST refuse a payload with a duplicated
parameter rather than choose between two values.

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
  "session": { "session_id": "...", "status": "open", "resumable": true },
  "previous": { "label": "Round 3 · Ninety Six vs Emerald" },
  "next": { "label": "Round 5 · Clinton vs Greenwood" },
  "round_revision": 3,
  "assignment_revision": 7,
  "released_round": 4,
  "hold_new_starts": false
}
```

`state` is one of `assigned`, `none`, `blocked`, or `held`. When `state` is not `assigned`, the
assignment endpoint returns `204 No Content`. It does not return an empty QBJ document. A pending
result review is not a room-level hold: the assignment for another game MAY be issued while the
earlier result remains in the review queue, but the specific pairing represented by that result
remains locked until its decision is recorded.

Operational state is not part of the game, so it is not in the QBJ body. It travels in response
headers or in this sibling endpoint. The assignment document MAY repeat `round_revision` and
`assignment_revision` in `_qbtcp` so a result can carry the issue that was actually scored; the
status endpoint remains authoritative for the current room state.

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

The client MAY include bounded diagnostic metadata in the presence body or headers:

```json
{
  "client": { "name": "QBSheet", "version": "4.2.0", "build": "20260831" },
  "procedure_versions": [1, 2, 3],
  "qbj_version": "2.1.1"
}
```

This metadata is advisory and MUST NOT be used for authentication. Servers MUST bound and sanitize
it before persisting or displaying it.

Presence is advisory. A lost heartbeat MUST NOT end a session, invalidate a token, or affect the
scoring.

## Writer ownership and takeover

One session has one writer. The device that holds writer status can write snapshots and the final
result. Another device with the same session token can read, and the server refuses its write with
`409`:

    { "error": "Another device is scoring this game.", "writer_device": "…", "can_take_over": true }

A takeover is explicit, and a person starts it:

    POST /qbtcp/v1/sessions/{id}/writer  (session token)
    { "device_id": "...", "take_over": true }

The server transfers writer status. The previous writer learns of the loss at its next write, and it
MUST surface that loss rather than discard the work of the scorekeeper.

A client MUST NOT take over automatically after a failed write. Automatic takeover between two live
devices leaves both of them with the belief that they are authoritative.

## Progress

    PUT /qbtcp/v1/sessions/{id}/progress   (session token, writer)

The request body is a progress envelope with content type:

    application/json

Its `match` member is the current game state as a QBJ `Match` document. Its `sequence` member is
transport metadata and is not part of the QBJ `Match`:

    { "sequence": 41, "match": { ... } }

Progress is a **snapshot**, not a delta. Each write replaces the last one. A client that was offline
sends its current state, and it does not replay what it missed.

Snapshots are therefore idempotent, and a client can coalesce them freely. A client SHOULD collapse a
queue of snapshots to the newest one. A client MUST NOT let a stale queued snapshot overwrite a newer
accepted one. Servers SHOULD accept an out-of-order arrival by preference for the higher sequence.

`sequence` is an integer that the client assigns. It increases monotonically inside one session. A
server that receives a sequence lower than the one it holds MUST discard that snapshot and respond
`200`. The client is late rather than wrong, and an error response would cause a pointless retry.

Progress delivery is best-effort. A failed snapshot MUST NOT block the scoring, surface as a scoring
error, or discard local state.

## Result and receipt semantics

    POST /qbtcp/v1/sessions/{id}/result   (session token, writer)

The body is the completed game as a QBJ document, with content type
`application/vnd.quizbowl.qbj+json`. It is the same document that the scoresheet would download as
`*.result.qbj`, with nothing added and nothing removed.

    {
      "accepted": true,
      "received": true,
      "review_required": false,
      "duplicate": false,
      "match_id": "sm-4471",
      "fingerprint": "…",
      "warnings": []
    }

`received: true` means the authenticated final was durably retained. `accepted` is retained for
backwards compatibility and means that control can proceed without a director decision; a client
MUST accept either field when reading an older receipt. `review_required: true` means the bytes are
safe on disk but a person must decide what they mean. `duplicate: true` means the same result was
already retained or imported and is the correct idempotent answer to a retry. A receipt SHOULD include
`match_id`, `fingerprint`, and a bounded array of stable warning codes and human-readable warning
details when available.

An authenticated, parseable final MUST be retained before the HTTP response is written, even when
its team mapping, round revision, assignment revision, or other content disagrees with the current
assignment. Such a disagreement is a review warning, not a transport failure. The server MUST return
a successful receipt for a retained nonfatal final; it MUST NOT make a room retry a result that is
already durably stored. If the body is malformed or unreadable, the server MAY retain a sanitized
quarantine record for audit and support, but MUST NOT claim that it was a usable result; the response
must identify the parse failure without echoing secrets or the original body.

Identity and deduplication are ordered as follows:

1. The tournament identifier scopes the comparison.
2. When a match identity is present, compare that identity first. The same match identity and the
   same fingerprint is a duplicate; the same match identity and a different fingerprint is a
   correction candidate and MUST be retained for review.
3. Two different match identities are not duplicates merely because their statistics are identical.
4. When identity is absent, the server MAY use a conservative fingerprint fallback, but it MUST NOT
   merge an ambiguous result automatically. A retry key supplied by a client MAY make a transport
   retry idempotent, but it is not a replacement for the result identity.

Every retained result is an audit record. A correction workflow MUST offer explicit `Replace`, `Keep`
(the existing canonical result), and `Dismiss` decisions, with an optional separate manual-import
decision. Replacing or keeping one result MUST preserve both records and their relationship (for
example `supersedes_result_id`, `superseded_by_result_id`, or an equivalent stable link). A server
MUST NOT silently overwrite, skip, or delete either copy.

Result submission MUST use the pair of `Tournament.id` and `Match.id` as the preferred game identity,
together with the statistical fingerprint. The tournament identifier scopes the match identifier,
so identical `Match.id` values in different tournaments MUST NOT collide. The fingerprint distinguishes
an identical retry from a conflicting result for the same game. A client that retries after a timeout
must not create a second match. See "Result identity and deduplication" in the profile document.

A scoresheet MUST NOT treat acceptance over QBTCP as a reason to delete its local copy, or as a reason
to stop offering the result for manual download.

## Recovery

    GET /qbtcp/v1/sessions/{id}/recovery   (session token)

This is the second recovery source. It serves a device whose own local copy is absent or unreadable.
It returns the private state that the server received. The same session capability authorises it as
every other operation on that session. There is no room-wide read and no server-wide read.

Recovery MUST include the session lifecycle (`open`, `final-received`, or `abandoned`) and MUST
include any canonical live-roster amendments applied while the session was open. A replacement
device applies those amendments by canonical player identity, not by display-name guessing. A result
received after `abandoned` remains an audit/review record marked as `late-after-abandon`; it MUST NOT
auto-import or reopen the session.

Tournament control SHOULD expose an explicit abandon action. Abandoning revokes the session's writer
authority, preserves progress and receipts, releases the room for a new assignment, and records who
or what performed the action. It is not equivalent to deleting a session.

Server-assisted recovery is a fallback. The local journal of a scoresheet is the authoritative exact
recovery path. The profile document describes both paths together.

## Help requests

    GET    /qbtcp/v1/help                (room token)
    POST   /qbtcp/v1/help                (room token)
    DELETE /qbtcp/v1/help/{id}           (room token)

A room asks for a person: a protest to adjudicate, an absent player, a broken buzzer, or another
short operational problem. `help` in discovery is the authoritative capability. The request body is
small and contains only the existing category vocabulary and an optional free-text message:

```json
{ "category": "question-packet", "message": "The packet does not match this round." }
```

The server returns the same envelope for all three endpoints:

```json
{
  "request": {
    "id": "help-…",
    "roomId": "room-204",
    "roomName": "Room 204",
    "category": "question-packet",
    "message": "The packet does not match this round.",
    "status": "open",
    "createdAt": "2026-08-11T14:42:00.000Z",
    "updatedAt": "2026-08-11T14:42:00.000Z",
    "deviceId": "…",
    "operatorName": "…",
    "currentMatchup": { "roundNumber": 4, "roundName": "Round 4", "leftTeam": "Ninety Six", "rightTeam": "Greenwood" }
  }
}
```

`GET` returns `{ "request": null }` when this room/device has no open request. `POST` creates an
open request and returns it. If that same room/device already has an open request, the server returns
the existing request instead of creating a second active summons. The response includes server
timestamps when available; they are not a chat timestamp or an acknowledgement from staff.

`DELETE /qbtcp/v1/help/{id}` withdraws the explicitly selected open request for its owning room/device
and returns the updated request with `status: "cancelled"`. A request that tournament control marks
`resolved` is likewise absent from a later room-scoped `GET`; the room does not claim that it was
resolved because this endpoint does not provide a room-facing resolution workflow. A missing request
on `DELETE` is a harmless race with resolution and can be treated as no request outstanding.

Help is orthogonal to scoring. It MUST NOT affect the state of a session.

This is a room-level operational signal, not a ticket queue or chat. A scoresheet may retain many
local issue and protest events, while the server keeps at most one active summons for a room/device.
The free-text message is delivered only because the scorekeeper explicitly asked for help; it is not
part of connection diagnostics or progress snapshots.

## Errors and status semantics

An error response is JSON with an `error` string that is safe for a person to read. A client MAY
display that string without a change.

```json
{ "error": "This browser origin is not approved.", "code": "origin_not_allowed" }
```

| Status | Meaning | Client obligation |
| --- | --- | --- |
| `400` | Malformed request | Do not retry unchanged |
| `401` | Missing or invalid credential | For a room-token failure, pair again. For a session-token failure, reopen or resume the existing session. In both cases, keep the in-progress game and continue local scoring. |
| `403` | Valid credential without permission, including a disallowed origin | Surface it. Do not retry in a loop. |
| `404` | No such endpoint, session, or room | Do not retry |
| `405` | Method not allowed | A programming error |
| `409` | Writer conflict, or a malformed/authentication-level refusal that was not retained | Surface it; do not retry unchanged |
| `410` | A newer revision superseded the assignment | Fetch the new assignment. Do not discard scored work. |
| `413` | Body too large | Do not retry unchanged |
| `429` | Rate limited at pairing | Back off |
| `5xx` | Server fault | Retry with a backoff |

`401` and `410` need the most care. Each one describes a server that changed its mind about a room in
the middle of a game. Neither status permits the destruction of that game. A scoresheet MUST continue
to score locally, and MUST keep the result available for download. A result-content mismatch is not
automatically a `409`: if the authenticated final was retained, the receipt is the successful answer
and the warning/review state is what tells control to act.

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
- The operator has an explicit offline/emergency path: export the assignment, continue scoring locally,
  and import or hand off the final later without depending on a live server.

For help requests, a client classifies a `401` as a room-credential problem for the existing room
repair flow, a `403` as an explicit refusal without starting a pairing loop, a network failure as
unreachable, and a `5xx` as a retryable server failure. None of these outcomes removes a locally
recorded issue or stops scoring.

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
5. **One narrow exception, for bootstrap only.** A short pairing code MAY exist transiently in the
   **fragment** of a QBTCP pairing launch URL, solely to bootstrap the pairing exchange, and only if
   the receiving scoresheet consumes it before its normal startup, immediately replaces the URL to
   remove it, never renders it, and never persists, logs, diagnoses, or exports it. See "Pairing
   launch links and QR codes".

   The exception is deliberately confined to the pairing code, which is short-lived, single-purpose,
   rate-limited, and buys nothing but a room token from an endpoint that refuses to say why it failed.
   It does **not** extend to a room token, a session token, a session identifier, a device identifier,
   assignment data, result data, or any QBJ document. None of those may appear in a URL in any form.

   A fragment is used because a fragment is not sent to the HTTP server as part of the request. That
   property, plus immediate removal, is the whole of what makes the exception acceptable; a query
   string would put the code in somebody else's access log before the scoresheet ran.
6. **Uniform pairing failure.** See "Pairing".
7. **An origin allowlist, never a wildcard.** See "CORS and local network access".
8. **Bounded input.** Servers MUST bound the request body size and the URL length. Servers MUST
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

The legacy aliases for the help lifecycle are:

    GET    /api/v1/rooms/{roomId}/help
    POST   /api/v1/rooms/{roomId}/help
    DELETE /api/v1/rooms/{roomId}/help/{helpId}

They use the same request and response bodies and dispatch to the same server behavior. A client
that never receives QBTCP discovery may continue using them; a QBTCP client uses the canonical paths.
If an older pre-QBTCP server exposes only `POST /help`, the client keeps that request action
available but reports lifecycle reads and withdrawal as unavailable; it does not hide a request that
may still be open on that server.

## Cross-repository contract harness

QBSheet includes a browser contract test against YellowFruit's real QBTCP server. It is enabled when
the YellowFruit checkout is available at the sibling path used by the development workspace, or when
`YELLOWFRUIT_REPO` points to another checkout. `YELLOWFRUIT_REF` is optional and only verifies the
checkout's current `HEAD`; the harness never changes a branch or working tree.

```sh
YELLOWFRUIT_REPO=/path/to/yellowfruit-link \
YELLOWFRUIT_REF=main \
npm run test:browser:yellowfruit
```

The test starts YellowFruit on a temporary loopback port with temporary QBTCP state, drives the real
QBSheet page through pairing, scoring, progress, and final submission, then resolves the durable
result review explicitly. If no YellowFruit checkout is present, this optional test is skipped and the
QBSheet-only QBTCP browser contract suite remains available through `npm run test:browser`.
