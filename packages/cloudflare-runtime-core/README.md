# `@qbsheet/cloudflare-runtime-core`

Shared low-level primitives for QBSheet's Cloudflare backends: credential mechanics,
SQLite migration and row helpers, replay-cursor math, and hibernating-socket
serialization. This is **not** a QBSheet cloud backend — it holds no tournament data,
no credentials, and no protocol.

## What is shared

| Module           | Contents                                                                     |
| ---------------- | ---------------------------------------------------------------------------- |
| `credentials.ts` | Token minting, SHA-256, constant-time compare, shape checks (WebCrypto only) |
| `replay.ts`      | `after`-cursor parsing, page clamping, honest `resyncRequired` decisions     |
| `sqlite.ts`      | A narrow `SqlDatabase` interface plus typed row readers                      |
| `migrations.ts`  | Append-only versioned migration runner with a `schema_version` journal       |
| `websocket.ts`   | Versioned hibernation attachments and frame-size guards                      |

Consumers: the QBTCP relay (`apps/qbtcp-relay-backend-cloudflare`) and QBLive
(`apps/qblive-backend-cloudflare`) reuse the credential helpers and page clamping
today; the replay, migration, and socket modules are covered for Director
Collaboration (#508) to adopt without taking on scorer or spectator semantics.

## What is deliberately not shared

- **Bearer tokens, Durable Object instances, tables, and routes.** Each service mints,
  stores, and checks its own credentials in its own DO/SQLite namespace. Same-shaped
  tokens never cross-accept (`credentials.test.ts` proves the mechanism; the
  relay/QBLive conformance isolation test proves the deployments).
- **Authorization policy.** Which bearer opens which surface, claim/rotation flows,
  and lifetimes are per-service.
- **Retention rules.** QBLive may trim old public revisions; QBTCP must never trim an
  unacknowledged final because a generic window elapsed. `replay.ts` takes a
  `durableOnly` flag instead of deciding.
- **Frame protocols and CORS.** The relay's scorer frames and QBLive's public routes
  (including their different `json()` CORS postures) stay in each service.
- **Schemas.** The migration runner never sees a `CREATE TABLE` it was not handed.

## Trust levels

```
QBTCP relay             scorer-facing, least trusted callers (room/session capabilities)
QBLive backend          public spectator projection (read-only public, claimed management)
Director Collaboration  trusted staff commands (#508; reuses mechanics, never scorer auth)
```

A compromised room scorer must never become a path to collaboration authority; a
public QBLive client must never reach QBTCP or collaboration state. Sharing this
package shares none of those boundaries.

## Deciding whether a helper belongs here

1. Do at least two services need the exact same behavior (not just a similar name)?
2. Can it be stated without product tables, routes, roles, or retention rules?
3. Can it run in plain Node unit tests with no `cloudflare:*` import?
4. Does it avoid deciding anything a service's threat model owns?

Four yeses: put it here with tests. Anything else stays in the service. When in
doubt, keep the smaller focused utility over growing a framework.
