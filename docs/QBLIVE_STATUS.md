# QBSheet Live — what is verified, and what is not

The completion criteria for this work, answered honestly. Written as a table rather than prose
because "demonstrated" and "implemented but unexercised" are different things, and a reader
deciding whether to ship needs to see which is which.

**Legend**

| | |
| --- | --- |
| ✅ | Executed and observed during this work |
| 🧪 | Covered by an automated test, not by a manual end-to-end run |
| ⛔ | **Not verified.** Needs a credential, an account, or a device this work did not have |

---

## Verified end to end

| # | Criterion | | Evidence |
| --: | --- | :-: | --- |
| 1 | Director creates and opens a real tournament | ✅ | Created "Saturday Invitational" in a browser Director |
| 2 | Director configures QBSheet Live | ✅ | Chose Cloudflare, pasted origin and setup token |
| 3 | A Cloudflare backend is deployed and reachable | ✅ | Real `workerd` via `wrangler dev`. **Not** a deployed Cloudflare account — see below |
| 4 | Director connects to it | ✅ | Exchanged the setup token for a management credential, once |
| 5 | The initial sanitized snapshot publishes | ✅ | Revision 2 on the backend, fetched back and inspected |
| 6 | Privacy tests prove private data is absent | ✅ | 8 192 settings combinations, sentinel absent in all |
| 7 | Director generates the universal public link | ✅ | `https://live.qbsheet.com/t/7xy79f17k60g5fq4143f?b=…&v=1` |
| 8 | Director generates a QR | ✅ | Rendered in Director; the encoder is verified by decoding its own output with `jsqr` |
| 9 | A browser opens that URL into Live Web | ✅ | Loaded the tournament from the backend origin, never from `live.qbsheet.com` |
| 11 | The installed full app handles the same link | ✅ | Loaded and rendered all five tabs on the iOS 27 simulator |
| 12 | A user follows a team with no account | ✅ | Web and iOS. Nothing anywhere asks for an identity |
| 13 | Optional player selection works | ✅ | Web and iOS; highlights rows, verifies nothing |
| 14 | Home shows the correct next actual event | ✅ | Live game with room and tossups; lunch when it is next |
| 15 | No dynamic ETA is invented | ✅ | Asserted in tests on both clients and in the conformance suite |
| 16 | Schedule renders released public games | ✅ | Rounds 1 and 2 with result and live score; the unreleased playoff round is absent |
| 17 | Dynamic standings render | ✅ | Web and iOS, with scope chips and the followed team highlighted |
| 18 | Dynamic statistics render | ✅ | Team and individual tables; an unknown column kind renders from `display` |
| 21 | The backend receives coalesced public progress | ✅ | Section updates carrying only `liveGames` |
| 22 | A live score appears only when Director enables it | ✅ | `liveScores: false` reads "Game in progress" on both clients |
| 30 | Live resynchronizes automatically after an outage | 🧪 | Full outage-and-recovery scenario in `publication.test.ts` |
| 31 | A WebSocket load test with hundreds of viewers succeeds | ✅ | 300 and 800 sockets, 100% delivery, p95 40/50 ms |
| 36 | Channel allocation is per shard, not per user | ✅ | Modelled and tested; 500 tournaments consume 1 500 of 8 000 |
| 40 | Final state stays publicly accessible | 🧪 | Backend test: finalize freezes the publication and keeps serving it |
| 41 | Director can unpublish and delete | 🧪 | Backend tests for both, including that unpublish is recoverable |
| 43 | The existing scorer is unchanged and green | ✅ | 2 141 tests pass; service-worker isolation intact; `pages.yml` untouched |

## Verified by automated test rather than by a manual run

| # | Criterion | | Evidence |
| --: | --- | :-: | --- |
| 19 | QBTCP scoring stays local and independent | 🧪 | Live never reads QBTCP; the local server is a separate listener with no management surface |
| 20 | Director receives live scoring progress | 🧪 | Pre-existing QBTCP behaviour, unchanged. Live reads the resulting document |
| 23 | An accepted result updates public standings | 🧪 | `publication.test.ts`: an accepted result changes `results`, `standings`, `statistics`, `schedule` together |
| 24 | A Director announcement reaches clients | 🧪 | Projection, backend, Web and iOS tests. Not driven through a full manual loop |
| 25–29 | Internet loss: scoring continues, outbox queues, tournament operation unaffected | 🧪 | The outage scenario test, step by step |
| 37 | Channels are cleaned up | 🧪 | Push gateway test; a failed deletion deliberately keeps the channel for the reconciler |
| 42 | Local-only Live Web works without internet | 🧪 | Seven Rust tests over the local server. Not driven from a phone on a real LAN |

