# QBSheet Bridge (QBBridge)

A small tournament utility that lets stock [YellowFruit](https://github.com/ANadig/YellowFruit) run
the tournament while QBSheet Scorer runs the rooms.

```text
YellowFruit  →  QBSheet Scorer  →  YellowFruit
```

QBBridge loads a `.yft`, lets the operator say who is playing where, publishes one ordinary QBJ
assignment per room to the existing Internet QBTCP Cloudflare relay, and writes the completed QBJ
each room sends back into a folder. The operator imports those files with YellowFruit's own
**File → Import Games Only**.

It is **not** Director. It keeps no standings, no statistics, no schedule, no bracket, and no
tournament state of its own. Where a design choice existed between QBBridge knowing something and
letting the operator or YellowFruit know it, the operator or YellowFruit knows it.

## Tournament day

**Before the tournament**

1. Create and configure the tournament in YellowFruit.
2. Save the `.yft`.
3. Deploy the QBTCP relay (see [`docs/QBTCP-RELAY-DEPLOY.md`](../../docs/QBTCP-RELAY-DEPLOY.md)) and
   note its URL, its tournament id, and its one-time setup token.
4. Open **QBSheet Bridge**.
5. Load the `.yft`.
6. Connect the relay.
7. Add a room for each room in use.
8. Optionally, plan the rounds: choose a round, fill in its rooms, choose the next, and so on. Each
   round keeps its own matchups, so a whole set of prelims can be entered the night before. The
   count beside the round selector (`Round 1 · 6 games planned`) says how many games each round
   has planned. It is deliberately not a fraction: QBBridge does not know how many games a round
   should contain, so an idle room never makes a correct round look incomplete.

**Each round**

1. Choose the round.
2. Pick the two teams for every room, or check the ones already planned.
3. Click **Publish Round**.
4. Scorekeepers scan the room's QR or type its pairing code into ordinary QBSheet Scorer.
5. Games are scored normally. The scorer already has the format; nobody sets one up in a room.

**After games finish**

1. Completed results appear in QBBridge as they arrive.
2. Choose a results folder and click **Save New Results**.
3. In YellowFruit choose **File → Import Games Only** (Cmd/Ctrl+M).
4. Select the saved `.qbj` files.
5. Review YellowFruit's normal import validation and import them.

## What comes from the `.yft`

QBBridge reads the file through QBSheet's existing importer
(`packages/tournament-formats/src/yft.ts`). It writes no second parser and it never writes to the
file. From the import it takes the tournament id and name, the teams and their identifiers, the
players and their identifiers, the school registrations, the phases, the rounds, the pools (for
display), and the structural scoring rules.

It takes nothing from standings, rankings, advancement, schedule templates, final placements, or
the games already in the file.

Roster or format edits made in YellowFruit reach QBBridge when the operator saves there and clicks
**Reload YellowFruit File**. That is a reread, not synchronization, and it is not described as one.

### Why the scoring rules need a step of their own

A `.yft` does not write down everything a scorer has to know, because YellowFruit answers some of
it from code. `packages/tournament-formats/src/yftScoringRules.ts` completes the stored block into
assignment-grade QBJ, deriving each answer exactly the way YellowFruit derives it:

| Not in the file                          | How YellowFruit answers it                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `awards_bonus` on each answer type       | Never serialized; a positive tossup earns a bonus when the format has bonuses, and a non-positive one may not.         |
| Whether bonuses are used at all          | Not a field. The whole bonus block is omitted when they are not, so the presence of `maximum_bonus_score` is the flag. |
| `regulation_tossup_count`                | A getter written only to QBJ exports: a timed round reports YellowFruit's nominal default, an untimed one its maximum. |
| An answer type's `label` / `short_label` | Written only when overridden; otherwise the point value.                                                               |
| Timed                                    | Not QBJ at all — `scoring_rules.YfData.timed`, which travels in the `_qbtcp` extension.                                |

Nothing anywhere branches on `ScoringRules.name`. A tournament called `NaqtUntimed` whose answer
types have been edited is that edited format.

Stock YellowFruit stores no timed-round _duration_, so QBBridge sends none and the moderator calls
time.

## Pairings

Stock YellowFruit's saved file carries no authoritative list of future room-by-room pairings to
publish, so QBBridge owns a small manual table.

There is no round-robin generation, no automatic pairing, no bracket, no advancement, and no
schedule-legality engine. There are four cheap warnings — an empty room, a team against itself, a
duplicate room name, a team in two rooms this round — and none of them blocks a publish.

### Rooms and round plans are different things

A **room** is physical: a room in a building, a pairing code on a sheet taped to its door, and
whatever assignment the relay is currently serving for it. It persists for the whole tournament.

A **round plan** is intent: which two teams are meant to play in which room, in one round. Each
round has its own, they are saved on this computer, and switching rounds is a read — go back to
round 2 and round 2's entries are exactly as they were left. Plans hold room ids and team ids and
nothing else: no names, no pools, no match ids, no revisions, no publication flags. Everything else
is owned either by the `.yft`, which is reread and authoritative, or by the room, which is what the
relay actually accepted.

**Only the round you publish reaches QBTCP.** Publishing round 1 builds its assignments from round
1's plan, leaves every plan untouched, and clears every room that round 1 does not use. Planning
round 7 sends nothing anywhere.

Because the two are separate, each room shows two badges. The first is about the room and the relay
— Not published, Ready to pair, Waiting, Result received. The second compares the round on screen
with what the relay holds: **Planned** (entered, never sent), **Live** (the relay is serving exactly
this), **Edited since publish** (it was sent, then changed), and **Relay holds another round** (this
room is serving a different round's game). That last one is why the second badge exists: while round
1 is live every room reads Waiting, and without it round 7 would look published the moment you
selected it.

### Reloading the `.yft` after the plans exist

YellowFruit stays authoritative for rounds, teams, and their identities. On a reload, saved plans
are reconciled against it **by stable id only**: a plan for a round that no longer exists is
dropped, an entry for a room that no longer exists is dropped, a team id that no longer exists
clears that side, and a pairing left with nothing in it is deleted. One notice says what was lost.

Nothing is ever repaired by matching a team name, a room name, a round's display label, an array
index, a pool seed, or a position. A wrong guess there is not a cosmetic error — it is a real,
correctly formatted assignment sending two teams to play a game nobody scheduled. Clearing a side
costs one dropdown; guessing costs a round.

Playoffs use the same mechanism by hand: reload the `.yft` once YellowFruit knows who advanced, then
enter the playoff rounds. QBBridge does not predict advancement, and it does not generate a schedule
from YellowFruit's pool metadata.

### Why planned pairings are never written back to YellowFruit

They stay local QBBridge intent, and QBBridge still hands YellowFruit only completed QBJ result
files. Stock YellowFruit's **Import Games Only** appends what it imports, and it can duplicate an
unplayed `Match` that is already in the file — so writing preplanned games back would corrupt the
file QBBridge exists to leave alone. See #959.

## What reaches a room

Each room gets a normal one-game QBJ serialization (version `2.1.1`) that follows
[`docs/QBJ_ASSIGNMENT_PROFILE.md`](../../docs/QBJ_ASSIGNMENT_PROFILE.md): one `Tournament`, the
`ScoringRules`, the two `Registration`s, the two `Team`s and their `Player`s, the `Phase`, the
`Round`, and exactly one unplayed `Match`. No other room, no other round, no standings, no scores,
and nothing credential-shaped.

Identifiers come from YellowFruit and are preserved, which is what makes a returned result a lookup
rather than a name match. The `Match.id` for a pairing is derived from the tournament, the round,
the room and the two teams, so republishing an unchanged pairing keeps it and changing the matchup
does not reuse it.

`Round.name` is YellowFruit's own spelling — usually a bare number. Its importer resolves a round by
running `parseInt` over that field, so `"4"` is never rewritten to `"Round 4"`.

## The relay

QBBridge speaks to the relay that already exists
(`apps/qbtcp-relay-backend-cloudflare`), hosted in the tournament's own Cloudflare account. It
deploys no Worker, forks no protocol, and makes four calls:

```text
POST /qbtcp/v1/manage/claim
PUT  /qbtcp/v1/manage/tournaments/{id}/mirror
GET  /qbtcp/v1/manage/tournaments/{id}/results?state=unacked
```

```text
POST /qbtcp/v1/manage/tournaments/{id}/acks
```

### Why results are acknowledged, and exactly when

`GET results?state=unacked` answers with the oldest **128** unacknowledged results and carries no
cursor or offset. A build that never acknowledged anything would, at result 129, hold a result it
could never reach by polling — a silent ceiling, which is the worst kind.

So a result is acknowledged **only after its bytes are on the operator's disk**, never because it
arrived and never because it was displayed. The lifecycle is: result arrives → it remains unacked
while displayed → the local QBJ write succeeds → its result id is acknowledged. `unacked` therefore
means "not yet saved locally": a queue that drains, and that cannot fill up while results are being
saved. If the acknowledgment call itself fails, the local save still stands; the result is simply
offered again on a later poll, recognized as already saved, and its ACK is retried.

The relay keeps an acknowledged result for seven days and still serves it under `state=all`, so the
second copy the tournament wanted is there for the weekend. As a backstop, QBBridge warns when 100
results are unsaved, well before the window could matter. Deduplication is local, by result id.

Pairing codes are eight digits, generated locally, shown in the application, and sent to the relay
only as SHA-256 hex. The plaintext travels to a device in the URL _fragment_ of the ordinary
`#qbtcp-pair?v=1&server=…&code=…&room=…` launch link, which a browser never sends to a server.

A room keeps its pairing across rounds. Publishing restates each room's pairing hash (the relay
replaces a listed room's columns wholesale) and sends an empty `sessions` list, which touches no
scorer-created session. Room tokens live in their own table and a mirror does not revoke them.

**Every configured room is in every publication**, including rooms with no game. The relay upserts
and never deletes, so a room left out of the payload keeps serving whatever it was last given: a
scorekeeper in an unused room could open last round's assignment, which is real and correctly
formatted and belongs to a match nobody is playing. An unused room is therefore published with its
assignment explicitly cleared, keeping its id, its name and its pairing hash.

If a publish fails, QBBridge says the rooms were not updated and changes nothing locally. If the
relay disappears, local state is kept and the next poll tries again. There is no offline queue, no
background sync engine, and no reconciliation.

**Change Relay never deletes anything.** It opens the setup form while the current relay keeps
working, and the stored credential is replaced only after a new claim succeeds; Cancel returns to
what was there. Deleting the credential is a separate action that says so and asks first, because
a relay's setup token is consumed by the claim that produced the credential — a deleted one cannot
be recreated and the relay it authorized cannot be claimed again.

## Results

A result that arrives is written out exactly as it arrived. QBBridge does not import it, normalize
it, regenerate it, recalculate statistics, rewrite player stats, change an identifier, merge a round
into one file, or convert anything. The only thing it adds is a filename, and a filename is never an
identity.

One `.qbj` per game. YellowFruit's import dialog multi-selects.

**A saved result is never silently replaced.** The relay can legitimately hold two finals for one
game — a correction and the original — with the same match, the same room and the same two teams,
and so the same descriptive filename. Each file therefore ends in six hex characters derived from
the relay's own `result_id`, and the native writer opens exclusively: an existing file comes back
as a readable error rather than being overwritten. Re-saving one specific result deliberately
rewrites its own file.

QBBridge reports only what it can see: a room is **Ready** until its assignment is published,
**Waiting** until a result for that match arrives, then **Result received**; a result is **New**
until it is written, then **Saved**. It never claims a result was imported, accepted, applied to
standings, or reviewed — it has no way to know, and YellowFruit is the authority for all of it.

## Why Tauri

For practical tournament-day reasons, not because this needs a desktop architecture: a native
`.yft` picker, a native folder picker, writing many files without a download prompt each, no
dependence on a browser tab surviving, and HTTP to the relay without adding a desktop origin to the
relay's CORS allowlist.

The native side is four commands and holds no state:

```text
open_yellowfruit_file()
choose_result_folder()
write_result_file(directory, fileName, contents)
relay_request(method, url, bearer, body)
```

Local state — relay pointer and credential, rooms, pairing codes, current pairings, round
selection, mirror revision, seen and saved results, results folder — is one `localStorage` key.
For a single-operator utility that is less code and fewer failure modes than a database, and the
credential authorizes one tournament on a relay the operator deployed themselves.

## How it looks

QBBridge renders from `@qbsheet/ui` — the shared QBSheet token layer and a small set of
React Aria-backed primitives (`Button`, `Tabs`, `ConfirmDialog`, `TextField`, `TeamComboBox`,
`Notice`, `StatusBadge`). It defines no colours, no type scale and no spacing of its own; what is
left in `src/app.css` is page rhythm.

React Aria supplies behaviour only — keyboard and pointer activation, focus management, dialog
focus trapping and restoration, ARIA relationships, the `data-*` state hooks. Every pixel comes
from QBSheet tokens; no third-party theme is imported and nothing here should look like somebody
else's design system.

Plain semantic HTML stays plain: the room list is a real `<table>`, the tournament summary is a
`<dl>`, the round picker is a `<select>` over eight fixed entries. The team pickers are combo
boxes because a sixty-team roster is faster to type than to scroll, and because two teams called
"Providence A" and "Providence B" should not be thirty rows apart — the value is always the team's
identifier, matching is a plain substring, and nothing fuzzy can change which team is selected.

## Developing

```bash
npm run qbbridge:dev          # Vite, http://127.0.0.1:1425
npm run qbbridge:test         # unit and integration tests
npm run qbbridge:build        # typecheck and production build
npm run qbbridge:tauri:dev    # the desktop application
npm run qbbridge:tauri:build  # QBSheet Bridge.app and the platform equivalents
```

```bash
npm run ui:test               # the shared primitives
```

Tests cover the places where a mistake ruins a real match: loading a real stock `.yft`, the scoring
rules a known configuration produces (and a deliberately non-default one, so nothing is hard-coded
to NAQT), that QBSheet's own parser turns an assignment into a playable game with no questions
asked, match identity across republishes, that plaintext pairing codes stay local while their
hashes reach the mirror, result deduplication, byte-for-byte result preservation, restart recovery,
and that a completed result satisfies the import assumptions of stock `ANadig/YellowFruit` — whose
algorithm is transcribed with citations in `src/model/yellowfruitInterop.test.ts`.

The tournament-day failure modes have their own regressions: a room used in round 4 and unused in
round 5 has its assignment cleared while keeping its pairing; a round change clears selections and
cannot publish the previous round's pairings; a failed relay claim leaves the working credential
usable; two result ids for one game produce two files and the first is never overwritten; a result
is acknowledged after it is written and not before; and an A-vs-B game between two teams of one
school produces a result with unique object ids and one shared `Registration`.

## The supported boundary

```text
input:  .yft
output: .qbj result files
```

Nothing else. There is no QBBridge → YellowFruit network integration, no YellowFruit API, no
process injection, no Electron automation, no live `.yft` editing, no automatic import, no
localhost YellowFruit server, and no modification of stock YellowFruit. The final handoff is a
person choosing files in YellowFruit's own dialog.
