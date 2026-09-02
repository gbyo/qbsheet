# QBSheet Live for iOS

Two shipping products and two extensions, sharing one Swift package.

| Target | Kind | Bundle ID |
| --- | --- | --- |
| `QBSheetLive` | App Store application | `com.qbsheet.live` |
| `QBSheetLiveClip` | App Clip | `com.qbsheet.live.Clip` |
| `QBSheetLiveActivity` | Widget extension (full app) | `com.qbsheet.live.Activity` |
| `QBSheetLiveClipActivity` | Widget extension (App Clip) | `com.qbsheet.live.Clip.Activity` |
| `QBSheetLiveKit` | Swift package | — |

**Minimum: iOS 18.0.** QBSheet Live uses ActivityKit broadcast push channels, which are iOS 18 and
later. No pre-18 compatibility is carried for Live alone.

---

## 1. The shared package

`ios/QBSheetLiveKit` holds everything both products use: QBLive models, the client, the WebSocket,
persistence, the bootstrap parser, all five screens, and the Live Activity state derivation.

It has **no dependencies**, and that is a requirement rather than a coincidence. The App Clip has a
15 MB thinned budget, and the surest way to blow one is to let a shared layer acquire a dependency
nobody re-measured. Everything is Foundation, SwiftUI, ActivityKit and WidgetKit.

## 2. Building

```bash
brew install xcodegen
cd ios && xcodegen generate
open QBSheetLive.xcodeproj
```

`project.yml` is the source of truth. `QBSheetLive.xcodeproj` is committed so a contributor with only
Xcode can open it, but a change made in Xcode's target editor and not made in `project.yml` is lost
on the next regeneration.

```bash
# The shared kit's tests, on a simulator
xcodebuild test -scheme QBSheetLiveKit -destination 'platform=iOS Simulator,name=iPhone 17 Pro'

# The App Clip size gate
./ios/scripts/measure-app-clip.sh
```

## 3. The universal QR

One code per tournament:

```
https://live.qbsheet.com/t/<publicationId>?b=<backend origin>&v=1
```

| Device | Result |
| --- | --- |
| iPhone without the app | App Clip card → App Clip |
| iPhone with the app | Full app, via universal link |
| Android | QBSheet Live Web |
| Desktop, Chromebook | QBSheet Live Web |

`live.qbsheet.com` is a *bootstrap*. It says where the tournament's own backend is and then gets out
of the way; every byte of tournament data is fetched from `b`. The QR contains public routing
information and nothing else — no management token, no QBTCP credential, no APNs secret. A QR code
gets photographed and reposted, and treating one as a bearer credential cannot be walked back once
it is printed.

`QBLiveBootstrap` is the single parser for all four entry points (universal link, App Clip
invocation, notification tap, saved bootstrap). Four parsers would be four chances to accept
something the others reject. It refuses `javascript:`, `data:`, `file:`, embedded userinfo, a path,
a query, a fragment, an over-long value, and plain HTTP anywhere but the private ranges — the last
being Director's local-only LAN mode.

## 4. Associated domains

Entitlements:

```
applinks:live.qbsheet.com     (full app — claims the link)
appclips:live.qbsheet.com     (both — allows App Clip invocation)
```

AASA at `https://live.qbsheet.com/.well-known/apple-app-site-association`, `application/json`, no
redirect, no extension. It authorizes **`/t/*` only** — `live.qbsheet.com` also serves Live Web and
pages meant to open in a browser, and claiming `*` would route all of them into the app.

Source: [`apps/live-web/public/.well-known/`](../apps/live-web/public/.well-known/). Replace `TEAMID`
before shipping; it has to match the entitlements or nothing works and the failure is silent.

### The arbitrary-domain limitation

**The official App Clip can only be invoked from `live.qbsheet.com`.** An App Clip is associated with
one invocation domain, and that domain is QBSheet's.

A tournament director who self-hosts everything still gets: QBLive Web on their own domain, the full
app handling their links if they publish their own AASA, and complete protocol independence. What
they do not get is the official App Clip from their own domain. This is Apple's model, not a QBSheet
decision, and it is stated plainly here rather than discovered later.

## 5. First launch

```
scan → App Clip card → Open → tournament loads → follow a team → optional player → Home
```

No account, no email, no password, no profile creation, no role selection, no tutorial carousel.

**Following a team is personalization, not authorization.** A parent, a coach, a player and a
stranger can all follow any public team. Selecting a player highlights their rows and shows their
placement; it verifies nothing, unlocks nothing, and reveals nothing that was not already public.

Both choices live in the App Group container, so a spectator who used the App Clip and then installs
the full app finds their team already followed — iOS migrates the group container on install.

## 6. App Groups

