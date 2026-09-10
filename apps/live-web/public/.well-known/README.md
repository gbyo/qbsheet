# Apple association files

`apple-app-site-association` must be served from `https://live.qbsheet.com/.well-known/` as
`application/json`, over HTTPS, **without a redirect**, and without a file extension. Apple's CDN
fetches it; a redirect or the wrong content type makes universal links and the App Clip both fail,
and the failure looks like "the link opens Safari instead of the app".

## The Team ID

`appIDs` and `appclips.apps` name Team ID `57CW34C9J4`, and they have to keep agreeing with
`DEVELOPMENT_TEAM` in `ios/project.yml`. The entitlements files need no Team ID of their own — they
use `$(AppIdentifierPrefix)`, which the signing team supplies at build time. If this file and the
signed build disagree, nothing works and the error is silent.

Verify after deploying:

```bash
curl -sI https://live.qbsheet.com/.well-known/apple-app-site-association | head -5
# HTTP/2 200
# content-type: application/json
```

## Why `/t/*` and not `*`

`live.qbsheet.com` also serves QBSheet Live Web itself, and pages that should open in a browser.
Claiming `*` would route every one of them into the app. `/t/*` is exactly the tournament route.

## App Clip invocation

The App Clip is associated with `live.qbsheet.com` and only with it. A tournament director who
self-hosts Live Web on their own domain gets the web client, and gets the installed full app through
that domain if they configure their own AASA — but **not** the official App Clip, which can only be
invoked from QBSheet's own invocation domain. See `docs/QBLIVE_IOS.md`.
