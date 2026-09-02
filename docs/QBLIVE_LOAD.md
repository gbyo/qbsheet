# QBLive load-test results

Harness: [`packages/qblive-conformance/src/load/harness.ts`](../packages/qblive-conformance/src/load/harness.ts).

```bash
npm run load --workspace=@qbsheet/qblive-conformance -- \
  --origin http://127.0.0.1:8788 --publication <id> \
  --viewers 300 --seconds 45 --update-ms 5000 --management-token <token>

npm run load --workspace=@qbsheet/qblive-conformance -- --channels   # no network
```

Deliberately **not** in ordinary CI. A thousand concurrent WebSockets is a useful measurement and a
poor unit test — slow, machine-sensitive, and a flake would train everybody to ignore a red build.
It runs on demand and on a schedule.

---

## 1. WebSocket spectators

Measured 2026-09-02 against the Cloudflare backend running in `workerd` via `wrangler dev`, on an
Apple-silicon laptop. Each spectator is a real WebSocket that stays open, and delivery is counted
per socket per published revision — a backend that accepts 800 connections and delivers to 40 of
them does not pass.

| Spectators | Connected | Failed | Delivery | Connect p50 / p95 / max | Update latency p50 / p95 / p99 / max |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 300 | 300 | 0 | **100.0%** | 5 / 7 / 14 ms | 22 / 40 / 41 / **42 ms** |
| 800 | 800 | 0 | **100.0%** | 4 / 7 / 32 ms | 34 / 50 / 51 / **52 ms** |

Arrivals are spread over a ramp rather than fired simultaneously: three hundred phones do not open a
link in the same millisecond, and pretending they do measures a burst nobody experiences.

Latency grows sublinearly from 300 to 800 sockets — 22 ms to 34 ms at the median for 2.7× the
connections — which is what a single broadcast loop over hibernatable sockets should look like.

**A one-day tournament has a few hundred spectators.** These numbers are comfortably above that.

## 2. A measurement artifact worth recording

The first load runs reported a p50 latency of 1 018 ms, 2 008 ms, or 3 300 ms — and the figure moved
with the *publish interval*, not with the number of viewers:

| Publish interval | Reported latency |
| ---: | ---: |
| 700 ms | ~3 300 ms |
| 2 000 ms | ~2 008 ms |
| 3 000 ms | ~1 018 ms |
| 5 000 ms | ~22 ms |

Interval plus latency is ~4 000 ms in every row. Isolating it:

- Reads (`GET snapshot`) were 4–7 ms throughout.
- A single write after 8 seconds of idle completed in **7 ms**.
- Writes at a 5-second spacing completed in 8–20 ms.
- Writes at a 700 ms spacing completed on a ~4-second boundary regardless of when they were issued.
- The same pattern appeared with **no WebSocket connected at all**, so it is not the broadcast.

That is a periodic write-durability flush in `wrangler dev`'s local Durable Object persistence, and
the response is held behind it by the output gate. It is a local-development property, not a
Durable Object one: deployed Durable Object storage writes are confirmed in single-digit
milliseconds.

Recorded here because the wrong conclusion was available and plausible — "the QBLive backend adds a
second of latency" — and it would have been drawn from the harness's own first output.

**Consequence:** local load runs should use `--update-ms 5000` or higher. A run against a deployed
Worker can use the real coalescing cadence.

## 3. APNs channel consumption

Arithmetic over the sharding rules rather than a network test, run as a check on the design's
central claim: channel count scales with *active shards*, never with viewers. Sixteen teams per
shard (the [measured](QBLIVE_ACTIVITY.md) size), Apple's ceiling 10 000, QBSheet's allocation
ceiling 8 000.

| Scenario | Teams | One channel per team | Shards created eagerly | **Lazy creation** |
| --- | ---: | ---: | ---: | ---: |
| One 64-team tournament, 20% adoption | 64 | 64 | 4 | **4** |
| One 64-team tournament, 100% adoption | 64 | 64 | 4 | **4** |
| A busy Saturday: 40 tournaments × 32 teams, 30% adoption | 1 280 | 1 280 | 80 | **80** |
| An implausible Saturday: 500 tournaments × 48 teams, 50% adoption | 24 000 | 24 000 | 1 500 | **1 500** |

Every scenario is inside the budget, including one three orders of magnitude past any real
Saturday. The naive column is the point: a channel per team would exhaust Apple's global ceiling at
about 400 tournaments, and a channel per *viewer* would exhaust it in one large tournament.

At realistic adoption a shard is almost always active, so lazy creation and eager creation converge
— the saving is not in the steady state but in the tail: a tournament where somebody follows three
teams consumes three channels, not eight.

## 4. What has not been measured

| | Status |
| --- | --- |
| WebSocket fan-out on deployed Cloudflare | **Not measured.** No Cloudflare account was available. Local `workerd` is the same runtime, but not the same network, eviction behaviour, or storage latency. |
| Many concurrent tournaments (many Durable Objects) | **Not measured.** One object per tournament and no shared state between them makes this the case least likely to surprise, but "least likely" is not "measured". |
| Reconnect storms | Partially. Connect timings above are from a cold ramp; a mass disconnect-and-return has not been driven. Client-side backoff is full-jitter and unit-tested. |
| APNs push throughput | **Not measured.** Needs Apple credentials — see [`QBLIVE_PUSH_PROTOTYPE.md`](QBLIVE_PUSH_PROTOTYPE.md). |
| Director's local-network server under load | **Not measured.** It advertises no WebSocket, so its load shape is HTTP polling from one building. |
