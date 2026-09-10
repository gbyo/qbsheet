# QBTCP realtime/relay extension (stream capability)

**Version 1, QBTCP v1 capability.** This document is normative for the optional `stream`
capability. It extends [`QBTCP.md`](QBTCP.md) without changing it: every rule there still
holds, and a server or client that never implements this document stays a conformant v1
implementation. Nothing here names a relay vendor. A relay built on any infrastructure that
honors this contract interoperates with any scorer that does.

This document uses MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY in their ordinary
specification sense.

## Why this exists

Base QBTCP is HTTP/JSON with client-side polling: the scorer asks for assignment status
roughly every 10 seconds and offers progress snapshots on its own cadence. That is right
for a LAN server and wrong as an Internet-primary transport, where per-request metering
makes polling the budget rather than the scoring. The stream carries the same QBTCP
conversation — the same rooms, sessions, assignments, receipts, and help lifecycle — over
one long-lived WebSocket, with the server pushing what the client used to poll for.

## Discovery

A server offers the stream by advertising the `stream` capability **and** a `stream`
descriptor in its discovery document:

```json
{
  "protocol": "QBTCP",
  "version": 1,
  "capabilities": ["pairing", "assignment", "progress", "result", "recovery", "help", "presence", "stream"],
  "qbj_version": "2.1.1",
  "name": "Greenwood Fall Invitational",
  "stream": {
    "endpoint": "/qbtcp/v1/stream",
    "frames": 1,
    "retains_finals": true,
    "mirrors_assignment": true,
    "replay": ["sequence", "resync"],
    "max_frame_bytes": 1048576
  }
}
```

The descriptor answers, in order:

- `endpoint`: where the stream lives. A relative path only, joined to the same base URL
  as the HTTP routes. An absolute URL is refused rather than followed.
- `frames`: the frame envelope version. `1` is the only value defined here.
- `retains_finals`: whether this relay durably retains finals while Director is
  disconnected. A Director's own stream MAY advertise `false`; a relay MUST advertise
  `true` to call itself a durable relay.
- `mirrors_assignment`: whether the relay mirrors Director-published assignment and
  session state. A relay MUST advertise `true`.
- `replay`: the reconnect features offered, a subset of `sequence` (resume from a server
  sequence cursor) and `resync` (explicit resync-required signalling). Every entry MUST be
  one of those two strings: a descriptor whose `replay` list contains an unknown or
  non-string entry is malformed and unusable as a whole — the client MUST fall back to HTTP
  rather than filter the list — so both implementations make the same stream-capable
  decision for the same discovery document.
- `max_frame_bytes`: the bound on one decoded frame. A client MUST NOT send larger
  frames; a server MUST reject them before reading them.
- `ticket` (optional, default `false`): whether the server additionally offers the
  narrow pre-auth ticket exchange described under Authentication.

A client MUST NOT infer stream support from a URL convention, a port, a hostname, or any
other out-of-band signal. Capability plus descriptor, or no stream.

The descriptor MUST NOT contain a token, a pairing code, a session identifier, or any
other credential-shaped value. A descriptor that does is rejected outright, not repaired.

## Frames

One envelope, versioned and bounded:

```json
{ "version": 1, "type": "assignment-changed", "sequence": 129, "session_id": "sess-9f13", "payload": {} }
```

- `version` is the envelope version and MUST be `1`. Any other value fails safely with an
  `unsupported-version` answer: the connection MAY be retried over HTTP, but the frame
  MUST NOT be interpreted.
- `type` names the frame. Unknown types MUST be ignored, never fatal — forward
  compatibility means a future server cannot break this client. There is deliberately no
  "required type" flag to negotiate around that rule.
- `sequence` is a non-negative integer cursor assigned by the sender for replay. Server
  sequences order server-to-scorer frames; they are transport metadata, not game data.
- `session_id`, when present, is the Director-issued session both transports share.
- `payload`, when present, MUST be an object. Unknown optional payload fields MUST be
  ignored, per the v1 compatibility rule.

Frames MUST NOT exceed the advertised bound. A malformed frame is an error the receiver
answers without mutating any session state: it MUST NOT corrupt, unmount, or reset the
game, and it MUST NOT be retried unchanged.

### Server → scorer

| Type                 | Meaning                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `hello`              | Current server identity and stream properties after authentication. Resets degradation.    |
| `assignment-changed` | The assignment or its status changed. The client refetches over HTTP; the push is a hint.  |
| `session-changed`    | Session lifecycle or writer information changed. Informational, never authority.           |
| `help-changed`       | The room's help request changed.                                                           |
| `resync-required`    | The client MUST refetch assignment/session state over HTTP; the stream is no longer whole. |
| `shutdown`           | Graceful degradation: `{ "reason": "..." }`. The client degrades, keeps scoring.           |
| `receipt`            | Durable receipt for a final submitted over the stream.                                     |
| `recovery`           | Recovery payload answering a `recover` frame. Same session capability as HTTP recovery.    |
| `error`              | A readable refusal for one scorer frame. Never carries credentials.                        |

