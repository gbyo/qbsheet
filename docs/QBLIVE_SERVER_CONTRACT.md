# QBLive v1 — hosting-neutral server contract

**Status:** normative for QBLive v1.
**Protocol:** [`QBLIVE.md`](QBLIVE.md) and [`packages/qblive-protocol`](../packages/qblive-protocol).
**Reference core:** [`crates/qblive-server`](../crates/qblive-server).
**Conformance:** [`packages/qblive-conformance`](../packages/qblive-conformance).

> QBLive is a protocol between Director's sanitized public projection and a
> compatible publication backend. Cloudflare Durable Objects, QBServer, and
> local-only Director are implementations with different deployment/capability
> profiles.

Do not describe the Cloudflare backend as the architecture itself. It is one
host among several.

---

## 1. Implementations

| Host                         | Code                                                                     | Storage                                 | Capabilities                       | Management API                        |
| ---------------------------- | ------------------------------------------------------------------------ | --------------------------------------- | ---------------------------------- | ------------------------------------- |
| Cloudflare reference backend | `apps/qblive-backend-cloudflare` (Worker + SQLite Durable Object)        | Durable Object SQLite                   | full: snapshot, events, stream     | yes, Bearer [REDACTED]                |
| QBServer (standalone native) | `crates/qblive-server` core + SQLite service (#778)                      | on-disk SQLite, migrated, transactional | full                               | yes, Bearer [REDACTED]                |
| Director local-only mode     | `apps/director/src-tauri/src/live_server.rs` over `crates/qblive-server` | Director process memory                 | local: snapshot, events, no stream | no — Director _is_ the management API |
| Static host                  | any file host                                                            | files                                   | basic: snapshot only               | no                                    |

All four are conforming QBLive servers at their advertised level. A client
MUST work against a Basic server and MUST NOT require `stream`.

The Rust core (`crates/qblive-server`) owns the hosting-neutral semantics:
publication-id validation, protocol version, bounds, section extraction,
replay calculations, storage trait, public/management route handlers, and
stream hello/resync/event frames. Hosts compose the routes they need; shared
code never forces local-only mode to expose management authority.

---

## 2. Public route contract

```
GET /qblive/v1/tournaments/{publicationId}/manifest
GET /qblive/v1/tournaments/{publicationId}/snapshot
GET /qblive/v1/tournaments/{publicationId}/events?after={revision}&limit={n}
GET /qblive/v1/tournaments/{publicationId}/stream        (WebSocket upgrade)
GET /health
```

All public routes are unauthenticated `GET` and CORS-enabled for `*`. They
MUST NOT accept a management credential; a server that honours one on a
public route is non-conforming. A `PUT`/`POST`/`DELETE` to a public route
MUST fail (>= 400); the reference backends answer `405`.

`{publicationId}` is 20 characters from `0123456789bcdfghjkmnpqrstvwxyz`,
validated before it becomes storage state. Forged ids (`../etc`, vowels,
wrong lengths) answer `404`, never `500`, and never create storage.

### Manifest

Small and cacheable (`cache-control: no-cache`). Carries `protocolVersion`
(`1`), `publicationId`, `revision`, `generatedAt` (explicit offset),
`tournament`, `capabilities`, `endpoints` constructed for the advertised
capabilities, and `final`.

### Snapshot

The complete public state at a revision. Served with `cache-control:
no-cache` and `ETag: "<revision>"` (exposed via
`access-control-expose-headers: etag`) so caches revalidate by revision. A
host that omits `ETag` is tolerated by conformance but dated; a host that
sends a wrong `ETag` fails.

### Events

`after` MUST be a non-negative integer (`400` otherwise, including `-1`,
`abc`, and overflowed cursors). `limit` defaults to `64` and clamps to
`1..=256`. Events with `revision > after` return oldest first with the
server's `currentRevision`.

When `after` precedes the replay window the server returns
`resyncRequired: true` with an empty list — never a short page a client
would mistake for being caught up. The client's only correct response is a
full snapshot reload. An empty history requires no resync.

### Stream

A WebSocket. The server sends `hello` immediately with its current revision
(`{ type: 'hello', protocolVersion: 1, publicationId, revision }`) so a
reconnected client detects gaps. Publications broadcast `{ type: 'event',
event }` in revision order; finalization broadcasts `{ type: 'final',
revision }`.

Spectator sockets are read-only. Any client-sent frame is answered with
`{ type: 'resync', currentRevision }` and changes nothing. A non-WebSocket
`GET` to `/stream` answers `400`, not an upgrade.

### Lifecycle reads

- Unknown publication or not-yet-published: `404 not-found`.
- Unpublished (via management `unpublish`): `410 gone`, credential stays valid.
- Finalized: `200` — a final page stays publicly readable; it is the record.
- Deleted (via management `delete`): `404 not-found`, credential revoked.

### Final persistence

A finalized publication MUST remain served without depending on replay
history: the final snapshot is stored whole, because a final page must not
require reconstructing a trimmed window.

---

## 3. Management contract

```
POST   /qblive/v1/manage/claim
PUT    /qblive/v1/manage/tournaments/{id}/snapshot
POST   /qblive/v1/manage/tournaments/{id}/sections
POST   /qblive/v1/manage/tournaments/{id}/announcements
POST   /qblive/v1/manage/tournaments/{id}/finalize
POST   /qblive/v1/manage/tournaments/{id}/unpublish
DELETE /qblive/v1/manage/tournaments/{id}
```

Every management route requires `Authorization: Bearer <token>` (constant-time
compare against the stored hash) except `claim`, which exchanges the
deployment's one-time setup token. Missing credentials answer `401`; wrong
ones answer `401`; an unclaimed backend answers `403`. Only hashes are
stored — never a copy of a credential the backend could produce.

Error bodies are `{ error, message }` with `currentRevision` on `conflict`,
so a publisher repairs with a full snapshot at the right revision.

### Claim / bootstrap

`POST /qblive/v1/manage/claim` with `{ setupToken, publicationId }`
answers `{ publicationId, managementToken, origin }` exactly once. A second
attempt fails (`403`) even with the right token; a wrong token fails
(`401`); a backend with no setup secret configured fails (`403`).

Protocol semantics (one-time exchange, constant-time compare, hashed
storage) are separate from deployment-specific secret supply: a Cloudflare
environment variable, a QBServer config file/flag, or a test constant. No
Cloudflare environment secret is part of the protocol, and claim/setup is
implementable by a local SQLite service.

### Full snapshot

`PUT .../snapshot` with `{ snapshot }` replaces the entire public state.
Used for the first publish and for conflict repair. Requires
`snapshot.publicationId` to match the route, `snapshot.revision` newer than
the server's (`409 conflict` with `currentRevision` otherwise), and a valid
snapshot document. Accepted while `unpublished` (republish recovery).

### Section update

`POST .../sections` with `{ baseRevision, revision, generatedAt, sections }`
replaces the named sections whole. Requires `baseRevision` equal to the
server's revision (`409` otherwise — the publisher repairs with a full
snapshot), `revision` newer, at least one known section, and valid section
bodies. Refused (`409`) once `final`.

