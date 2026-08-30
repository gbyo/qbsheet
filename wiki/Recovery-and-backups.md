# Recovery and backups

QBSheet has three ways to bring a game back. They are not equal. This page tells you which one to use
and why.

## The three sources

| Source | Where it lives | How exact |
| --- | --- | --- |
| The local journal | `localStorage` and IndexedDB on the device | Exact. This is the recovery mechanism. |
| A partial QBJ file | A file that you hold | Partial. It holds what standard QBJ can say. |
| The tournament control server | The server that you paired with | A fallback for a device that lost its own copy. |

## The local journal is the real recovery

QBSheet writes each scoring event to `localStorage` at once. QBSheet also mirrors the game package,
the record state, and the finished QBJ document in IndexedDB.

The journal holds things that no file format can hold:

- The full history of every scoring event
- The undo and redo history
- The internal state of the clock
- The connection state and the queue of unsent messages

**To recover from the journal, open QBSheet again on the same device.** The start screen shows the
section **Unfinished game**. Select **Resume**.

## A partial QBJ file is a lifeboat

Use a partial QBJ file when the device itself is gone.

To write one during a game:

1. Open the Game / More menu.
2. Select **Export / backup…**.
3. Select **Download current QBJ**.
4. Keep the file. The name ends in `.partial.qbj`.

The file holds the team and player statistics, the lineups, the per-question record, the notes, the
room, and the identifiers. QBSheet can open the file again.

The file does not hold the undo history, the clock internals, the connection state, or the queue. So
the file is a lifeboat for a dead Chromebook. It is not a substitute for the journal.

To read one back into a game in progress:

1. Open the Game / More menu.
2. Select **Recover from QBJ**.
3. Choose the file.

## The server is the last fallback

A paired scoresheet can ask the server for the private state that the scoresheet sent earlier. The
same session credential authorises this read. No credential reads a whole room and no credential
reads the whole tournament.

Use this path only when the local copy of the device is gone or unreadable.

## A comparison

| | A partial QBJ file | The local journal |
| --- | --- | --- |
| Lives in | A file that you hold | IndexedDB and `localStorage` |
| Holds | Standard QBJ statistics | The full event history and the frozen setup |
| Restores | The game as QBJ can describe it | The game exactly as it was |
| Undo and redo history | No | Yes |
| Exact clock internals | No | Yes |
| Connection state and queue | No | Yes |
| Leaves the device | Yes | Never |

## What a portable file never holds

QBSheet cleans every file that leaves the device. The same rule applies to a download, to a snapshot
over the network, and to a result over the network.

A portable file never holds:

- A room token or a session token
- A pairing code or authorisation header data
- A device identifier or a browser identifier
- A server address
- The private recovery journal

## Habits that save a game

1. Download a partial QBJ file at halftime. One file per half costs nothing.
2. Download the result at the end, even in a connected room.
3. Keep the game in one tab on one device.
4. Do not clear the site data of the browser during a tournament.
5. Do not use a private window for scoring.

## When something already went wrong

Read [Troubleshooting](Troubleshooting). Find the line that matches your problem, then follow the
steps.

## Related pages

- [Finish a game](Finish-a-game)
- [Files and formats](Files-and-formats)
- [Prepare a device](Prepare-a-device)