### Scorer → server

| Type           | Meaning                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `authenticate` | The first frame on a new connection. Carries the room/session capability (see Authentication). |
| `progress`     | A coalesced current-state snapshot with its session sequence. Same semantics as HTTP progress. |
| `presence`     | Optional advisory heartbeat. Protocol ping/pong SHOULD be preferred where available.           |
| `help-open`    | Open a help request. Same categories and one-open-request rule as HTTP help.                   |
| `help-cancel`  | Withdraw the open request.                                                                     |
| `final`        | A completed game with a client retry key. Answered by exactly one `receipt`.                   |
| `recover`      | Ask for the session recovery payload over the stream.                                          |

Do not stream every scoring click. Progress remains a coalesced current-state snapshot:
each offer replaces the last, offers collapse to the newest, and a stale queued offer
MUST NOT overwrite a newer accepted one. Equal sequences keep the held snapshot.

## Authentication

Capability scopes are unchanged: a room token authorizes one room, a session token
authorizes one session, the active writer remains explicit, and device/operator metadata
never authorizes anything.

The WebSocket upgrade carries no credential:

- The client opens the descriptor endpoint with the `qbtcp.stream.v1` subprotocol, which
  names the framing and nothing else.
- The first frame MUST be `authenticate`, with the room/session token in its payload.
  The server MUST honor no other scorer frame before it, and MUST answer a failed
  authentication with the same uniform refusal as HTTP pairing: no oracle for room or
  session enumeration.
- Credentials MUST NOT appear in the URL, query string, fragment, subprotocol, or logs.
  The pairing-code fragment exception in `QBTCP.md` stays confined to pairing bootstrap
  and does not extend to the stream.

A server that cannot authenticate inside the connection (for example, an edge that
terminates WebSockets before application code runs) MAY offer the narrow ticket
exchange: `POST` the descriptor endpoint plus `/ticket` over HTTPS with the ordinary
capability headers, receive a single-use ticket with a TTL measured in seconds, and send
it as the `authenticate` payload. The ticket buys exactly one stream authentication and
confers no other authority. This is the only sanctioned alternative, and a server MUST
NOT weaken the capability model to avoid it.

## Reconnection

A stream disconnect MUST NOT destroy local game state. The scorer keeps scoring, keeps
its credentials, and keeps the result available for download throughout.

- **Backoff.** Reconnect with exponential backoff from 500 ms, doubling to a 30 s cap,
  with full jitter: `delay = uniform(0, min(500 * 2^attempt, 30000))`. Jitter is load
  bearing — a roomful of devices MUST NOT reconnect in lockstep.
- **Resume.** When the descriptor advertises `sequence`, the client offers its last
  server sequence on `authenticate` and the server replays what was missed. Otherwise,
  or after `resync-required`, or when a gap is detected, the client refetches
  assignment and session state over ordinary HTTP and converges to the current state.
  It MUST NOT replay the intermediate progress snapshots it did not send while away.
- **Session repair.** A refused session credential is repaired exactly as over HTTP:
  reopen the same session with the room capability the room still holds. Both surfaces
  return the open session rather than creating a second one.
- **Writer reconciliation.** Writer ownership is never transferred by a frame and never
  inferred from transport order. A person takes over explicitly, over either transport,
  and the previous writer learns of the loss at its next write.
- **Duplicate finals.** A final retried after a disconnect carries the same retry key
  and fingerprint. The server answers an identical retry with `duplicate: true` and
  retains exactly one result. A retry key makes a transport retry idempotent; it is not
  a replacement for result identity.

Stale or revoked credentials stop authorizing new writes but never delete the local
game. Presence MAY expire; sessions, results, and help requests MUST NOT.

## Relay versus Director authority

This is the most important section. A relay may durably receive data while Director is
absent, but Director remains the authority for tournament-changing decisions.

- A final can be **durably received** by the relay — `received: true` — while still
  requiring Director review and acceptance. `accepted_by_director` is false on every
  relay receipt; only Director sets it true, and only by importing the result into
  standings through the existing transport-independent ingest path.
- Help can be retained while Director is away and is reconciled on re-sync.
- Progress is latest-state and coalescible. The relay holds one snapshot per session.
- Presence can expire. Expiry MUST NOT end a session, invalidate a token, or affect
  scoring.
- Assignments are mirrored **only** from Director-published state. The relay MUST NOT
  generate a future assignment from tournament logic on its own.
- The relay MUST NOT accept or reject standings results on behalf of Director.
- Director absence degrades review and publication, never scoring: an already-loaded
  assignment remains playable, and a completed final remains locally durable, through
  internet loss, relay failure, Director restart, or quota exhaustion.

## Dual-path semantics: one logical room, session, and result

When a scorer can reach both the Internet relay and LAN Director QBTCP, the two paths
MUST NOT become two logical sessions or two active-writer authorities. The answers:

- **Director pre-registers room identities; the relay mirrors them.** Rooms pair once;
  the relay serves the Director-published room namespace, never a namespace of its own.
