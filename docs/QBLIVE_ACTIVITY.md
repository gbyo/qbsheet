# The QBSheet Live Activity

A team's game on the Lock Screen, updated by ActivityKit broadcast push channels.

## Why broadcast channels

QBSheet Live requires iOS 18, so per-device Live Activity push tokens are not implemented at all.
A broadcast channel sends **one** APNs request that reaches every subscriber, which is the right
shape for a tournament: three hundred people in a gym are looking at eight games between them.

## Sharding

Channels are per **shard of teams**. Never per team, never per viewer.

```
64-team tournament, 8 teams per shard

Shard 0 → teams  1–8      Shard 4 → teams 33–40
Shard 1 → teams  9–16     Shard 5 → teams 41–48
Shard 2 → teams 17–24     Shard 6 → teams 49–56
Shard 3 → teams 25–32     Shard 7 → teams 57–64
```

The followed team is a **static attribute**, fixed when the Activity starts. The shard's state is the
broadcast `ContentState`. The view picks out one entry by `slot`. That split is forced by the
mechanism: a broadcast delivers the same `ContentState` to everybody, so the per-viewer part cannot
be in it.

A team's index comes from the published team order, which both Director and the client already have.
Nothing about the sharding has to be transmitted.

## Measured payload sizes

From `packages/qblive-activity/tests/payload.test.ts`, which prints these on every run. **Typical**
is a live game with same-shard opponents; **worst case** is every team playing a cross-shard opponent
with a 56-character school name, a 22-character room label, and a scheduled time — the expensive
shape, and the one an estimate forgets.

| Teams per shard | Typical | Worst case |
| ---: | ---: | ---: |
| 2 | 206 B | 400 B |
| 4 | 328 B | 716 B |
| 6 | 450 B | 1 032 B |
| 8 | 572 B | 1 348 B |
| 12 | 820 B | 1 982 B |
| **16** | **1 072 B** | **2 618 B** |
| 24 | 1 576 B | 3 890 B |
| 32 | 2 080 B | 5 162 B |

Apple's limit is **5 120 bytes**. QBSheet's budget is 60% of it — **3 072 bytes** — because a payload
that fits exactly today fails the first time a team is renamed, mid-tournament, silently.

**Result: sixteen, not eight.** Eight was the starting guess. Sixteen fits at 2 618 bytes worst case
with 2 502 bytes of headroom, and it halves the number of APNs channels a tournament consumes.
Thirty-two exceeds the hard limit in the worst case and is not a candidate.

`chooseTeamsPerShard` measures a tournament's actual strings once, when Apple push is enabled, and
then holds the answer fixed — a shard size that changed mid-day would move teams between channels
and strand the Activities already subscribed to the old ones.

`QBLiveSharding.defaultTeamsPerShard` stays at 8: it is the answer given *without* measuring.

## Compact encoding

Field names are one and two letters because every key is repeated once per team. With readable names
a sixteen-team shard spends most of its budget on the word "opponent".

| Key | Meaning |
| --- | --- |
| `r` | publication revision |
| `t` | teams |
| `i` | index in shard |
| `m` | mode: 0 idle, 1 upcoming, 2 live, 3 final |
| `o` | opponent's index, when in the same shard |
| `on` | opponent's name, when in a different shard |
| `s` / `x` | this team's score / opponent's score |
| `u` | tossups read |
| `rm` | room |
| `rd` | round number |
| `st` | scheduled start, Unix seconds |
| `ev` | a non-game event's title |

The encoder is `packages/qblive-activity`; the decoder is `QBLiveActivityAttributes` in
`ios/QBSheetLiveKit`. `QBLiveActivityTests.fieldNames` asserts the exact key set, so a rename on one
side fails the other's build.

**Everything optional is genuinely absent when the tournament has not published it.** A Director who
keeps live scores off produces entries with no `s`/`x`, and the Lock Screen reads "Game in progress".
Absence is how a privacy setting reaches a Lock Screen — never a zero, which would be a score.

## Lifecycle

Created **lazily**: a channel exists only once somebody actually starts an Activity in that shard.
A 64-team tournament where viewers follow teams in three shards consumes three channels, not eight.

Deleted when the tournament finalizes, when the publication is deleted, or when the channel exceeds
its lifecycle. A channel counts against Apple's 10 000-per-app-per-environment limit whether or not
anybody is subscribed, so the gateway reconciles rather than assuming an idle channel disappears.

Apple's ceiling is 10 000. QBSheet's internal allocation ceiling is **8 000**, leaving a deliberate
reserve. On exhaustion, Live degrades to foreground-only realtime and says so.

## Cadence

| Class | Examples | Coalescing | APNs priority |
| --- | --- | --- | --- |
| Routine | score change, tossup progress | ~15 s | 5 |
| Transition | game starts, game final, late room change | prompt | 10 |
| Announcement | Director announcement | its own flow | 10 |

Before enqueueing, the gateway hashes the normalized shard state and drops an unchanged one. The hash
excludes the revision on purpose: Director's revision advances for reasons that change nothing on a
Lock Screen, and pushing for those would spend the publishing budget on nothing.

Message storage policy is `MostRecentMessageStored`, fixed at channel creation and not changeable
after. A phone in a pocket during a round should show the current score when it comes out, not a
blank Activity.

## Duration

Apple ends a Live Activity after its own maximum lifetime. QBSheet Live does not fight that: the
Activity ends normally, and opening the app creates a fresh one for the current game. The UX is not
built around an Activity surviving a whole tournament day, because it will not.

`staleDate` is set twelve minutes ahead — long enough to survive a round with no scoring, short
enough that a tournament whose backend went down does not leave a stale score looking live all
afternoon. ActivityKit dims past that point, which is the honest presentation of "we do not know any
more".

## What is on the Lock Screen

Team, opponent, score if published, room, round, and either the stated scheduled time or nothing.
No tables, no standings, no schedule. It is read in two seconds while walking down a corridor.

Dynamic Island: compact shows the score or a one-word status; expanded adds round, room, progress and
the stated start.
