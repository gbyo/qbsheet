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

**Each round**

1. Choose the round.
2. Pick the two teams for every room.
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
publish, so QBBridge owns a small manual table. Rooms persist across rounds; the operator picks the
two teams each round.

There is no round-robin generation, no automatic pairing, no bracket, no advancement, and no
schedule-legality engine. There are four cheap warnings — an empty room, a team against itself, a
duplicate room name, a team in two rooms this round — and none of them blocks a publish.

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
deploys no Worker, forks no protocol, and makes three calls:

```text
POST /qbtcp/v1/manage/claim
PUT  /qbtcp/v1/manage/tournaments/{id}/mirror
GET  /qbtcp/v1/manage/tournaments/{id}/results?state=unacked
```

There is deliberately no `POST manage/acks`. The relay keeps an unacknowledged final forever, so
leaving the day's results unacknowledged gives the tournament a second durable copy of every game
at no cost. Deduplication is local, by result id.

Pairing codes are eight digits, generated locally, shown in the application, and sent to the relay
only as SHA-256 hex. The plaintext travels to a device in the URL _fragment_ of the ordinary
`#qbtcp-pair?v=1&server=…&code=…&room=…` launch link, which a browser never sends to a server.

A room keeps its pairing across rounds. Publishing restates each room's pairing hash (the relay
replaces a listed room's columns wholesale) and sends an empty `sessions` list, which touches no
scorer-created session. Room tokens live in their own table and a mirror does not revoke them.

If a publish fails, QBBridge says the rooms were not updated and changes nothing locally. If the
relay disappears, local state is kept and the next poll tries again. There is no offline queue, no
background sync engine, and no reconciliation.

## Results

A result that arrives is written out exactly as it arrived. QBBridge does not import it, normalize
it, regenerate it, recalculate statistics, rewrite player stats, change an identifier, merge a round
into one file, or convert anything. The only thing it adds is a filename, and a filename is never an
identity.

One `.qbj` per game. YellowFruit's import dialog multi-selects.

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

## Developing

```bash
npm run qbbridge:dev          # Vite, http://127.0.0.1:1425
npm run qbbridge:test         # unit and integration tests
npm run qbbridge:build        # typecheck and production build
npm run qbbridge:tauri:dev    # the desktop application
npm run qbbridge:tauri:build  # QBSheet Bridge.app and the platform equivalents
```

Tests cover the places where a mistake ruins a real match: loading a real stock `.yft`, the scoring
rules a known configuration produces (and a deliberately non-default one, so nothing is hard-coded
to NAQT), that QBSheet's own parser turns an assignment into a playable game with no questions
asked, match identity across republishes, that plaintext pairing codes stay local while their
hashes reach the mirror, result deduplication, byte-for-byte result preservation, restart recovery,
and that a completed result satisfies the import assumptions of stock `ANadig/YellowFruit` — whose
algorithm is transcribed with citations in `src/model/yellowfruitInterop.test.ts`.

## The supported boundary

```text
input:  .yft
output: .qbj result files
```

Nothing else. There is no QBBridge → YellowFruit network integration, no YellowFruit API, no
process injection, no Electron automation, no live `.yft` editing, no automatic import, no
localhost YellowFruit server, and no modification of stock YellowFruit. The final handoff is a
person choosing files in YellowFruit's own dialog.
