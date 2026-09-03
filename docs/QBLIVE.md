# QBLive v1 — the QBSheet Live protocol

**Status:** normative for QBLive v1.
**Namespace:** `/qblive/v1/`
**Reference implementations:** `apps/qblive-backend-cloudflare` (Cloudflare Worker + Durable Object), Director's local-only server (`apps/director/src-tauri/src/live_server.rs`).
**Machine-readable schema:** [`packages/qblive-protocol/schemas/qblive-v1.schema.json`](../packages/qblive-protocol/schemas/qblive-v1.schema.json)
**Fixtures:** [`packages/qblive-protocol/fixtures/`](../packages/qblive-protocol/fixtures/)

QBLive is the public, read-mostly protocol a quiz bowl tournament uses to publish itself. It is
deliberately separate from [QBTCP](QBTCP.md), which is private operational infrastructure between
Director and the scoring devices in rooms. QBTCP is how a tournament is *run*; QBLive is how a
tournament is *shown*.

QBLive is vendor-neutral. Nothing in this document requires Cloudflare, Apple, or qbsheet.com. A
static file host serving two JSON documents is a conforming QBLive server.

---

## 1. The promise

> **QBSheet Director runs the tournament. QBSheet Live publishes the tournament.**

QBSheet Live is never required for scoring, QBTCP, scheduling, result acceptance, advancement,
statistics, recovery, or persistence. If the internet, the Live backend, the App Clip bootstrap
site, and QBSheet's push infrastructure all disappear mid-tournament, the tournament continues
normally and Live catches up afterwards. Everything below is designed backwards from that.

