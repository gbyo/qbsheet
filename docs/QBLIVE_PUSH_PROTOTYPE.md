# APNs channel-management prototype result

**Question.** QBSheet Live's remote Live Activity updates use ActivityKit broadcast push channels.
Creating and deleting those channels uses an APNs endpoint on a **non-standard port**. Before
building the production push service on Cloudflare, can a Cloudflare Worker actually talk to it?

**Answer.** Yes for the high-volume path, with one measurement that requires a Cloudflare account to
complete. Details and evidence below. **No part of QBSheet Live's architecture changes either way** —
see [§5](#5-the-fallback-if-the-remaining-measurement-fails).

Prototype: [`apps/qblive-push-prototype`](../apps/qblive-push-prototype).

---

## 1. The two APNs surfaces

Established from Apple's current documentation
([channel management](https://developer.apple.com/documentation/usernotifications/sending-channel-management-requests-to-apns),
[broadcast send](https://developer.apple.com/documentation/usernotifications/sending-broadcast-push-notification-requests-to-apns)):

| Operation | Host | Port | Frequency |
| --- | --- | --- | --- |
| Send a broadcast (`POST /4/broadcasts/apps/{bundleId}`) | `api.push.apple.com` | **443** | thousands per tournament |
| Create / read / list / delete a channel (`/1/apps/{bundleId}/channels`) | `api-manage-broadcast.push.apple.com` | **2196** | a handful per tournament |
| Same, sandbox | `api-manage-broadcast.sandbox.push.apple.com` | **2195** | |

This split is the single most important fact for the architecture, and it is good news: **the
non-standard port is only on the rare lifecycle path.** Every score update goes over ordinary
HTTPS.

## 2. What was measured, and how

`apps/qblive-push-prototype/scripts/measure-transport.sh`, run 2026-09-02:

```
TARGET                 PROTOCOL   STATUS   TIME       BODY
production-send        HTTP/2     405      0.076s     {"reason":"MethodNotAllowed"}
production-manage      HTTP/2     403      0.230s     {"reason":"MissingProviderToken"}
sandbox-send           HTTP/2     405      0.243s     {"reason":"MethodNotAllowed"}
sandbox-manage         HTTP/2     403      0.229s     {"reason":"MissingProviderToken"}

HTTP/1.1 negotiation (expected to fail: APNs advertises only h2 in ALPN):
  production-send        connection refused or dropped (as expected)
  production-manage      connection refused or dropped (as expected)
  sandbox-send           connection refused or dropped (as expected)
  sandbox-manage         connection refused or dropped (as expected)

ALPN advertised by the management host:
  ALPN protocol: h2
```

An APNs JSON error is the *success* signal here. `MissingProviderToken` means the request completed
a TLS handshake, negotiated HTTP/2, was routed, and was answered by APNs. Only the credential was
missing, which is not a transport question.

### 2.1 Findings

1. **The non-standard ports are ordinary HTTP/2 endpoints.** Ports 2195 and 2196 are TLS 1.3 with
   `h2` in ALPN, and answer in well under half a second.
2. **APNs advertises only `h2`.** A client offering `http/1.1` gets no agreed protocol, sends its
   request anyway, and receives what curl reports as `HTTP/0.9` — that is, Apple drops it. Anything
   speaking HTTP/1.1 sees a dropped connection, never a status code.

## 3. Local `wrangler dev` cannot do this, and that is not the answer to the question

Running the prototype's `/reachability` route under `wrangler dev` locally:

```json
{ "step": "send-host",   "status": 0, "transportError": "Error: Network connection lost." }
{ "step": "manage-host", "status": 0, "transportError": "Error: Network connection lost." }
```

Both failed — including `api.push.apple.com` on port **443**. Since port 443 is not in question,
this is not a port problem. It is finding 2 above: local `workerd` makes outbound subrequests over
HTTP/1.1, and Apple drops HTTP/1.1.

This is a known, tracked, local-only limitation:
[cloudflare/workerd#4841 — "APNS HTTP/2 Requests via fetch() Failing on macOS but Working in
Workers"](https://github.com/cloudflare/workerd/issues/4841). Deployed Cloudflare Workers use
HTTP/2 for `fetch` subrequests, and APNs-from-Workers is an established, working pattern with
multiple production libraries built on it.

**Consequence for this repository:** the push service's APNs paths cannot be integration-tested in
local `workerd`, and pretending otherwise with a mock would test nothing. The prototype's
`/reachability` route exists so the measurement can be taken from the deployed edge in one request.

## 4. What is still unproven, and why

| Claim | Status |
| --- | --- |
| Ports 2195/2196 are reachable HTTP/2 endpoints | **Measured** (§2) |
| APNs rejects HTTP/1.1 | **Measured** (§2) |
| Local `wrangler dev` cannot reach APNs | **Measured** (§3) |
| Deployed Workers speak HTTP/2 to origins | Documented, corroborated by working third-party implementations; not measured here |
| Deployed Workers honour a **non-standard port** to a non-Cloudflare host | Documented (`allow_custom_ports`, default since 2024-09-02, "any port" for non-Cloudflare hosts); **not measured** |

The last row is the one that needs a Cloudflare account, which this work did not have. Completing it
is one command and one HTTP request:

```bash
cd apps/qblive-push-prototype
npx wrangler deploy
curl -s "https://qblive-push-prototype.<subdomain>.workers.dev/reachability?environment=production"
```

Read `results[].transportError`. `null` on both, with any HTTP status, settles it. A non-null
`transportError` on `manage-host` only — with `send-host` clean — is the specific failure that
triggers §5.

With real Apple credentials, `POST /probe` runs the full lifecycle — mint token, create channel,
read, list, send a broadcast, delete channel — and reports each step's status, Apple request id, and
elapsed time.

## 5. The fallback, if the remaining measurement fails

**QBSheet is not redesigned.** The scope of the change is one interface.

Channel lifecycle is a handful of calls per tournament and is already isolated behind
`ChannelManager` in the push gateway. If the deployed edge cannot reach port 2196, that interface
gets a second implementation that forwards `create` and `delete` to a small AWS Lambda holding the
same APNs key, and the Worker keeps doing everything else — publisher auth, the publication Durable
Object, dedup, coalescing, the Queue, and **all broadcast sending**, which is on port 443 and
unaffected.

Unchanged in that scenario: QBLive, the tournament backends, Director, Live Web, the iOS app, the
App Clip, and the Live Activity.

## 6. Other things the prototype established

- **Provider tokens can be minted inside `workerd`.** ES256 over P-256 with WebCrypto
  (`crypto.subtle.importKey('pkcs8', …)` and `sign`), no Node crypto and no JWT library. See
  `createProviderToken` in [`src/apns.ts`](../apps/qblive-push-prototype/src/apns.ts).
- **Message storage policy is fixed at channel creation and cannot be changed.** QBSheet Live uses
  `MostRecentMessageStored` (`1`): a phone in a pocket during a round should show the current score
  when it comes out, not a blank Activity. Apple stores the most recent message for up to 8 hours.
- **Broadcast payloads are capped at 5 120 bytes.** Measured shard sizing is in
  [`docs/QBLIVE_ACTIVITY.md`](QBLIVE_ACTIVITY.md).
- **Channel ids are opaque base64 of unspecified length.** The gateway stores them as strings and
  never parses or assumes a length, as Apple's documentation asks.
- **A channel outlives its subscribers.** It counts against the 10 000 per-app-per-environment limit
  whether or not anybody is subscribed, which is why the gateway creates lazily and reconciles
  deletions rather than assuming an idle channel disappears.