## Not verified

| # | Criterion | | Why not, and what remains |
| --: | --- | :-: | --- |
| 3 | Deployed in a real Cloudflare account | ⛔ | No Cloudflare account. The backend runs in real `workerd` against the real `wrangler.jsonc`, which is the same runtime — but not the same network, eviction behaviour, or storage latency. One `wrangler deploy` away. |
| 10 | A physical QR invokes the App Clip on a real iPhone | ⛔ | Needs `live.qbsheet.com` serving the AASA, an Apple Team ID, a signed build, and a registered Advanced App Clip Experience. All four are written and documented; none can be done without the account. |
| 32 | An APNs broadcast channel created through the production path | ⛔ | Needs Apple credentials. The transport was measured as far as it can be without them: ports 2195/2196 are HTTP/2 and answer `MissingProviderToken` in ~230 ms; local `workerd` cannot reach APNs at all, which is a known local-only limitation. See [`QBLIVE_PUSH_PROTOTYPE.md`](QBLIVE_PUSH_PROTOTYPE.md). |
| 33 | A team Live Activity starts | ⛔ | Needs a channel, which needs credentials. The attributes, `ContentState`, both widget extensions, and the coordinator are built and the payload sizes measured. |
| 34 | A broadcast update changes the Activity | ⛔ | Same. |
| 35 | Multiple users share one shard channel | ⛔ | Same. Modelled and unit-tested; not observed. |
| 38 | An ordinary APNs announcement works | ⛔ | Same. Registration, audience routing, dead-token reaping and the interruption-level policy are tested with an injected `fetch`. |
| 39 | An App Clip notification reopens the correct tournament | ⛔ | Same. The mechanism that makes it work — a saved bootstrap, because a notification tap carries no invocation URL — is implemented and documented. |
| — | Deployed-edge reachability of APNs port 2196 | ⛔ | The one remaining architectural unknown. One `wrangler deploy` and one `curl` settles it; if it fails, the fix is `EXTERNAL_CHANNEL_MANAGER_URL` and nothing else changes. |

---

## The four things a maintainer needs to do

1. **A Cloudflare account.** Deploy `apps/qblive-backend-cloudflare` (a director does this for their
   own tournament) and `apps/qblive-push` (QBSheet does this once).
2. **`live.qbsheet.com`.** Host `apps/live-web/dist` and serve
   `.well-known/apple-app-site-association` as `application/json`, no redirect, no extension. The
   build already checks the file's shape; `.github/workflows/live-web.yml` produces the artifact and
   the deploy step is deliberately left unwired rather than invented.
3. **An Apple Developer account.** Replace `TEAMID`, register the App Clip and its Advanced
   Experience, create the APNs key with Broadcast Push enabled, and work through
   [`QBLIVE_IOS.md#13-app-store-connect-checklist`](QBLIVE_IOS.md#13-app-store-connect-checklist).
4. **Run the probe once.** `apps/qblive-push-prototype`, deployed, `GET /reachability`. That is the
   last architectural question outstanding, and it is one request.

## Known limitations that are not gaps

These are design decisions, stated so they are not mistaken for unfinished work.

- **The official App Clip only works from `live.qbsheet.com`.** An App Clip is associated with one
  invocation domain. A self-hoster gets Live Web on their own domain, the full app via their own
  AASA, and complete protocol independence — but not the official Clip. Apple's model, not QBSheet's.
- **Local-network mode advertises no WebSocket.** Director's laptop is running a tournament, not a
  socket server. Clients refresh over a fast local link.
- **Local mode cannot invoke the App Clip.** The association lookup needs the internet. Director says
  so rather than printing a QR that will not work.
- **Windows and Linux cannot store a management credential yet.** They return an explicit error
  rather than writing a plaintext file, because a silent permanent disclosure is worse than asking a
  director to re-enter something. macOS uses the keychain.
- **A Live Activity does not survive a whole tournament day.** ActivityKit ends it; opening the app
  starts a fresh one. The UX is not built around violating that.
- **A conforming server that lies about being caught up is undetectable.** A server returning an
  empty replay page while holding a full history is indistinguishable, over the wire, from one whose
  history really is empty. Documented in the conformance tests rather than papered over.