### Announcement

`POST .../announcements` with `{ revision, announcement }` publishes an
announcement as an `announcements` section update (prepended, deduplicated by
id, capped at 256). A separate route — not "just send sections" — because
Director treats announcements as durable events with their own audit trail
and push class.

### Finalize

`POST .../finalize` with `{ revision, snapshot }` freezes the publication
with its last public state and broadcasts `final`. Further section updates
answer `409`. The final state stays served.

### Unpublish / delete

`POST .../unpublish` hides the tournament (`410 gone`) while keeping state
and credential valid; republishing recovers. Sockets close. `DELETE ...`
destroys state and revokes the credential (`404` thereafter, including for
the old token).

### Body limits

Management bodies larger than 8 MiB answer `413`. Malformed JSON answers
`400`. Section bodies that fail validation answer `400`.

---

## 4. Storage abstraction

Route logic speaks only to the `PublicationStorage` trait: atomic, durable
transitions rather than SQL calls.

Required atomic operations:

- claim / setup transition (one-time, hashed);
- initial / full snapshot publication;
- section / revision update with `baseRevision` guard;
- event append + bounded compaction (full window 256, local 64);
- finalize / unpublish / delete lifecycle;
- current snapshot reconstruction;
- replay page query (`after`/`limit`, `resyncRequired`);
- management credential hash / setup state.

**Durability rule:** a storage implementation MUST NEVER acknowledge a
successful publication mutation until it is durable according to its backend
contract (a committed SQLite transaction for QBServer; Durable Object
storage for Cloudflare). A crash between accepting an update and committing
it MUST NOT report success while losing the update. Corrupt/unreadable
state fails loudly and preserves the file; it never silently resets.

The Cloudflare implementation may continue using direct Durable Object
SQLite where wrapping it would add complexity; the semantic state machine
here is what QBServer implements faithfully, revision for revision.

---

## 5. Capability profiles

The conformance suite runs with `profile: 'full' | 'local' | 'basic'`
(default `full`). `local` passes when the server answers that there is no
management API here (404/405 on management routes) and does not require a
stream; it never pretends local mode is a full remote backend. `basic`
additionally skips events/stream. Capability checks skip — never fail — for
unadvertised features, so a static host is conforming.

Conformance CLI:

```bash
# Against a live backend (read-only unless a management token is given):
qblive-conformance --origin <url> --publication <id> [--management-token <token>]

# Against a fresh backend via the standard setup/claim hook:
qblive-conformance --origin <url> --publication <id> \
  --setup-token <secret> [--initial-snapshot snapshot.json] \
  [--profile full|local|basic]
```

---

## 6. Cross-language fixtures

`packages/qblive-protocol/fixtures` (emitted by
`@qbsheet/qblive-projection` from the real privacy fixture) is the shared
input TypeScript, Swift, the Cloudflare backend, the conformance suite, and
the Rust core all read. Identical fixtures MUST produce equivalent
observable responses from every backend: claim, full snapshot, partial
sections, announcement, replay, window-exceeded resync, stream hello,
finalization, unpublish/gone, invalid ids, malformed/oversized payloads, bad
tokens, delete/recreate, and ETag/cache headers.

`packages/qblive-protocol/tests/rust-parity.test.ts` asserts the Rust bounds
match `qbliveLimits`; `crates/qblive-server/tests/fixtures.rs` asserts the
fixtures satisfy the Rust validator. Drift fails on both sides.