- **The relay shares the session namespace, not a parallel one.** Sessions opened on
  either transport carry the same Director-issued session identifier, so requests moving
  between transports converge on one session.
- **LAN learns a result reached the relay, and vice versa,** through Director re-sync:
  the relay retains every final durably, and Director ingests everything it missed on
  reconnect through the canonical ingest path, which deduplicates by (tournament,
  match, fingerprint) before anything reaches standings.
- **A final reaching both paths within milliseconds retains exactly one semantic
  result.** The first retained wins; the second is answered `duplicate: true`. Order of
  arrival decides nothing about correctness — identical bytes are identical results.
- **A stale transport cannot overwrite newer state.** Assignment adoption compares
  (round revision, assignment revision) with round winning first; progress adoption
  compares session sequences. A relay that has not yet seen Director's latest
  publication loses the comparison on both transports.
- **Writer authority is single per session across both transports,** and takeover stays
  an explicit human action wherever it is initiated.

Moving a request between transports MUST NOT change its idempotency: the client retry
key and the result fingerprint travel with the submission on either path.

## HTTP compatibility

The HTTP routes remain available for old clients, for servers without the capability,
for explicit repair and recovery, for LAN fallback, and for diagnostic and conformance
testing. Nothing in this document versions them.

While a stream is healthy, the client MUST NOT keep high-frequency assignment polling
running in parallel. A low-frequency reconciliation request (60 seconds) MAY remain;
its interval is the documented reason it may keep running — to catch a silently
dropped push — and it MUST be suspended or relaxed, not multiplied, while pushes arrive.

## Security

- No credentials in URLs, query strings, fragments (beyond the existing pairing
  bootstrap), subprotocols, logs, diagnostics, or QBJ documents.
- Bounded frames; malformed or unknown-version frames rejected safely; unknown
  optional fields ignored.
- Uniform authentication failures: no room or session enumeration oracle.
- Rate-limit stream setup and pairing; a ticket, where offered, is single-use and
  short-lived.
- A session token grants no tournament-wide authority; a room token grants no
  cross-room authority.
- The server MUST validate the browser `Origin` on the WebSocket upgrade under the
  same allowlist as HTTP CORS, and MUST NOT accept `*` on an authenticated endpoint.
- Threat model: a public Internet endpoint receiving requests from student-operated
  scoring devices. Treat every frame as untrusted input — bounded, validated, and
  sanitized — and treat a compromised scorer as confined to its own room and session.

## Transport-state transitions

The scorer holds one logical connection across both transports:

| State               | Meaning                                                       |
| ------------------- | ------------------------------------------------------------- |
| `http-only`         | HTTP QBTCP only. The default and the fallback.                |
| `stream-connecting` | A stream endpoint is advertised; the upgrade is in flight.    |
| `stream-live`       | Healthy stream. Assignment polling relaxes to reconciliation. |
| `stream-degraded`   | Stream open but gapped, resyncing, or draining. HTTP covers.  |
| `offline-local`     | Nothing answers. Scoring continues locally regardless.        |

| Event              | `http-only`         | `stream-connecting` | `stream-live`     | `stream-degraded`   | `offline-local`     |
| ------------------ | ------------------- | ------------------- | ----------------- | ------------------- | ------------------- |
| `stream-available` | `stream-connecting` | `stream-connecting` | `stream-live`     | `stream-connecting` | `stream-connecting` |
| `stream-open`      | `stream-live`       | `stream-live`       | `stream-live`     | `stream-live`       | `stream-live`       |
| `stream-gap`       | `http-only`         | `stream-connecting` | `stream-degraded` | `stream-degraded`   | `offline-local`     |
| `stream-closed`    | `http-only`         | `http-only`         | `http-only`       | `http-only`         | `offline-local`     |
| `http-ok`          | `http-only`         | `stream-connecting` | `stream-live`     | `stream-degraded`   | `http-only`         |
| `http-failed`      | `offline-local`     | `offline-local`     | `stream-live`     | `offline-local`     | `offline-local`     |
| `resync-required`  | `http-only`         | `stream-connecting` | `stream-degraded` | `stream-degraded`   | `offline-local`     |
| `shutdown`         | `http-only`         | `http-only`         | `stream-degraded` | `stream-degraded`   | `offline-local`     |

The table is executable: `nextTransportState` in `src/qbtcp/QbtcpStream.ts` implements
it exactly, and `selectAssignmentPollIntervalMs` relaxes assignment polling to the
60-second reconciliation interval only in `stream-live`.

## Conformance

- `tests/QbtcpStream.test.ts` — TypeScript conformance, including the transition table.
- `crates/qbtcp-server/tests/stream_contract.rs` — Rust conformance.
- `tests/fixtures/qbtcp-stream/` — canonical wire fixtures read by both suites.

Conformance is transport-neutral: no test here needs a relay implementation, Cloudflare
or otherwise. The relay backend (see #771) and the scorer transport (see #772) are
conformance _subjects_ of this contract, not parts of it.
