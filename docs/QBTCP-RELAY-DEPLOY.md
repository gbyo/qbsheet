# Internet QBTCP: tournament-owned relay deployment guide

This is the reference deployment path for `apps/qbtcp-relay-backend-cloudflare`: a
Cloudflare Worker plus SQLite Durable Object that relays QBTCP for one tournament. The
normal setup ends with a stable `https://…workers.dev` endpoint, a claimed Director
management connection, pairing QR codes that use that endpoint as the primary scoring
address, and LAN fallback where the venue network allows it.

## Who operates what

The relay is **hosted in the tournament's Cloudflare account**. QBSheet does not operate
it, does not receive its traffic, does not bill for it, and requires no QBSheet account.
Setup copy uses language such as _Internet QBTCP_, _tournament relay_, _hosted in your
Cloudflare account_, _primary scoring address_, and _LAN fallback_ — never _QBSheet
Cloud_, _QBSheet servers_, _upload tournament to QBSheet_, or _QBSheet account required_.

## Deploying (reference path, no custom domain)

1. In Director, open Rooms → **Internet QBTCP** and choose to enable it. Read the
   ownership note: the relay will live in a Cloudflare account the tournament controls.
2. Click **Deploy to Cloudflare** in
   [`apps/qbtcp-relay-backend-cloudflare`](../apps/qbtcp-relay-backend-cloudflare/README.md).
   Cloudflare clones the repository, provisions the Durable Object, and deploys.
3. Set the one-time setup secret:
   ```bash
   wrangler secret put RELAY_SETUP_TOKEN
   ```
   Paste any long random string. Director asks for it once and never again.
4. Copy the deployed Worker URL (`https://<name>.<subdomain>.workers.dev`). No custom
   domain is required; one can be added later as an advanced setting.
5. Back in Director, enter the relay address, the 24-character tournament id from
   deployment, and the one-time setup secret, then **Claim and validate**.

Director validates before reporting ready — HTTPS reachability, QBTCP discovery with the
`stream` capability and the finals-retention contract, the management connection, an
initial state publication, and the realtime endpoint — and only then marks Internet QBTCP
ready. A bare HTTP 200 never counts.

## Claim security

- The setup secret is exchanged exactly once for a long-lived management credential.
- The relay stores only a hash; the plaintext leaves the relay once, in the claim
  response.
- Director keeps the credential in the operating-system keychain, never in the tournament
  file, a URL, a QR code, an export, logs, or diagnostics.
- After a successful claim the setup secret is worthless, even if it leaks.
- Rotate with **Rotate credential** (needs the current credential; state is untouched).
- If the credential is lost: export unacknowledged finals, destroy the relay tournament,
  and claim again. Director refuses a silent destroy while unacknowledged finals remain.

## Pairing

Internet-enabled rooms get one pairing QR/link using the relay as `server=`. The LAN
address stays attached to the same room as fallback — never a second pairing. The code
travels in the URL fragment (never sent to a server), and regenerating a code invalidates
the old one on both transports, because both check the same mirrored pairing state.

## Operating

The status surface stays quiet when healthy and names an action otherwise: relay
unreachable, unsupported version, refused credential, failing publication, resource
pressure from the relay's own estimates, LAN fallback unavailable, local-network
permission issues, or a QBLive Worker sharing the relay's Cloudflare account (detected by
matching origins; anything subtler is documented, not guessed).

## Failure budget: keep spectator traffic away from scoring

Do not rely on the same Workers Free request budget for high-traffic spectator Workers
and Internet QBTCP. The 100,000-request/day allowance is account-level: a busy spectator
Worker and scoring draw from the same pool, and when it is exhausted, scoring stops with
it. Prefer the self-hosted QBServer for QBLive (see #769); if other high-volume Workers
must run, isolate scoring in its own Cloudflare account or paid capacity. A dedicated
account is guidance about the actual failure budget, not a mathematical requirement —
paid plans change the arithmetic, and the relay's `manage/health` estimates show the burn
rate either way.

## Disabling and teardown

**Disable** stops Director publication and sync; local and LAN QBTCP keep serving the same
rooms, local scorer games are untouched, and the relay keeps what it retains. **Destroy**
deletes the remote tournament and is fenced: with unacknowledged finals on the relay,
Director requires an export plus an explicit reviewed override first. Never destroy to
"clean up" before confirming every final is ingested or safely recorded elsewhere.

## Diagnostics

The diagnostics view carries the relay URL, protocol and versions, revisions, request and
write counters, connection transitions, error codes, and LAN fallback state — and no
credentials, pairing codes, QBJ payloads, or student/player data. Anything secret-shaped
is redacted before it can reach a bundle.

## Reference

- Relay implementation and endpoint list:
  [`apps/qbtcp-relay-backend-cloudflare`](../apps/qbtcp-relay-backend-cloudflare/README.md)
- Protocol: [`QBTCP.md`](QBTCP.md) and [`QBTCP-STREAM.md`](QBTCP-STREAM.md)
- Director sync and replay semantics: issue #773 (the sync engine owns the ongoing mirror
  projection and the replay cursor; setup here proves the path once)
- Scorer transport preference: issue #772 (consuming the Internet `server=` address)
