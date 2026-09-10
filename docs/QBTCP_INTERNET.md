# Internet QBTCP: architecture and operations

Normative companion to `QBTCP.md` (protocol) and `QBTCP-STREAM.md` (realtime
framing) for the tournament-owned Internet relay. The reference implementation is
`apps/qbtcp-relay-backend-cloudflare` (a Worker plus one SQLite Durable Object per
tournament); the Director sync engine is `src/director/relay/relaySync.ts`; deployment
is `QBTCP-RELAY-DEPLOY.md`.

## Ownership and privacy

The relay is **hosted in the tournament's Cloudflare account**. QBSheet operates no
central tournament backend, receives no tournament traffic, bills nothing, and
requires no QBSheet account. Setup and status copy says _Internet QBTCP_,
_tournament relay_, _hosted in your Cloudflare account_, _primary scoring address_,
and _LAN fallback_ — never _QBSheet Cloud_, _QBSheet servers_, or _upload tournament
to QBSheet_.

Director keeps the management credential in the OS keychain
(`com.qbsheet.director.qbtcp-relay`, separate from QBLive's and LAN QBTCP's
services); the tournament document carries only a pointer (origin, tournament id,
keychain account). Credentials never appear in URLs, QR codes, exports, logs, or
diagnostics. Pairing codes travel in the URL fragment and are stored relay-side as
SHA-256 hashes only.

## Trust and threat model

Least trusted first: room scorers hold narrowly scoped room/session capabilities and
can only affect their own room's progress, finals, help, and presence. A compromised
room token must not grant tournament-wide read/write, reach the management surface
(the relay answers scorer bearers on management routes with 401), or cross into
QBLive or Director Collaboration. Relay-management and Director-collaboration
credentials are separate security domains with separate Durable Objects, tables, and
middleware. Director remains authoritative tournament control: the relay retains and
forwards operational data but never schedules rounds, accepts results into
standings, advances teams, or invents tournament truth. Relay data never bypasses
normal result validation on Director, and protocol/body limits are enforced on both
ends. Pairing endpoints are rate-limited with uniform refusal. Do not share
credentials or an authorization domain with QBLive or Director Collaboration.

## Primary and fallback routing

```
preferred: tournament workers.dev relay
     ↓ unavailable / degraded
fallback: Director LAN QBTCP
     ↓ unavailable
local scoring continues from the persisted assignment
```

`workers.dev` may be the normal primary address: one stable HTTPS endpoint instead
of changing LAN addresses or Director laptop IPs. The pairing QR/link uses the
existing launch-link convention with `server=` pointing at the `workers.dev` base
URL; the LAN address stays attached to the same room — never a second pairing.
Failover never replaces or clears the active game, never forks a second logical
session, never splits writer ownership, never discards a pending final, and never
asks the scorekeeper which transport is active. When both paths are healthy,
identity — shared room, session, and match ids — is the authority rule: the first
retained final wins and duplicates converge by QBJ fingerprint, so mutations are
not raced blindly. Scorer UX collapses failure into transport-neutral states
(`src/director/relay/relayDegradation.ts`): connected, local, reconnecting,
saved-on-device. Provider vocabulary (Worker, DO, 1027, cursor) stays in
diagnostics.

## Data classes: durable vs coalescible

- **Final results: durable.** Retained immutably with fingerprints before durable
  receipt is acknowledged; never deleted while unacknowledged, however old the
  replay window grows. Ingestion reuses the transport-independent Results pipeline;
  duplicates are idempotent; conflicts stay Director review items; relay receipt is
  not standings acceptance.
- **Help requests: durable.** Survive Director absence; replayable until
  acknowledged/resolved, with original timestamps preserved.
- **Progress: coalescible.** Only the newest snapshot per session is kept (plus
  revision metadata for ordering) at exactly one row per accepted snapshot and zero
  replay events. A reconnecting Director wants current progress, not every
  intermediate score.
- **Presence: ephemeral.** TTL-based; never a durable write stream.
- **Assignment/session mirror: recoverable control state.** Enough mirrored
  assignment, pairing-hash, session, and writer metadata for an authorized scorer to
  continue and recover while Director is away — fenced by `(director_epoch,
revision)` so a stale Director is refused with 409 instead of forking the
  tournament. The relay never invents assignments.

## Revision and cursor semantics

Every coordination write (mirrors, session lifecycle, finals, help) allocates a
monotonic relay revision; progress and presence do not. Director holds a durable
`lastIngestedRelayRevision` cursor and replays `GET manage/events?after=<cursor>`
(bounded pages, clamped `limit`, optional `kinds` filter). The cursor advances only
after the corresponding local write has completed durably; a crash between ingest
and acknowledgment replays safely because unacknowledged items are retained and
`POST manage/acks` is idempotent. When the cursor predates the retained telemetry
window the relay answers `resyncRequired: true` instead of a page that looks
complete — except for durable-kind-scoped replays, which stay complete for
everything unacknowledged whatever the cursor. Full resync replaces
coalescible/session state from `GET manage/sessions` but must still fetch
unacknowledged results/help first: a snapshot is never an excuse to lose a final.
After reconnect Director reports one concise line
(`Reconnected · received N results …`) and stays quiet when nothing arrived.

