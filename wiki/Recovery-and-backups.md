# Recovery and backups

QBSheet has four recovery layers. They serve different jobs: the local journal is the fastest
same-device recovery, the durable game record is a second local copy, a QBSheet backup moves an
unfinished game between devices, and QBJ remains the interoperable result/lifeboat format.

## The four sources

| Source | Where it lives | What it restores |
| --- | --- | --- |
| The local game journal | `localStorage` on this device | Events, the frozen setup, and action-level undo/redo |
| The durable game record | IndexedDB on this device | Package, setup, events, and finished-result/delivery state |
| A QBSheet backup | A `.qbsheet` file you hold | Exact scoring state, including portable recovery metadata |
| A partial QBJ file or server snapshot | A file or paired tournament-control server | The state that QBJ or the server snapshot can describe |

## The local journal is the first recovery path

Every accepted scoring action writes the event list and the v2 recovery shape to `localStorage` in the
same turn as the click. The journal contains:

- the complete `ScoreEvent[]` history and the setup used to derive it;
- action-level undo frames and redo frames, so a reload keeps the same action boundaries; and
- the journal timestamp and game key used to find this game again.

The event list remains the source of truth. If the auxiliary undo/redo metadata is malformed, QBSheet
keeps the events and discards only that metadata. Older v1 journals containing only setup and events
continue to load; they simply have no recoverable undo/redo frames until a new action is made.

Room clocks are a separate local layer. Each half, break segment, or overtime segment has its own
clock entry. Same-device recovery keeps the timestamp semantics of a running clock. The display-side
mapping is also device-local presentation state and does not change canonical events or QBJ.

The IndexedDB record mirrors the package, setup, events, and result state. It does not replace the
synchronous journal for the immediate saved/not-saved promise, and it does not contain the journal's
undo/redo frames or the separate room-clock entries.

**To recover on the same device, open QBSheet again and select _Resume_ under _Unfinished game_.**

## A QBSheet backup moves an unfinished game

Use this when the Chromebook is being replaced, the room changes machines, or you want an exact
portable copy before continuing elsewhere.

To write one during a game:

1. Open the **Game / More** menu.
2. Select **Export / backup…**.
3. Select **Download QBSheet backup**.
4. Keep the file whose name ends in `.qbsheet`.

The QBSheet-specific, versioned envelope uses an explicit allowlist. It preserves the sanitized game
package (rules, procedure, teams, rosters, and assignment metadata), current setup and starting
lineups, the complete event history, action-level undo/redo, every persisted clock segment, the
display-side mapping, and the player seating/keyboard order. Correction events, exceptions, and
unresolved protests are ordinary events and therefore remain in the history.

If a clock is running, export snapshots its elapsed time at the instant of export. The file never
carries `runningSince`; an imported clock is paused, so moving the file does not charge the room for
the time spent copying it.

To restore one on another device, use the existing **Open game file** button and choose the
`.qbsheet` file. No separate import screen is needed. QBSheet creates a fresh local, offline record,
writes the event history and recovery metadata, restores the clocks paused, and restores the display
orientation. A backup from a connected game does **not** retain authentication or pretend to be live:
pair the destination device again if tournament control needs the game or its result.

If this device already has an unfinished copy of the same assignment, QBSheet leaves that record
untouched and restores the backup as a separate local attempt. The scoresheet says so beside the
restored game; confirm which copy is current before recording another action. An unreadable local
record is also never overwritten: QBSheet chooses another local attempt or refuses the import.

An optional malformed recovery block is ignored where it is safe to do so, but a malformed event or
an impossible event sequence makes the backup fail closed. A backup with a newer unsupported version
is refused with an update message; QBSheet never partially interprets a future recovery shape.

## A partial QBJ file is an interoperable lifeboat

Use QBJ when another tool or tournament staff needs the standard result shape, or when only a QBJ
reader is available.

To write the current QBJ:

1. Open the **Game / More** menu.
2. Select **Export / backup…**.
3. Select **Download current QBJ**.

QBJ carries the standard team/player statistics, per-question record, lineups, notes, room metadata,
and identifiers that the QBJ schema supports. QBSheet continues to strip its internal recovery block
from downloaded QBJ files. A current/partial QBJ therefore does not carry undo/redo, clock internals,
display orientation, connection state, or unsent queues. It is a portable result/lifeboat, not an
exact QBSheet continuation file.

QBJ opening is unchanged: give QBSheet the file through **Open game file**, and it follows the normal
QBJ or legacy-file path. The QBSheet backup path is selected from the file's own discriminator, not
by asking the scorekeeper to choose an import mode first.

## The server is a connected fallback

A paired scoresheet may ask tournament control for its private session snapshot only when the device
has no local event history. This path requires the still-held session credential and is never part of
a portable file. A server snapshot without QBSheet's recovery event layer is not turned into invented
undo history; use QBJ recovery or the paper scoresheet instead.

## Comparison

| | Local journal | QBSheet backup | Partial/current QBJ |
| --- | --- | --- | --- |
| Lives in | This device's `localStorage` | A `.qbsheet` file | A `.qbj` file |
| Events and setup | Yes | Yes | Standard QBJ projection |
| Undo and redo frames | Yes, v2; absent in legacy v1 | Yes, when present | No |
| All room-clock segments | Separate local entries | Yes, snapshotted and paused on import | No |
| Display-side mapping | Device-local | Yes | No; QBJ stays canonical |
| Player seating/keyboard order | Device-local | Yes | No |
| Connection credentials/queue | Device-local only | No | No |
| Leaves this device | No | Yes | Yes |

## What a portable file never holds

QBSheet's allowlisted serializer keeps these out of both QBSheet backups and ordinary QBJ downloads:

- room, session, or access tokens;
- pairing codes and authorization header data;
- device or browser identifiers;
- server credentials or server addresses;
- private diagnostic logs, unrelated `localStorage`, and unsent connection queues; and
- a capability that could impersonate the original room.

The package may retain the assignment's game identity and human-readable room/team metadata needed
to recognize the game. Those are not authentication capabilities. A connected restore is still an
offline local game until the scorekeeper explicitly repairs or re-pairs it.

## Habits that save a game

1. Download a QBSheet backup before moving a room to another device.
2. Download a current QBJ at halftime or whenever tournament staff needs the standard format.
3. Download the final QBJ at the end, even when tournament control accepted the result.
4. Keep one active scoresheet tab on one device and do not clear site data during a tournament.
5. Do not use a private window for scoring.

## When something already went wrong

Read [Troubleshooting](Troubleshooting). Find the line that matches your problem, then follow the
steps.

## Related pages

- [Finish a game](Finish-a-game)
- [Files and formats](Files-and-formats)
- [Prepare a device](Prepare-a-device)