The concrete mechanism is the [durable outbox](#8-the-durable-outbox): Director's local write always
succeeds first, and publication is a separate, retryable, later thing.

---

## 2. Roles

```
PRIVATE / AUTHORITATIVE                    PUBLIC / OPTIONAL

  Scorers ──QBTCP──▶ Director                  Tournament's QBLive backend
                        │                       (the TD's own account)
              canonical state                            │
              SQLite, scheduling,             ┌───────────┴───────────┐
              accepted results,               │                       │
              standings, statistics       Live Web               Live iOS / App Clip
                        │
             deterministic public                        +
                 projection                    push.qbsheet.com (optional)
                        │                        serverless APNs only
                 durable outbox                          │
                        │                               APNs
                async publishing ─────────────▶
```

QBSheet-operated infrastructure never carries ordinary tournament traffic. `live.qbsheet.com` serves
static assets and the Apple association files; `push.qbsheet.com` exists only because an APNs
provider key cannot be handed to arbitrary Directors. See [§13](#13-apple-push).

---

## 3. Capability levels

A QBLive server declares what it can do in its manifest. All three levels are conforming.

| Level | Requires | Notes |
| --- | --- | --- |
| **QBLive Basic** | `GET manifest`, `GET snapshot` | A static object host qualifies. Clients poll or refresh. |
| **QBLive Realtime** | Basic + `GET events?after=`, `GET stream` | WebSocket push with replay. |
| **QBLive Apple Push** | Realtime + registration with `push.qbsheet.com` | Optional. Never required for conformance. |

A client MUST work against a Basic server. A client MUST NOT require `stream`.

---

## 4. Public API

All public routes are unauthenticated, `GET`, and CORS-enabled for `*`. They MUST NOT accept a
management credential; a server that honours one on a public route is non-conforming.

```
GET /qblive/v1/tournaments/{publicationId}/manifest
GET /qblive/v1/tournaments/{publicationId}/snapshot
GET /qblive/v1/tournaments/{publicationId}/events?after={revision}&limit={n}
GET /qblive/v1/tournaments/{publicationId}/stream        (WebSocket upgrade)
```

`{publicationId}` is a 20-character identifier drawn from `0123456789bcdfghjkmnpqrstvwxyz`
(vowel-free, no lookalikes), generated from a CSPRNG. It is public routing information and a
capability to *read*, never to write.

`npm run qblive:demo` serves these four routes locally from a demo tournament that plays itself,
which is how a client is exercised without deploying a backend or running a tournament. It is a
development affordance and not a reference implementation — see
[`QBLIVE_IOS.md#12-simulating-a-tournament`](QBLIVE_IOS.md#12-simulating-a-tournament).

### 4.1 Manifest

Small and cacheable. A client fetches it first to learn the revision and the capabilities.

```json
{
  "protocolVersion": 1,
  "publicationId": "bcdfghjkmnpqrstvwxyz",
  "revision": 41,
  "generatedAt": "2026-09-05T14:30:00.000Z",
  "tournament": { "id": "...", "name": "Saturday Invitational", "timeZone": "America/New_York", "status": "in-progress", "date": "2026-09-05", "venue": "...", "organizer": "..." },
  "capabilities": { "snapshot": true, "events": true, "stream": true, "applePush": false },
  "endpoints": { "snapshot": "...", "events": "...", "stream": "..." },
  "final": false
}
```

### 4.2 Snapshot

The complete public state at a revision. See [§6](#6-sections).

### 4.3 Events

```
GET .../events?after=40
```

Returns events with `revision > after`, oldest first, plus the server's `currentRevision`. When
`after` precedes the server's replay window the server returns `resyncRequired: true` and an empty
list; the client's only correct response is to reload the snapshot.

### 4.4 Stream

A WebSocket. Frames are `hello`, `event`, `resync`, `final`. A client MUST ignore frames whose
`type` it does not recognise. The server sends `hello` immediately with its current revision so a
client that reconnected can tell whether it has a gap.

### 4.5 Errors

Every error response is `{ "error": <code>, "message": <human string> }` with an appropriate HTTP
status. `conflict` additionally carries `currentRevision`.

---

## 5. Revisions

Public state carries a monotonically increasing integer `revision`. It never decreases and never
resets for the life of a publication.

Clients detect gaps by arithmetic, not by trust:

```
receive revision R
  R == held + 1        apply
  R <= held            ignore (stale; APNs and WebSocket both reorder)
  R >  held + 1        gap
                         └─ request events?after=held
                              └─ resyncRequired → reload snapshot
```

Publishers use `baseRevision` on section updates so that a server which has moved on answers `409
conflict` with its own revision rather than applying an update out of order. The publisher repairs
by sending a full snapshot at its current revision.

---

## 6. Sections

Public state is divided into named sections, each replaced whole:

`tournament`, `teams`, `rooms`, `timeline`, `schedule`, `results`, `liveGames`, `standings`,
`statistics`, `announcements`.

An event carries only the sections that changed. Whole-section replacement is chosen over JSON Patch
deliberately: a patch engine costs bytes on the App Clip's [size budget](#12-app-clip-size) and
makes "what does this update mean" a non-obvious question, while section assignment is one line of
client code that cannot be subtly wrong. The section granularity is already fine enough for the case
that matters — a live score tick touches only `liveGames`.

### 6.1 High-frequency state

`liveGames` is **transient**: only its newest value matters. A client that missed 90–80, 100–80 and
100–90 wants 110–90, not a replay. Servers MAY coalesce consecutive transient-only events.

`results`, `announcements` and released `schedule` changes are **durable**: they are preserved in
replay and never coalesced away.

---

## 7. Times

### 7.1 The tournament timezone

Every tournament carries an IANA timezone identifier (`America/New_York`). It is chosen once, at
creation, and is never re-derived from whichever machine is running Director. Every published
timestamp is ISO 8601 with an explicit offset — `2026-09-05T13:30:00-04:00` — never a bare local
time and never an unqualified `Z` for a local event.

### 7.2 No estimated times

**A QBLive server MUST NOT publish an estimated, projected, or inferred start time.**

Not "Estimated 2:14 PM". Not "probably starts in 7 minutes". Not "expected after Room 104 finishes".

`scheduledStart` is either an actual scheduled time the tournament committed to, or `null`. A client
renders `null` as no time at all. This is a protocol rule rather than a UI convention because the
harm is real: a parent who drives back to the school for a 2:14 that was never real has been misled
by software, and a tournament that has not committed to a time has said so by not committing.

---

## 8. The durable outbox

Director MUST NOT write synchronously to Live infrastructure from a scoring or result mutation.

```
local tournament state changes
        ↓
save authoritative state locally           ─┐
derive public projection                    │  one SQLite transaction
if the projection changed:                  │
    append the update to the local outbox  ─┘
        ↓
local operation reports success
        ↓
background worker publishes, later, with retries
```

The three writes commit atomically. The failure this prevents is specific and bad: Director accepts
a result, the accept is durable, and the knowledge that the result *needs publishing* is lost.

Internet availability never affects a local mutation. See
[`apps/director/src-tauri/src/live.rs`](../apps/director/src-tauri/src/live.rs).

---

## 9. The public projection is a boundary

```
CanonicalTournamentState + LivePublicationSettings  →  LiveTournamentSnapshot
```

The projection *constructs* a public document field by field. It never serializes the internal
tournament and removes properties.

That distinction is the design. A filter fails **open** — a new internal field appears and is
published because nobody remembered to deny it. A constructor fails **closed** — a new internal
field is simply not mentioned and cannot appear.

[`packages/qblive-projection/tests/privacy.test.ts`](../packages/qblive-projection/tests/privacy.test.ts)
enforces this: a Director document is seeded with a sentinel string in every private field, and the
test asserts the sentinel does not occur in the serialized snapshot for **every one of the 8 192
combinations** of publication settings.

### 9.1 Never published

QBTCP pairing codes · QBTCP room tokens · QBTCP session tokens · management credentials · device
IDs · client IPs · backend publisher credentials · raw result submissions · result fingerprints ·
rejected submissions · recovery state · SQLite internals · database paths · backup paths · internal
audit history · staff private information · equipment inventory · packet security information ·
unreleased packet information · Director-only notes · private protest information · update-signing
credentials · APNs credentials.

### 9.2 The visibility matrix

| Setting | Default | Publishes |
| --- | --- | --- |
| `teamNames` | **on** | Team display names and organization short names. Off substitutes `Seed N`. |
| `playerNames` | **off** | Public rosters. |
| `playerStatistics` | **off** | Individual statistics tables. Requires `playerNames`. |
| `releasedSchedule` | **on** | Games in released rounds only. |
| `roomLocations` | **on** | Room names, and room references on games. |
| `roomDirections` | **on** | Free-text directions. |
| `acceptedResults` | **on** | Final scores of accepted games in released rounds. |
| `liveGameStatus` | **on** | That a game is in progress. |
| `liveScores` | **off** | The running score of a game in progress. |
| `liveProgress` | **off** | Tossups read so far. |
| `announcements` | **on** | Director announcements. |
| `standings` | **on** | Standings tables. |
| `teamStatistics` | **on** | Team statistics tables. |

Anything a paper schedule taped to a wall would already have said is on. Anything that is a new
disclosure is off.

### 9.3 Schedule visibility

A game reaches the public projection only when **its round is released or closed**. Director
generates rebrackets and tiebreakers internally long before they go on the wall; `released` is the
moment they go on the wall.

A phase whose rounds are all unreleased contributes no standings scope either — a scope label
("Championship bracket") is itself a disclosure.

`ScheduledGame.publicVisibility: 'hidden'` lets a Director suppress a specific released game. There
is deliberately **no** `'shown'` override: nothing publishes ahead of its round.

### 9.4 Player privacy

Many QBSheet tournaments involve students. Player names and individual statistics are therefore a
separate decision from everything else, default off, and Director shows a plain warning when they
are turned on: *individual player information will become publicly accessible through the
tournament's Live link.* No accounts, no legal claims — just an accurate sentence before the switch.

---

## 10. Dynamic tables

Director is authoritative for official placement. QBLive therefore does not define standings columns;
it carries them.

```json
{
  "id": "standings:overall",
  "title": "Standings",
  "scope": "overall",
  "scopeLabel": "Overall",
  "columns": [
    { "id": "rank", "label": "#", "kind": "rank", "alignment": "trailing" },
    { "id": "team", "label": "Team", "kind": "team", "alignment": "leading" },
    { "id": "record", "label": "W–L", "kind": "record", "alignment": "trailing" },
    { "id": "ppb", "label": "PPB", "kind": "decimal", "precision": 2, "alignment": "trailing" }
  ],
  "rows": [
    { "id": "team-a", "teamId": "team-a",
      "cells": [ { "value": 1, "display": "1" },
                 { "value": "Ninety Six A", "entityId": "team-a" },
                 { "value": "7-1", "display": "7-1" },
                 { "value": 18.4, "display": "18.40" } ] }
  ]
}
```

Rules:

- **Clients MUST render unknown `kind` values** by falling back to `display`. This is what lets a
  new Director statistic reach an installed iPhone with no App Store release.
- `display` is authoritative for rendering. Director has already applied the tournament's formatting;
  a client that re-derived the string would disagree with the printout at the front desk.
- `entityId`, `teamId` and `playerId` let a client highlight the followed team without understanding
  any column.
- **Clients MUST NOT recompute official ranking.** Order the rows as given.

Scopes are `overall`, `phase:<id>`, `pool:<id>`, or any future string a Director advertises.

---

## 11. Management API

Separate namespace, bearer-authenticated, never public.

```
PUT    /qblive/v1/manage/tournaments/{id}/snapshot
POST   /qblive/v1/manage/tournaments/{id}/sections
POST   /qblive/v1/manage/tournaments/{id}/announcements
POST   /qblive/v1/manage/tournaments/{id}/finalize
POST   /qblive/v1/manage/tournaments/{id}/unpublish
DELETE /qblive/v1/manage/tournaments/{id}
POST   /qblive/v1/manage/claim
```

`claim` exchanges a **one-time setup token**, minted by a freshly deployed backend, for a long-lived
management credential. Only the short-lived value ever travels through a browser address bar.

### 11.1 Unpublish versus delete

| | Public endpoints | Backend state | Push channels | Credentials |
| --- | --- | --- | --- | --- |
| **Unpublish** | `410 gone` | retained, recoverable | ended | still valid |
| **Delete** | `404 not-found` | destroyed | deleted | revoked |

Delete is irreversible and confirmed in Director.

---

## 12. App Clip size

The QBSheet Live App Clip is invoked from **printed QR codes**, which is a physical invocation, so
Apple's **15 MB uncompressed, thinned** limit applies — not the 50 MB digital-invocation limit.

`ios/scripts/measure-app-clip.sh` measures the thinned uncompressed bundle and fails the build above
the budget. Exceeding the physical-invocation limit is a release blocker: an App Clip over it simply
does not launch from a code, which would break the product's primary entry point.

---

## 13. Apple push

Optional. A QBLive server without it is fully conforming.

QBSheet Live requires iOS 18, so remote Live Activity updates use **ActivityKit broadcast push
channels** exclusively. Per-device token fanout for Live Activities is deliberately not implemented.

### 13.1 Why a QBSheet-operated component exists at all

An APNs provider key authenticates as *the QBSheet Live app*. It cannot be distributed to arbitrary
Director installations or third-party QBLive servers. `push.qbsheet.com` is therefore the smallest
possible trusted boundary: it holds the key, it constructs the APNs payloads itself, and it never
carries ordinary tournament data.

It is **not** the Live backend. If it is down, everything except background Live Activity updates
and APNs notifications keeps working, and Director says exactly that:

> Live data is synced.
> Apple background updates are temporarily unavailable.

### 13.2 Channel sharding

Channels are **per shard of teams**, not per team and not per user.

```
64-team tournament, 8 teams per shard

Shard 0 → teams  1–8      Shard 4 → teams 33–40
Shard 1 → teams  9–16     Shard 5 → teams 41–48
Shard 2 → teams 17–24     Shard 6 → teams 49–56
Shard 3 → teams 25–32     Shard 7 → teams 57–64
```

A user's Live Activity static attributes name their followed team; the broadcast `ContentState`
carries compact state for the whole shard; the SwiftUI view renders only the followed team's entry.
Channel count therefore scales with *active shards*, not with viewers.

Channels are created **lazily** — only when somebody actually starts an Activity in that shard — and
deleted when the tournament finalizes, when the publication is deleted, or when the channel exceeds
its lifecycle.

Apple's documented ceiling is 10 000 channels per app per environment. QBSheet's internal allocation
ceiling is **8 000**, leaving a deliberate reserve. On exhaustion, Live degrades to
foreground-only realtime and says so; it does not break.

### 13.3 Cadence

| Class | Examples | Coalescing | APNs priority |
| --- | --- | --- | --- |
| Routine | score change, tossup progress | ~15 s | 5 |
| Transition | game starts, game final, late room change | prompt | 10 |
| Announcement | Director announcement | its own flow | 10 |

Before enqueueing, the gateway hashes the normalized shard state and drops an unchanged one. APNs is
best-effort; QBSheet Live never implies every score tick reaches a Lock Screen.

---

## 14. Local-only mode

Director can serve QBLive itself over the LAN with no internet:

```
http://192.168.1.20:8790/live/<publicationId>
```

Spectator routes are completely separate from QBTCP's private management routes. The official App
Clip cannot be invoked offline — the association lookup needs the internet — so local mode uses the
responsive web client, and Director says so rather than printing a QR that will not work.

---

## 15. Conformance

[`packages/qblive-conformance`](../packages/qblive-conformance) is a reusable suite that runs against
any QBLive server by base URL. A third-party implementation can run the same tests:

```bash
npm run conformance --workspace=@qbsheet/qblive-conformance -- \
  --origin https://my-backend.example --publication <id> --management-token <token>
```

It covers manifest, snapshot, privacy, revisions, replay, WebSocket, reconnect, revision conflict,
full resync, authentication, invalid management token, spectator write rejection, malformed input,
oversized input, CORS, finalization, unpublish, and deletion.

---

## 16. Versioning

`protocolVersion` is `1`. A client that receives a higher version MUST refuse the document and say
so rather than guess. Additive, backwards-compatible changes — a new optional field, a new column
`kind`, a new timeline event type, a new table scope — do **not** bump the version, because clients
are required to tolerate them.
