# push.qbsheet.com — the QBSheet Live push gateway

The only dynamic service QBSheet operates, and it is deliberately tiny.

## Why it exists

An APNs provider key authenticates as **the QBSheet Live app**. It cannot be handed to arbitrary
Director installations, or to a tournament director's own Cloudflare account, or to a third-party
QBLive server. So remote Live Activity updates need exactly one trusted component that holds it.

This is that component and nothing more.

## What it is not

It is **not** the QBLive backend. It carries no tournament data. If it is down:

```
QBLive backend                          healthy
QBSheet Live Web                        healthy
iOS foreground realtime                 healthy
schedules, standings, statistics        healthy
accepted results                        healthy

background Live Activity updates        degraded
APNs announcement notifications         degraded
```

Director says exactly that:

> Live data is synced.
> Apple background updates are temporarily unavailable.

Not "QBSheet Live offline".

## Architecture

```
publisher (Director or a QBLive backend)
        │  describes an intent, never an APNs payload
        ▼
   push Worker ── publisher auth, bounds
        │
        ▼
 PushPublication (SQLite Durable Object, one per publication)
        │  dedupe by state hash · coalesce routine updates · channel budget
        ▼
   Cloudflare Queue ── absorbs a round-ending burst
        │
        ▼
   APNs sender ──▶ api.push.apple.com:443            (broadcasts, notifications)
        │
        └─ ApnsCredential (one Durable Object) ──▶ provider JWT, minted once per rotation
                 │
                 ▼
        api-manage-broadcast.push.apple.com:2196     (channel lifecycle only)
```

## There is no route that sends arbitrary APNs JSON

A publisher describes an intent — *this shard's state changed*, *publish this announcement*, *end
these activities* — and the Worker constructs the APNs request. A `POST /apns` taking a payload
would be a way for anybody holding one publisher credential to send anything at all, to anybody, as
QBSheet Live.

## Routes

```
GET  /health                            is push configured, and what is the channel ceiling
GET  /v1/budget                          channels used against QBSheet's allocation

POST /v1/publications                    register a tournament; returns a publisher credential once
POST /v1/activity/channel                the channel for a shard, created on first request
POST /v1/activity/update       (auth)    a shard's glanceable state changed
POST /v1/activity/end          (auth)    end every Activity, delete every channel
POST /v1/announcements         (auth)    fan an announcement out to registered devices
POST /v1/notifications/register          a device registering itself
POST /v1/notifications/unregister
POST /v1/status                (auth)    what Director's status panel shows
```

`/v1/activity/channel` takes no publisher credential on purpose: a channel id is not a secret. It is
the identifier a device needs in order to subscribe, and anybody who can open the tournament can
already see everything the channel carries. What it needs is a *bound*, and that comes from the
publication's registered team count.

## What it stores

| Holds | Never holds |
| --- | --- |
| publication id | standings |
| publisher credential **hash** | schedules |
| channel id per shard | rosters |
| last shard-state hash and revision | scoring history |
| notification device tokens | QBJ |
| followed team, per device | any private Director state |
| expiry timestamps | the tournament's public snapshot |

`test/push.test.ts` asserts the schema directly — the tables are exactly `publication`, `channel`,
`device`, and no column name contains `standing`, `schedule`, `roster`, `player`, `score`, `qbj`, or
`result`. This service must not become a second tournament database.

## Cadence

| Class | Examples | Coalescing | APNs priority |
| --- | --- | --- | --- |
| Routine | score change, tossup progress | 15 s | 5 |
| Transition | game starts, game final, late room change | prompt | 10 |
| Announcement | Director announcement | its own flow | 10 |

Before enqueueing, the publication object hashes the normalized shard state and drops an unchanged
one. The hash **excludes the revision**: Director's revision advances for reasons that change
nothing on a Lock Screen, and pushing for those would spend the publishing budget on nothing.

## The channel budget

Apple's documented ceiling is **10 000** channels per app per environment. QBSheet's internal
allocation ceiling is **8 000**, leaving a deliberate reserve.

Channels are per **shard of teams** — never per team, never per viewer — and created **lazily**, so
a 64-team tournament where viewers follow teams in three shards consumes three channels. The
modelling is in [`docs/QBLIVE_LOAD.md`](../../docs/QBLIVE_LOAD.md); 500 simultaneous tournaments
consume 1 500 channels.

On exhaustion the client is told, in words, that Lock Screen updates are unavailable and everything
else is working. It is never a 500.

## Deploying

```bash
npm install
npx wrangler queues create qblive-push
npx wrangler queues create qblive-push-dlq

npx wrangler secret put APNS_PRIVATE_KEY   # the .p8 contents, PEM, including BEGIN/END
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_TEAM_ID

npx wrangler deploy
```

Set `APNS_ENVIRONMENT` to `production` in `wrangler.jsonc` for a production build. Channels cannot
be shared across environments, so switching it invalidates every existing channel.

**The `.p8` exists only in this Worker's secrets.** Never in Director, never in a tournament's
Cloudflare deployment, never in the app, never in the App Clip, never in the repository. Nothing
here logs the key, the provider token, or any signing material, and no route returns them.

## If Apple's channel-management port is unreachable

`ChannelManager` has two implementations. If the deployed edge turns out not to reach port 2196 —
see [`docs/QBLIVE_PUSH_PROTOTYPE.md`](../../docs/QBLIVE_PUSH_PROTOTYPE.md) — set
`EXTERNAL_CHANNEL_MANAGER_URL` and `EXTERNAL_CHANNEL_MANAGER_TOKEN` to a small Lambda holding the
same key. Everything else is untouched: publisher auth, the publication objects, dedup, coalescing,
the Queue, and **all broadcast sending**, which is on port 443.

## Testing

```bash
npm test
```

Thirty-nine tests in real `workerd`. What they cannot cover is APNs itself: Apple advertises only
`h2` in ALPN and drops HTTP/1.1, and local `workerd` makes outbound subrequests over HTTP/1.1 — a
documented local-only limitation ([workerd#4841](https://github.com/cloudflare/workerd/issues/4841)).
So the APNs client is driven through an injected `fetch`, and everything that decides *whether* and
*what* to send is tested for real.
