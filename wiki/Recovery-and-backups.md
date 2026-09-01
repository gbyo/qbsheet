# Recovery and backups

QBSheet keeps several independent recovery copies. They have different jobs, and the first copy
that accepted a scoring action remains the immediate authority: the synchronous local journal.
Asynchronous mirrors and portable files add evidence; they do not silently replace newer local work.

## The recovery layers

| Source                   | Where it lives                                    | What it restores                                                 |
| ------------------------ | ------------------------------------------------- | ---------------------------------------------------------------- |
| Instant game journal     | `localStorage` on this device                     | Events, setup, and action-level undo/redo                        |
| Durable game record      | IndexedDB on this device                          | Package, setup, events, and result/delivery state                |
| Rolling checkpoints      | Separate `qbsheet-recovery` IndexedDB             | Exact `.qbsheet` snapshots, bounded to recent copies and anchors |
| Optional external backup | A folder explicitly selected by the scorekeeper   | One stable `.qbsheet` file per local game                        |
| QBSheet backup           | A `.qbsheet` file you hold                        | Exact scoring continuation state                                 |
| QBJ or server snapshot   | Standard file or paired tournament-control server | A partial/interoperable recovery fallback                        |

## The local journal is the first recovery path

Every accepted scoring action writes the event list and v2 recovery shape to `localStorage` in the
same turn as the click. The event list is the source of truth. The optional undo/redo frames preserve
action boundaries across a reload; if those frames are malformed, QBSheet keeps the valid events and
discards only the auxiliary history. Older v1 journals containing only setup and events remain
readable.

The existing IndexedDB game record is written as a mirror after the synchronous journal. It contains
the package, setup, events, and result state, but it does not replace the journal's immediate
saved/not-saved promise. Room clocks, display-side mapping, and player seating remain separate
presentation state; they do not alter canonical events.

## Rolling checkpoints

After the journal accepts a snapshot, QBSheet asynchronously writes the same credential-free
`.qbsheet` envelope to the separate recovery database. It retains eight recent rolling checkpoints
and keeps named anchors such as game start, halftime, end of regulation, overtime, and sudden death
within a bounded anchor set. A failed checkpoint write is surfaced as degraded recovery status; it
does not block scoring or cause an older checkpoint to be deleted.

Each checkpoint may include a best-effort SHA-256 fingerprint of the sanitized setup and ordered
serialized events. Web Crypto can be unavailable in a locked-down or unusual browser, so the
fingerprint is an aid for comparing copies, never a prerequisite for recovery.

## Optional external backup folder

External backup is optional. QBSheet never opens a folder picker or asks for permission during
startup, readiness checks, or ordinary scoring. The first folder selection is available only from an
explicit Setup/Manage action in Settings or Device Readiness; reconnecting a remembered folder is
also an explicit action.

The folder receives one stable `.qbsheet` filename per local game. Names use the normal QBSheet game
name and a deterministic collision-safe suffix when two local attempts would otherwise collide.
Writes are asynchronous, serialized per file, and coalesced so a burst of score changes cannot make
an older snapshot overwrite a newer one. A folder that disappears, loses permission, or rejects a
write leaves the instant journal and local checkpoints intact and is shown as a repairable failure.
Stopping external backup forgets QBSheet's handle and filename metadata; it never deletes files in
the selected folder.

## Recovery Mode

If the scorer repeatedly crashes, choose **Open Recovery Mode**, or load the app with
`?recovery=1`. Recovery Mode is a separate safe path selected before the normal scorer is mounted.
It performs read-only inspection of the raw local journal, durable local records, valid rolling
checkpoints, and — when the remembered folder is readable — external `.qbsheet` files. It does not
contact tournament control, request folder access automatically, or clear evidence.

From Recovery Mode you can:

- compare readable and malformed local copies without overwriting them;
- restore an older valid checkpoint or readable external backup as a separate local attempt;
- deliberately reconnect or change the remembered external folder when its status requires repair;
- save the raw journal exactly as stored for a tournament director;
- open a validated `.qbsheet` file; and
- restore that backup as a separate offline local attempt, leaving any existing unfinished attempt
  untouched.

The render-error screen states whether a journal could be verified, offers a reload for a first
crash, and promotes Recovery Mode plus raw export when the crash repeats. It never offers a reset.

## A QBSheet backup moves an unfinished game

Use a QBSheet backup when replacing a Chromebook, changing rooms, or making an exact copy before
continuing elsewhere.

1. Open the **Game / More** menu.
2. Select **Export / backup…**.
3. Select **Download QBSheet backup**.
4. Keep the file whose name ends in `.qbsheet`.

The allowlisted envelope preserves the sanitized package, current setup, complete event history,
undo/redo history, paused clock segments, display-side mapping, and player seating. A running clock
is snapshotted at export and imported paused; time spent copying a file is never charged to the room.

To restore one, use **Open game file** or **Open QBSheet backup…** in Recovery Mode. QBSheet creates a
fresh local offline attempt, writes the exact event history, and never imports connection tokens,
session ids, device ids, or server credentials. If an unfinished attempt for the same assignment is
already present, the existing attempt is left untouched and the imported backup gets its own attempt
number.

## QBJ and the connected server are fallbacks

QBJ remains the interoperable result/lifeboat format. Downloaded QBJ files never include the private
QBSheet recovery envelope, undo/redo, clock internals, display orientation, or unsent connection
queues. A QBJ can describe the standard result state, but it is not an exact QBSheet continuation.

A connected scoresheet asks tournament control for its private recovery snapshot only when no usable
local event history exists. The `_yf_scorekeeper_recovery` envelope is v2 with optional action
history; readers continue to accept v1, and malformed auxiliary history is ignored without losing
valid events. A late server response cannot replace scoring that has already started locally.

## What portable files never hold

QBSheet's allowlisted serializers keep these out of both QBSheet backups and ordinary QBJ downloads:

- room, session, or access tokens;
- pairing codes and authorization headers;
- device or browser identifiers;
- server credentials and private diagnostic logs; and
- unsent connection queues or any capability that could impersonate the original room.

Assignment names and human-readable room/team metadata may remain so a scorekeeper can identify a
file. A connected restore is still offline until the scorekeeper explicitly repairs or re-pairs it.

## Habits that save a game

1. Keep one active scoresheet tab on one device.
2. Download a QBSheet backup before moving a room to another device.
3. Download a current QBJ at halftime or whenever tournament staff needs the standard format.
4. Download the final QBJ at the end, even when tournament control accepted the result.
5. Do not clear site data or use a private window while scoring.

## Related pages

- [Troubleshooting](Troubleshooting)
- [Finish a game](Finish-a-game)
- [Files and formats](Files-and-formats)
- [Prepare a device](Prepare-a-device)