`group.com.qbsheet.live`, on all four targets. Three processes need the same data: the app, the Clip,
and the Live Activity extension. It is also what makes the Clip → full app transition seamless.

Stored: the last bootstrap, the followed team, the selected player, the last snapshot per tournament,
and the current Activity channel id. **No credentials** — QBSheet Live has no account to have one for.

## 7. Realtime

Foreground, in order: WebSocket → event replay → snapshot reload. A backend that advertises no
stream gets 30-second polling. Reconnects use full jitter, because every phone in a gym loses the
same access point at the same moment.

Backgrounding stops the networking. Background glanceable state is the Live Activity's job; a poll
loop behind a screen nobody is looking at is a spectator's battery spent on nothing.

`.refreshable` on every tab.

## 8. Live Activities

See [`docs/QBLIVE_ACTIVITY.md`](QBLIVE_ACTIVITY.md) for sharding and payload measurements.

The short version: one broadcast channel per **shard of teams**, subscribed with
`pushType: .channel(id)`. The followed team is a static attribute; the shard's state is the broadcast
`ContentState`; the view renders one entry. Channel count scales with active shards, never with
viewers.

Everything degrades gracefully. If Live Activities are off, if the tournament has not enabled Apple
push, or if Apple's global channel budget is exhausted, the app, the Clip, the web client, foreground
realtime, schedules, standings, statistics and results all keep working, and
`LiveActivityCoordinator.explanation` says which of those happened.

## 9. App Clip notifications

The Clip declares `NSAppClipRequestEphemeralUserNotification`, which gives it an eight-hour
notification window with no permission prompt — the right shape for somebody who scanned a code an
hour ago and needs to hear about a room change.

**A notification tap does not always carry the original invocation URL.** That is why
`LivePersistence.lastBootstrap` is written on every open and read on every launch: without it, a tap
would reopen the Clip on a blank screen. The gateway also includes the publication id in the
notification payload so routing is unambiguous when the URL is present.

## 10. Accessibility

Dynamic Type throughout — no fixed sizes, and `ViewThatFits` where a horizontal detail row would
otherwise truncate at accessibility sizes. VoiceOver labels on every composite: a standings row is
announced as "Team Ninety Six A, W–L 7-1, PPB 18.40", built from the server's own column labels so a
statistic added in Director is announced correctly without an app release. Dark Mode and Reduce
Motion come from stock components. Times use the device's own 12/24-hour preference, in the
tournament's zone.

## 11. Development affordances

Two `#if DEBUG` mechanisms exist because a universal link cannot work before the domain does:

- **`qbsheetlive://t/<id>?b=<origin>`** — a custom scheme, rebuilt into the https form so the same
  parser and the same validation run.
- **`-qblive-bootstrap`, `-qblive-team`, `-qblive-player`, `-qblive-tab`, `-qblive-reset`** — launch
  arguments, for scripted screenshots. A simulator has no way to tap.

Neither ships. A custom scheme is claimable by any app on the device; a universal link is not, which
is exactly why the release build uses only the latter.

```bash
xcrun simctl launch "iPhone 17 Pro" com.qbsheet.live \
  -qblive-bootstrap "https://live.qbsheet.com/t/<id>?b=http%3A%2F%2F127.0.0.1%3A8788&v=1" \
  -qblive-team team-a -qblive-tab standings
```

## 12. App Store Connect checklist

- [ ] App ID `com.qbsheet.live` with **Associated Domains**, **Push Notifications**, **App Groups**.
- [ ] App Clip ID `com.qbsheet.live.Clip` registered as an App Clip of the above.
- [ ] App Group `group.com.qbsheet.live` created and assigned to all four targets.
- [ ] `TEAMID` replaced in the AASA file and both entitlements files.
- [ ] AASA served from `live.qbsheet.com` as `application/json`, no redirect, verified with `curl -I`.
- [ ] **Advanced App Clip Experience** registered for `https://live.qbsheet.com/t/*`, with the App
      Clip Code / QR image, title and subtitle. Without this the Clip does not appear from a code.
- [ ] `aps-environment` set to `production` for the release build (the committed value is
      `development`).
- [ ] APNs authentication key (`.p8`) created, and **Broadcast Push** enabled for the App ID. The key
      goes into `push.qbsheet.com`'s Worker secrets and nowhere else — never into Director, never
      into a tournament's Cloudflare deployment, never into the app.
- [ ] App Privacy: QBSheet Live collects no personal data, has no account, and uses no third-party
      analytics. The tournament data it displays is published by the tournament, not by QBSheet.
- [ ] `./ios/scripts/measure-app-clip.sh` green against a real thinned archive, not just a
      simulator build.
- [ ] Screenshots and an App Clip card image.
