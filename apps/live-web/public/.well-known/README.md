# Apple association files

`live.qbsheet.com` is a static bootstrap and spectator client deployed as a Cloudflare Workers
Static Assets project. There is no Worker request handler: Cloudflare serves `apps/live-web/dist`
directly, and the `single-page-application` fallback returns Vite's `index.html` for `/t/*` while
preserving the bootstrap URL for the browser parser. Tournament data continues to travel directly
between the browser or iOS client and the tournament's own QBLive backend.

Cloudflare's Git integration owns production deployment. From the repository root, configure:

```text
Build command:  npm run test --workspace=@qbsheet/live-web && npm run build --workspace=@qbsheet/live-web
Deploy command: npx wrangler deploy --config apps/live-web/wrangler.jsonc
```

`apple-app-site-association` must be served from `https://live.qbsheet.com/.well-known/` as
`application/json`, with a `200` response, over HTTPS, **without a redirect**, and without a file
extension. Apple's CDN fetches it; a redirect or the wrong content type makes universal links and
the App Clip both fail, and the failure looks like "the link opens Safari instead of the app".
`public/_headers` preserves that content type when Vite copies these files into `dist`.

## Before shipping

Replace `TEAMID` with the real Apple Developer Team ID in both `appIDs` and `appclips.apps`. The same
identifier has to appear in `ios/QBSheetLive/QBSheetLive.entitlements` and
`ios/QBSheetLiveClip/QBSheetLiveClip.entitlements`; if those disagree with this file, nothing works
and the error is silent.

Verify after deploying:

```bash
curl -sI https://live.qbsheet.com/.well-known/apple-app-site-association | head -5
# HTTP/2 200
# content-type: application/json
```

This static deployment is separate from both kinds of dynamic Worker: `push.qbsheet.com` remains
QBSheet's APNs gateway, while each tournament's QBLive backend remains in infrastructure controlled
by its tournament or director.

## Why `/t/*` and not `*`

`live.qbsheet.com` also serves QBSheet Live Web itself, and pages that should open in a browser.
Claiming `*` would route every one of them into the app. `/t/*` is exactly the tournament route.

## App Clip invocation

The App Clip is associated with `live.qbsheet.com` and only with it. A tournament director who
self-hosts Live Web on their own domain gets the web client, and gets the installed full app through
that domain if they configure their own AASA — but **not** the official App Clip, which can only be
invoked from QBSheet's own invocation domain. See `docs/QBLIVE_IOS.md`.
