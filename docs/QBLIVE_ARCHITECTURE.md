# QBSheet Live — architecture

The one-page answer to "what did this add, and where does it live".

> **QBSheet Director runs the tournament. QBSheet Live publishes the tournament.**

---

## 1. The whole system

```
                    PRIVATE / AUTHORITATIVE
                    ───────────────────────

   Scorers  ──── QBTCP ────▶  QBSheet Director  (Tauri + React + SQLite)
   (browser)                  ┌──────────────────────────────┐
                              │ canonical tournament document│
                              │ @qbsheet/tournament-domain   │
                              │ scheduling · accepted results│
                              │ standings · statistics       │
                              └───────────────┬──────────────┘
                                              │
                          @qbsheet/qblive-projection
                       deterministic · constructs, never filters
                                              │
                                      LiveTournamentSnapshot
                                              │
                              durable outbox, same SQLite transaction
                                              │
                                   background publication worker
                                              │
                    ═══════════════════════════╪═══════════════════════
                     PUBLIC / OPTIONAL         ▼

                        The tournament's own QBLive backend
                        ── in the director's Cloudflare account ──
                        Worker + SQLite Durable Object + WebSocket
                                   │
                    ┌──────────────┼───────────────┐
                    ▼              ▼               ▼
              Live Web        Live iOS        App Clip
              (apps/live-web) (ios/)          (ios/)
                                   │
                                   │ optional
                                   ▼
                        push.qbsheet.com  (the only dynamic
                        service QBSheet operates)
                                   │
                                  APNs
```

**No tournament byte passes through QBSheet infrastructure.** `live.qbsheet.com` is static; it
tells a client where the tournament's backend is and gets out of the way. `push.qbsheet.com` exists
only because an APNs provider key cannot be distributed.

---

## 2. The canonical domain decision

**`DirectorState` in `@qbsheet/tournament-domain` is the single authoritative tournament document.**

| Consumer | How it uses the document |
| --- | --- |
| Director React | reads and mutates it directly |
| Tauri SQLite store | persists it whole, and projects it into normalized rows in the same transaction |
| Portable archive / QBJ / SQBS | serializes it |
| **QBSheet Live** | projects a sanitized public view of it |

Before this work `DirectorState` lived in `src/director/domain`, inside the scorer's source tree,
where a package could not import it without importing the scorer. It moved to a package;
`src/director/domain` re-exports it, so several hundred existing imports keep resolving against one
definition. Standings and statistics derivation moved with it, so Live and Director compute
placement with the *same code* rather than with two implementations that agree today.

`@qbsheet/tournament-core` stays what it was: a planning and derivation engine — scheduling,
brackets, advancement, division placement — that takes inputs adapted from the document and returns
plans. It does not hold tournament state.

**Live adds no third copy.** There is no Live-specific tournament model anywhere.

The document gained three things Live needed and Director lacked:

- **A tournament timezone** (IANA), chosen once at creation and never re-derived from whichever
  machine is running Director.
- **A public timeline** — lunch, check-in, awards — because a team's next commitment at 12:05 is
  lunch, not the round after it.
- **Publication state**, including the outbox, so that publishing is atomic with the mutation that
  caused it.

Schema v3 migrates existing documents. It writes **UTC**, not the host's zone: an obviously wrong
offset is recoverable, a plausibly wrong one is not.

---

## 3. The privacy boundary

```
DirectorState + LivePublicationSettings  ──▶  QbliveSnapshot
```

`projectLiveSnapshot` **constructs** a public document field by field. It never serializes the
internal tournament and removes properties.

That is the whole design. A filter fails **open** — a new internal field appears and is published
because nobody remembered to deny it. A constructor fails **closed** — a new field is simply not
mentioned and cannot appear.

Enforced, not asserted: `packages/qblive-projection/tests/privacy.test.ts` seeds a sentinel string
into every private field of a full tournament document and checks it does not occur in the
serialized snapshot for **all 8 192 combinations** of publication settings. A companion test checks
the fixture actually seeds every field on a named list, so a private field nobody seeded cannot make
the sweep vacuous for it.

### The visibility matrix

| Setting | Default | Publishes |
| --- | --- | --- |
| `teamNames` | **on** | Team display names and organization short names. Off substitutes `Seed N`. |
| `playerNames` | **off** | Public rosters. |
| `playerStatistics` | **off** | Individual statistics. Requires `playerNames`. |
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

Anything a paper schedule taped to a wall already said is on. Anything that is a new disclosure is
off.

Never published, under any setting: QBTCP pairing codes, room tokens, session tokens, management
credentials, device IDs, client IPs, publisher credentials, raw result submissions, result
fingerprints, rejected submissions, recovery state, SQLite internals, database paths, backup paths,
internal audit history, staff information, equipment inventory, packet security information,
unreleased packet information, Director-only notes, private protest information, update-signing
credentials, APNs credentials.

**Schedule visibility.** A game reaches the projection only when its round is *released* or
*closed*. A phase whose rounds are all unreleased contributes no standings scope either, because a
scope label ("Championship bracket") is itself a disclosure.

**Player privacy.** Many QBSheet tournaments involve students, so player names and individual
statistics are a separate decision, default off, with a plain sentence and a second click before
the switch takes effect.