## Final-result acknowledgment and retention

Receipt (`received`) means bytes committed to SQLite — through hibernation, restart,
and Director absence — with `accepted_by_director` always false. Acknowledgment is
valid only after Director's durable ingest; acknowledged items become eligible for
deletion after a 7-day retention window, unknown ack ids are ignored, and a retry
under the same identity answers `duplicate: true` with the original result id. A
different fingerprint for the same session is retained as a correction candidate
for Director review.

## WebSocket and HTTP behavior

Internet mode is push-first: one Worker request upgrades to the `qbtcp.stream.v1`
subprotocol, the socket authenticates with its first frame (credentials never in
the URL), assignment/status changes are server-pushed, and progress/help/results
travel the same session. The Durable Object hibernates between updates —
coordination state lives in SQLite and socket identity in versioned attachments —
with runtime ping/pong answered without waking the object and no application
heartbeat. Incoming socket messages meter 20:1 against DO request allowances.
Plain HTTP QBTCP endpoints remain for compatibility, recovery, and fallback, and
local-only QBTCP keeps working with no Cloudflare involvement.

## Local-first guarantees

An already-loaded assignment remains fully playable with every server
unreachable: network success is never in the scoring click path, failure cannot
remove the active game, a completed final stays durable on the device until some
transport acknowledges it, and quota refusal is transport failure rather than game
corruption. These are covered as failure modes, not aspirations
(`test/director-outage.test.ts`, `test/load-profile.test.ts`, degradation copy).

## Resource model and measured usage

Free-tier limits as of September 2026: 100,000 Worker requests/day and 100,000 DO
requests/day per account, 100,000 SQLite rows written/day, 5M rows read/day, 5 GB
storage; incoming DO WebSocket messages meter 20:1; exhaustion surfaces as Error 1027. `GET manage/health` reports relay-measured counters, storage pressure, and
headroom shares as labeled estimates — never a pretended exact quota.

Measured (`test/load-profile.test.ts`, workerd, CI logs carry the current
`[load-profile]` line): marginal progress cost **1.00 row per snapshot**; the
supported **medium profile (24 rooms, 10-hour day, 8 games/room, 40
progress/game)** projects to **~11,040 rows written (11% of Free)** and **~1,078
metered requests (1.1% of Free)** — well under half of every limit. The binding
dimension is rows written, driven by progress cadence × live rooms. If
`rows_written_share` climbs past ~0.3 by lunch, lengthen the scorer progress
cadence. Provider limits can change; the fallback semantics above do not depend on
them, and a bad measurement is fixed by protocol cadence or storage behavior — not
by recommending a paid plan.

## Quota-exhaustion behavior

Exhaustion degrades safely and visibly: scoring continues locally, finals stay
retryable on the device, Director replays on reconnect, and the scorekeeper sees
only `Reconnecting — keep scoring` / `Result saved on this device`. Director
surfaces persistent infrastructure risk (repeated relay failure, quota-like
refusal) explicitly.

## Spectator isolation

QBLive traffic must not consume the scoring deployment's budget. The recommended
architecture is Internet QBTCP on the tournament scoring Worker/DO and QBLive on
self-hosted QBServer + Tunnel. Never run a high-traffic spectator Worker in the
same Workers Free account as scoring: the 100,000-request allowance is
account-level. The relay (`qbtcp-relay-backend` / `QbtcpRelay`) and QBLive
(`qblive-backend` / `QblivePublication`) are separate Workers, Durable Objects,
bindings, and credential namespaces, guarded by
`packages/qbtcp-relay-conformance/tests/isolation.test.ts`.

## Incident recovery

See the incident checklist in `QBTCP-RELAY-DEPLOY.md`: quota exhaustion, relay
vs LAN vs total loss, Director restart, and the fencing rule that teardown waits
for unacknowledged finals.

## Implementing a non-Cloudflare relay

The contract is the HTTP surface plus the semantics above, not the provider:
claim/rotate management credentials with hashed storage; `PUT manage/mirror`
with `(director_epoch, revision)` fencing and 409 on stale; `GET manage/events`
with `after`/`limit`/`kinds`, honest `resyncRequired`, and durable-kind
completeness; `GET manage/sessions|results|help` as the sources of truth behind
notifications; idempotent `POST manage/acks`; retention that never trims
unacknowledged finals or open help; `manage/health` with measured counters and
labeled-estimate headroom; pairing rate limits with uniform refusal; WebSocket
push with server-side assignment updates and coalesced progress. Run
`packages/qbtcp-relay-conformance` against the implementation: discovery, then
streaming, then Director sync must all pass.
