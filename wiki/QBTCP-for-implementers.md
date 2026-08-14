# QBTCP for implementers

QBTCP is the Quiz Bowl Tournament Control Protocol. It is an application-layer protocol over HTTP
with JSON bodies. It connects an electronic scoresheet to tournament control software.

This page is a guide. The normative document is
[`docs/QBTCP.md`](https://github.com/gbyo/qbsheet/blob/main/docs/QBTCP.md). That document keeps the
RFC key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY. Implement from that document, not from
this page.

## What QBTCP is not

QBTCP is not a transport protocol. It does not replace TCP/IP and it does not sit under TCP/IP. The
name says what the protocol controls, which is a quiz bowl tournament. QBTCP runs over ordinary
HTTP. An implementation opens no socket of its own. It defines no framing, no retransmission, and no
congestion control.

QBTCP is also not the API of one product. QBSheet is one scoresheet. Fruity is one tournament
control implementation. Neither owns the protocol. You can implement QBTCP without a read of either
codebase.

## The one rule that sets the boundary

    QBJ is the game data and the tournament data.
    QBTCP is the live conversation around that data.

QBTCP owns behaviour that exists only while a tournament runs:

- Discovery and version negotiation
- Room pairing and authentication
- Delivery of the current assignment
- Presence
- Writer ownership and takeover
- In-progress snapshots
- Final result delivery
- Reconnection and server-assisted recovery
- Help requests
- The assignment lifecycle and the revision of a round

QBTCP defines none of these:

- `Tournament`, `Phase`, `Round`, `Registration`, `Team`, `Player`
- `Match`, `MatchTeam`, `MatchPlayer`, `MatchQuestion`
- `ScoringRules`
- Any result statistic

Those belong to QBJ. When QBTCP must carry one of them, it carries a QBJ document and says so. A
parallel team schema or a parallel match schema misreads the specification.

## Terms

| Term | Meaning |
| --- | --- |
| Tournament control | The software that owns the schedule and collects the results |
| Scoresheet | The client that scores one game at a time |
| Room | A scoring position in the tournament. The room pairs and authenticates. |
| Session | The work of one scoresheet on one assigned game |
| Assignment | The game that a room must score now, as a QBJ document |
| Round revision | An integer that names which issue of a round's pairings an assignment came from |
| Active writer | The one device that can write to a session now |

## Version

The version is one integer in the path: `/qbtcp/v1/...`.

Raise the integer only for a change that a version-1 client cannot tolerate. A new optional response
field, a new optional request field, and a new capability are not such changes. A client must ignore
a response field that it does not know.

Version negotiation is discovery, not a handshake. A client reads the discovery document, then
decides what it can do. There is no upgrade inside the connection.

## Discovery

    GET /qbtcp/v1

No credential. The response looks like this:

```json
{
  "protocol": "QBTCP",
  "version": 1,
  "capabilities": ["pairing", "assignment", "progress", "result", "recovery", "help", "presence"],
  "qbj_version": "2.1.1",
  "name": "Greenwood Fall Invitational"
}
```

`capabilities` is the authoritative statement of server support. A client must not read support from
the absence of an error. A client must not need a capability that discovery did not advertise.

Discovery must not reveal the schedule, the room list, the team list, or any pairing code.

## Authentication

QBTCP uses capability tokens. A token is an opaque string. It grants exactly one scope. There are two
scopes.

| Token | Scope | Header |
| --- | --- | --- |
| A room token | One room: read the assignment, post presence and help, open a session | `x-yf-room-token` |
| A session token | One session: read it, write snapshots, submit the result, read recovery | `x-yf-session-token` |

There is no user account, no password, and no server-wide read. A session token reaches one session.
A change to the identifier in the path does not reach the game of another room.

Two more headers give information only. They never authorise anything.

| Header | Meaning |
| --- | --- |
| `x-yf-device-id` | An opaque per-browser identity, used to arbitrate the writer role |
| `x-yf-operator-name` | The name of the scorekeeper, for the presence view of the director |

The `x-yf-` prefix comes from the implementation that existed before the protocol had a name. It is
historical. It is not a claim of ownership. Treat every header name as an opaque string. Do not
rename a wire field for tidiness, because a deployed client reads it.

Send every credential as a header. A credential must never appear in a URL, in a query string, in a
log line, in the user interface, in an error message, or in a QBJ document.

## Pairing

    POST /qbtcp/v1/pair
    { "code": "48213906", "roomId": "room-204" }

This endpoint exchanges a short human code for a room token. `roomId` is optional. It only
disambiguates a code that is not unique.

```json
{ "roomId": "room-204", "roomName": "Room 204", "token": "<opaque room token>" }
```

Pairing turns a memorable secret into a capability, so it is the endpoint that an attacker will
choose. A server must do these three things:

1. Rate-limit attempts per source, then answer `429`.
2. Return an identical failure for a malformed code, an unknown code, a disabled room, and a
   mismatch. A distinguishable error lets a stranger enumerate the rooms.
3. Keep the code out of every response and every log.

A server can also offer a room list for a picker:

    GET /qbtcp/v1/rooms

The list gives identifiers, display names, and descriptions only. It must not give a token or a
pairing code.

## Assignment

    GET /qbtcp/v1/assignment            (a room token)

**The response body is a QBJ document,** with the media type
`application/vnd.quizbowl.qbj+json`.

This is the central commitment of version 1. The assignment over the network is the same document
that tournament control software could write to disk. One parser on the client reads both. There is
no separate network model and no separate file model.

Operational state is not in the QBJ body, because that would need invented QBJ fields. It travels in
a sibling endpoint:

    GET /qbtcp/v1/assignment/status     (a room token)

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

`state` is `assigned`, `none`, `blocked`, or `held`. When the state is not `assigned`, the assignment
endpoint answers `204 No Content`. It does not answer with an empty QBJ document.

## Sessions

    POST /qbtcp/v1/sessions             (a room token)
    { "match_id": "sm-4471", "device_id": "..." }

```json
{ "session_id": "sess-9f13", "token": "<opaque session token>", "writer": true }
```

When a session for that assignment is already open, the server returns the open one. It does not
create a second one. Two devices on one game happens in a real tournament: a Chromebook dies and a
phone takes over. Writer ownership resolves it. A refusal does not.

## Presence

    GET  /qbtcp/v1/presence             (a room token)
    POST /qbtcp/v1/presence             (a room token)

`POST` records that this device and this operator are alive. `GET` returns what the server believes
about the room.

Presence is advisory. A lost heartbeat must not end a session, invalidate a token, or change the
scoring.

## Writer ownership

One session has one writer. Another device with the same session token can read. A write from that
device receives `409`:

```json
{ "error": "Another device is scoring this game.", "writer_device": "…", "can_take_over": true }
```

A takeover is explicit and a person starts it:

    POST /qbtcp/v1/sessions/{id}/writer  (a session token)
    { "device_id": "...", "take_over": true }

The server moves the writer role. The old writer learns of the loss at its next write, and it must
tell its operator. It must not discard the work.

A client must not take over automatically after a failed write. Automatic takeover between two live
devices makes both of them believe that they are authoritative.

## Progress

    PUT /qbtcp/v1/sessions/{id}/progress   (a session token, the writer)

The body is the current game state as a QBJ match document.

Progress is a snapshot, not a delta. Each write replaces the last one. A client that was offline
sends its current state. It does not replay what it missed.

    { "sequence": 41, "match": { ... } }

`sequence` is a client-assigned integer that only rises inside one session. A server that receives a
lower sequence than the one it holds must discard the body and answer `200`. The client is late, not
wrong, and an error would only cause a pointless retry.

A client must collapse a queue of snapshots to the newest one. A stale queued snapshot must never
overwrite a newer accepted one.

Delivery is best-effort by design. A failed snapshot must not block the scoring, must not appear as a
scoring error, and must not discard local state.

## Result

    POST /qbtcp/v1/sessions/{id}/result   (a session token, the writer)

The body is the completed game as a QBJ document, with the same media type. It is the same document
that the scoresheet would download, with nothing added and nothing removed.

```json
{ "accepted": true, "match_id": "sm-4471", "fingerprint": "…", "duplicate": false }
```

`duplicate: true` means that this exact statistical result is already on record. It is the correct
answer to a retry. It is not an error. Result submission must be idempotent on the pair of `Match.id`
and the fingerprint.

Acceptance is not permission for the scoresheet to delete its local copy. It is also not permission
to stop the manual download.

## Recovery

    GET /qbtcp/v1/sessions/{id}/recovery   (a session token)

This is the second recovery source. It serves a device whose own local copy is gone or unreadable. It
returns the private state that the server received. The session capability authorises the read.
There is no room-wide read and no server-wide read.

Server recovery is a fallback. The local journal of the scoresheet is the authoritative exact path.

## Help requests

    GET    /qbtcp/v1/help                (a room token)
    POST   /qbtcp/v1/help                (a room token)
    DELETE /qbtcp/v1/help/{id}           (a room token)

A room asks for a person: a protest to judge, an absent player, a broken buzzer. The categories are
implementation-defined and discovery advertises them.

Help is orthogonal to scoring. It must not change the state of a session.

## Errors

An error is JSON with a human-safe `error` string. A client can show that string as it is.

```json
{ "error": "This browser origin is not approved.", "code": "origin_not_allowed" }
```

| Status | Meaning | What the client must do |
| --- | --- | --- |
| `400` | A malformed request | Do not retry the same body |
| `401` | A missing or invalid credential | Pair again. Keep the game in progress. |
| `403` | A valid credential without permission, and a disallowed origin | Show it. Do not retry in a loop. |
| `404` | No such endpoint, session, or room | Do not retry |
| `405` | The method is not allowed | A programming error |
| `409` | A writer conflict, or a conflict with a recorded result | A person must resolve it |
| `410` | A newer revision superseded the assignment | Fetch the new assignment. Keep the scored work. |
| `413` | The body is too large | Do not retry the same body |
| `429` | Rate limited | Back off |
| `5xx` | A server fault | Retry with a backoff |

`401` and `410` matter most. Both describe a server that changed its mind about a room in the middle
of a game. Neither one can destroy that game. The scoresheet must continue to score locally. The
result must stay available for download.

## Durability rules for a scoresheet

A scoresheet can lose the network at any moment. It must not lose the game. An implementation that
claims conformance must hold to all of these:

- It writes the normalised assignment locally before any scoring depends on a later call.
- It makes a locally accepted scoring event durable before it delivers the event anywhere.
- A lost server never unmounts, blocks, or resets the scorer.
- `401`, `403`, and `410` do not destroy the game.
- A change of tournament identity does not destroy the game.
- A reload restores from local state, not from the network.
- Snapshots retry and coalesce. The current state always beats a stale queued one.
- A connected final still offers a manual QBJ download.

## CORS and the local network

A scoresheet is usually a static site on a public address. Tournament control software usually runs
on a laptop on the same local network. That is a cross-origin request to a private address, and both
halves need work.

A server must do all of these:

- Keep a configurable allowlist of scoresheet origins.
- Echo the one approved origin in `Access-Control-Allow-Origin`, and send `Vary: Origin`.
- Never send `Access-Control-Allow-Origin: *` on an authenticated endpoint. A wildcard on a
  capability-token API lets any page on the internet drive a tournament from the browser of a
  scorekeeper.
- Answer the preflight `OPTIONS` request for every path, and allow the credential headers.
- Reject a preflight from an origin outside the allowlist with `403`.

For Local Network Access in Chrome, a server on a private address must answer a preflight that
carries `Access-Control-Request-Private-Network: true` with
`Access-Control-Allow-Private-Network: true`. The server must also list
`Access-Control-Request-Private-Network` among its allowed headers. Without this, a scoresheet on a
public address cannot reach the server at all.

A client with a service worker must not cache a QBTCP response as authoritative data. A cached
assignment is worse than an error, because it is a confident wrong answer.

## The security model in seven lines

1. Capability tokens, not identities. A token says what it can do, not who holds it.
2. Least scope. A room token cannot read another room. A session token cannot read another session.
3. A credential never enters a QBJ document. Files travel by memory stick and by email.
4. A credential never enters a log or the user interface, and that includes error text.
5. A pairing failure looks the same for every cause.
6. An origin allowlist, never a wildcard.
7. Bounded input. Limit the body size and the URL length. Treat all received JSON as untrusted.

## Who owns what

| Concern | Owner |
| --- | --- |
| What a match, team, player, round, or scoring rule is | QBJ |
| What the result of a game was | QBJ |
| Which game a room must score now | QBTCP, which delivers a QBJ document |
| Whether the room can score it, and who writes | QBTCP |
| How a result returns, and whether it is a duplicate | QBTCP |

If a change needs a field that describes the game, that field belongs in QBJ or in the `_qbtcp`
extension. It does not belong in the protocol.

## Related pages

- [Files and formats](Files-and-formats)
- [Move from QBG and api-v1](Move-from-QBG-and-api-v1)
- [Develop and contribute](Develop-and-contribute)
