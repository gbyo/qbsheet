# QBLive backend — Cloudflare reference implementation

A Cloudflare Worker and SQLite Durable Object that serves [QBLive v1](../../docs/QBLIVE.md) for one
tournament.

**This runs in the tournament director's own Cloudflare account.** QBSheet does not operate it, has
no credentials for it, and does not pay for its traffic. Spectator load belongs to the tournament
that created it.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gbyo/qbsheet/tree/main/apps/qblive-backend-cloudflare)

---

## What it costs

A Workers Paid plan. One tournament is one Durable Object holding a few hundred kilobytes; the
WebSockets hibernate between updates, so a room full of idle phones accrues no duration charge. A
one-day tournament with a few hundred spectators is well inside the paid plan's included usage.

The free plan does not include Durable Objects, so this template needs Workers Paid. A director who
does not want a Cloudflare account can use Director's [local-only mode](../../docs/QBLIVE.md#14-local-only-mode)
or any other QBLive-compatible host.

## Deploying

1. Click **Deploy to Cloudflare** above. Cloudflare clones the repository, reads `wrangler.jsonc`,
   provisions the Durable Object, and deploys.
2. Set the one-time setup token as a secret:

   ```bash
   wrangler secret put QBLIVE_SETUP_TOKEN
   ```

   Paste any long random string. Director asks for it once and then never needs it again.
3. Copy the deployed Worker URL (`https://qblive-backend.<subdomain>.workers.dev`).
4. In Director: **QBSheet Live → Set up with Cloudflare**, paste the URL and the setup token.

Director exchanges the setup token for a durable management credential, stores that credential in
the operating system keychain, and the setup token becomes worthless. It cannot be exchanged twice.

## Deploying by hand

```bash
npm install
npx wrangler secret put QBLIVE_SETUP_TOKEN
npx wrangler deploy
```

## Endpoints

Public, unauthenticated, CORS `*`:

```
GET /qblive/v1/tournaments/{publicationId}/manifest
GET /qblive/v1/tournaments/{publicationId}/snapshot
GET /qblive/v1/tournaments/{publicationId}/events?after={revision}&limit={n}
GET /qblive/v1/tournaments/{publicationId}/stream        WebSocket
```

Authenticated with the management credential:

```
POST   /qblive/v1/manage/claim
PUT    /qblive/v1/manage/tournaments/{id}/snapshot
POST   /qblive/v1/manage/tournaments/{id}/sections
POST   /qblive/v1/manage/tournaments/{id}/announcements
POST   /qblive/v1/manage/tournaments/{id}/finalize
POST   /qblive/v1/manage/tournaments/{id}/unpublish
DELETE /qblive/v1/manage/tournaments/{id}
```

The public routes are read-only: a `PUT` to one is answered `405`, credential or not.

## What it stores

Only the sanitized public projection Director sends it — the same JSON any spectator can fetch —
plus a replay window of the last 256 revisions and a SHA-256 hash of the management credential.
It never sees the tournament's private state; see
[the projection boundary](../../docs/QBLIVE.md#9-the-public-projection-is-a-boundary).

## Development

```bash
npm install
npm test          # runs inside real workerd against the real wrangler.jsonc
npm run dev
```

`src/protocol/` is generated from `packages/qblive-protocol` so this directory is self-contained and
deployable straight from the repository — "Deploy to Cloudflare" cannot resolve monorepo workspace
packages. `npm run check-protocol` fails when the copy has drifted, and CI runs it.