---

## 4. The durable outbox

```
Director mutation
      ↓
derive the public projection          ─┐
if it changed, append to the outbox    │  one SQLite transaction
persist the tournament document       ─┘
      ↓
the local operation reports success
      ↓
a background worker publishes, later, with retries
```

The outbox lives **inside** the tournament document, so the existing single-transaction save makes
it atomic for free. Director can never persist an accepted result and lose the knowledge that it
needs publishing.

The derivation runs inside `commit` in `useDirectorController`, not at the call sites that change
something public. There are dozens of those, and any one that forgot would produce a tournament that
is correct locally and silently stale to every spectator.

**Retry policy.** Transient failures back off exponentially with full jitter — a conference centre's
worth of Directors must not all retry in the same millisecond. A revision conflict discards the
queued update and queues a full snapshot at the backend's revision. A fatal failure (401, 403, 404,
410) stops the loop, because retrying a wrong credential every minute for eight hours drains a
laptop and buries the one message a Director needs to read.

**Bounded.** Consecutive transient-only updates coalesce to the newest — a reconnecting spectator
wants the current score, not the sequence that produced it — and past 64 items the whole queue is
replaced by one snapshot, which says the same thing in one request.

The outage scenario is a test, not a hope:
[`src/director/live/publication.test.ts`](../src/director/live/publication.test.ts) drives internet
loss, six rounds of continued local mutation, and automatic resynchronization, asserting that every
local write succeeds throughout.

---

## 5. What was built

| Component | Path | Notes |
| --- | --- | --- |
| Canonical domain | `packages/tournament-domain` | `DirectorState`, timezone, timeline, publication settings, standings derivation |
| QBLive protocol | `packages/qblive-protocol` | Types, bounded validators, bootstrap URL, client, JSON Schema, shared fixtures |
| Public projection | `packages/qblive-projection` | The privacy boundary, plus section diffing |
| Activity shard state | `packages/qblive-activity` | The compact broadcast encoding and its size measurements |
| Conformance suite | `packages/qblive-conformance` | Runs against any QBLive server; also the load harness |
| Cloudflare backend | `apps/qblive-backend-cloudflare` | Worker + SQLite Durable Object, "Deploy to Cloudflare" ready |
| Push gateway | `apps/qblive-push` | The APNs boundary and nothing else |
| APNs prototype | `apps/qblive-push-prototype` | The transport probe; results in `QBLIVE_PUSH_PROTOTYPE.md` |
| Live Web | `apps/live-web` | 57 kB gzipped, five tabs, no service worker |
| iOS app + App Clip | `ios/` | iOS 18, SwiftUI, one shared dependency-free package |
| Director Live UI | `src/director/live` | Setup, visibility, sync health, QR, announcements, lifecycle |
| Director native Live | `apps/director/src-tauri/src/live.rs`, `live_server.rs` | Keychain credential, schema v5, local-network server |

### Test counts

| Suite | Tests |
| --- | --- |
| Root (scorer + Director) | 2 141 |
| QBLive protocol | 44 |
| Public projection privacy | 18 (one sweeps 8 192 settings combinations) |
| Activity shard payloads | 12 |
| Conformance suite | 14 |
| Live Web | 14 |
| Cloudflare backend (real `workerd`) | 25 |
| Push gateway (real `workerd`) | 39 |
| Swift shared kit (iOS Simulator) | 28 |
| Director native (Rust) | 38 |

---

## 6. Documents

| | |
| --- | --- |
| [`QBLIVE.md`](QBLIVE.md) | The normative QBLive v1 specification |
| [`QBLIVE_IOS.md`](QBLIVE_IOS.md) | iOS targets, AASA, App Store Connect checklist |
| [`QBLIVE_ACTIVITY.md`](QBLIVE_ACTIVITY.md) | Sharding, measured payload sizes, cadence |
| [`QBLIVE_PUSH_PROTOTYPE.md`](QBLIVE_PUSH_PROTOTYPE.md) | The APNs transport measurement and its verdict |
| [`QBLIVE_LOAD.md`](QBLIVE_LOAD.md) | Load results, the measurement artifact, channel modelling |
| [`../apps/qblive-backend-cloudflare/README.md`](../apps/qblive-backend-cloudflare/README.md) | Deploying a tournament backend |
| [`../apps/qblive-push/README.md`](../apps/qblive-push/README.md) | The push gateway |

---

## 7. What the existing software gave up

Nothing. Verified rather than assumed:

- The scorer's Vite build, service worker, and precache list are unchanged;
  `tests/ServiceWorkerIsolation.test.ts` still passes and no Live asset appears in `dist/sw.js`.
- Live Web is a **separate** Vite build to a separate origin, so a spectator asset cannot land in a
  scorekeeper's offline shell.
- QBTCP is untouched. Live never reads it, never writes it, and is not on its port.
- The scorer's GitHub Pages deployment (`pages.yml`) is untouched.
- All 2 141 pre-existing tests pass.

The one intentional change to existing behaviour is the canonical domain move, which is mechanical:
`src/director/domain` re-exports the package, and the Director's schema went v2 → v3 with an
explicit migration.
