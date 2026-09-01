# Transfers

Transfers is how tournament assignments and completed results move between QBSheet Director and
scoring devices when QBTCP is not the route — or not the only route.

This document describes the subsystem. The file format it moves is ordinary QBJ and is specified in
[`QBJ_ASSIGNMENT_PROFILE.md`](QBJ_ASSIGNMENT_PROFILE.md); the live protocol is in
[`QBTCP.md`](QBTCP.md).

## The rule the design exists to keep

> A tournament must never have to choose between QBTCP, USB, shared folders, cloud-synced folders,
> downloaded files, or manual result entry.

Different rooms may use different mechanisms in the same round, and the same game may use more than
one — an assignment delivered over the network and duplicated onto a stick as a backup is a normal,
sensible thing for a tournament to do.

So there is no `mode` setting. Not on the tournament, not on the round, not on a scheduled game.

## Why there is no `mode` field

A transport setting would make one route the truth and the rest an exception. The first time a
room's tablet dropped off the network, the director would have to change a tournament-level setting
to hand out a file — during a round, under time pressure, with the round's other eleven rooms
depending on that setting staying where it was.

Instead, delivery and return are modelled as **events around** the scheduled game rather than as
properties of it:

| Record | Means |
| --- | --- |
| `AssignmentTransfer` | One revision of one game's assignment went to one destination |
| `IncomingArtifact` | One file showed up, and here is what Director decided it was |
| `TransferLocation` | A place Director can write to and read from |

Neither transfer record is exclusive, both are many-per-game, and `ScheduledGame` is unchanged. A
game with a QBTCP delivery and a USB delivery has two `AssignmentTransfer` rows and no contradiction.

See [`src/director/transfers/model.ts`](../src/director/transfers/model.ts).

## One result pipeline

Every returned result converges on one function before it becomes anything:

```
QBTCP ────────┐
USB ──────────┤
Watched folder├──> assessIncomingDocument ──> ResultSubmission ──> Results inbox ──> accept/reject
Drag and drop ┤        (match, fingerprint,
File picker ──┘         classify, dedupe)
```

`assessIncomingDocument` in [`ingest.ts`](../src/director/transfers/ingest.ts) is transport-independent
by construction: it takes a parsed QBJ document and a label saying where it came from, and it does
not know whether that was a socket, a stick, a synced folder or a drop. The QBTCP path in
`useDirectorController` calls it. The file paths call it. There is one matching rule, one
fingerprint, one duplicate check and one warning vocabulary.

**Nothing in Transfers accepts a result.** Staging puts a `ResultSubmission` in the results inbox, in
`received` or `review`, which is exactly where a QBTCP result and a hand-entered paper result land.
A result becomes part of the tournament only through the Results page. Inserting a drive is not
consent to change the standings.

### One fingerprint, computed in one place

The QBTCP server computes a SHA-256 fingerprint (`result_fingerprint` in
`crates/qbtcp-server/src/model.rs`) and the scorer computes an FNV one for downloads
(`portableResultFingerprint` in `src/game/PortableQbj.ts`). Both canonicalize the same way — sorted
keys, transport extensions removed — but they are different hashes.

So Director trusts neither. Every document, whatever route it took, is fingerprinted by
`resultFingerprint` in [`canonical.ts`](../src/director/transfers/canonical.ts). The transport's own
fingerprint is kept for correlation with its logs and is never used for matching. That is what makes
"the same result arrived by QBTCP and then on a stick" detectable at all.

`digest` is a different question from `fingerprint`. A fingerprint asks *is this the same result*,
ignoring transport metadata. A digest asks *is this the same file*, over the exact bytes, so a drive
plugged in four times does not stage its results four times.

### Classification

| Classification | Meaning |
| --- | --- |
| `ready` | Matched the current assignment, nothing to explain |
| `duplicate` | Director already has this exact result; no second game is created |
| `needs-review` | Parses and matches, but something is a question for a person |
| `assignment` | An unplayed assignment file. **Never** imported as a game |
| `not-a-result` | Valid JSON, no QBJ match in it |
| `invalid` | Could not be read; the reason is shown |

`needs-review` reasons share the QBTCP server's vocabulary where the meaning is the same:
`tournament-mismatch`, `missing-tournament-identity`, `missing-match-identity`, `unknown-match`,
`matched-by-teams`, `stale-round-revision`, `stale-assignment-revision`, `result-conflict`,
`roster-mismatch`, `cancelled-game`, `already-accepted`, `statistics-warning`.

### Duplicate and conflict

Both are the same question asked of prior submissions for the same game: does Director already hold
a result for it, and does it say the same thing?

- **Same fingerprint** → duplicate. Recorded as a `duplicate` submission so the director can see the
  backup arrived, and no second `GameRecord` is created.
- **Different fingerprint** → conflict. The new result is staged for review with `conflictWith`
  pointing at the one it disagrees with. Director never picks the newer transport.

## Assignments

A prepared assignment is ordinary QBJ following
[`QBJ_ASSIGNMENT_PROFILE.md`](QBJ_ASSIGNMENT_PROFILE.md): one tournament, the scoring rules, the two
teams and their rosters, the relevant phase and round, exactly one unplayed match, the room in
`Match.location`, the packet identity, and the `_qbtcp` block carrying the round and assignment
revisions.

It is built by [`assignment.ts`](../src/director/transfers/assignment.ts), which produces **the same
document** `generated_assignment` in `apps/director/src-tauri/src/server.rs` sends over QBTCP. A room
must not be able to tell which route its assignment took.

An assignment never contains another pairing, a future round, standings, a pairing code, a QBTCP
token, a session, a server address, or private Director state. Construction is additive from named
fields, `stripSecrets` runs over the result, and
[`assignment.test.ts`](../src/director/transfers/assignment.test.ts) asserts that a prepared round's
files mention no game, round or team other than their own.

### Revisions

`_qbtcp.round_revision` and `_qbtcp.assignment_revision` travel with every assignment and come back
on the result. When a returned result carries a revision older than the round is at now, it is
staged with `stale-round-revision` or `stale-assignment-revision` and an explanation. It is never
silently applied over the current scheduled game.

### Filenames

```
Round 5 - Room 104 - Ninety Six A vs Greenwood A.qbj
```

Sanitized against the union of macOS, Windows and Linux rules — reserved characters, reserved device
names (`CON`, `COM1`…), trailing dots and spaces, control characters, and a length bound — because a
file written on one platform is read on another.

**The filename is never identity.** Identity comes from `Tournament.id` and `Match.id` in the QBJ.
Renaming a file does not reassign it, and the README written to every drive says so.

## Transfer locations

A location is a directory a person chose. A USB stick, a folder on the desktop, a Google Drive
folder, a mounted network share and an external drive are all the same thing here — which is why
cloud services need no integration: the sync client already put the folder on the filesystem.

### Exchange layout

```
QBSheet/
  README.txt
  transfer.json

  Assignments/
    Round 5 - Room 101 - ....qbj
    Round 5 - Room 102 - ....qbj

  Results/
```

Every `.qbj` is self-contained. `transfer.json` is an **optional transport manifest** — a hint for
recognition, carrying the tournament identity, the prepared timestamp, the Director build, and the
expected filenames with their revisions. It is not a tournament format and not a scoresheet format.
Delete it and every file on the drive is still importable; recognition just gets less specific.

The manifest carries no QBTCP secret, no room token, no server credential and no recovery state, and
there is no field one could be put in.

### Write order and safety

Directories, then the assignment files, then the README, then the manifest — the manifest last,
because it names files it expects to exist. Every write is atomic: a temporary file in the
destination directory, flushed, then renamed over the target. A drive pulled mid-write leaves the
previous file or no file, never a truncated JSON document that parses far enough to look like a game.

When every write has returned:

```
12 assignments prepared.

QBSheet finished writing to SanDisk Ultra.
Eject the drive normally before removing it.
```

Director says *eject normally*, not *safe to remove*, because it has not performed an OS-level eject
and cannot see the operating system's write cache.

Partial success is reported as partial success. A drive that fills up after eight of twelve files
leaves eight usable assignments and names the four that did not fit.

## Cloud folders

Google Drive, OneDrive, Dropbox, iCloud Drive, Syncthing and Box are treated as ordinary
user-selected filesystem locations. There is no provider API, no OAuth, no account. When a path
looks like a provider's sync folder, Director says so and adds one advisory line:

> For tournament-day reliability, make this exchange folder available offline in your sync app.

It is advice, not a blocker, and Director does not claim it can control the provider's offline state.
If a placeholder file cannot be read because it is not available locally, the reason is shown and the
file can be retried; the file is never modified or removed.

### Without a sync client

**Export assignment files** writes the selection to the browser's download folder. The director
uploads them by hand to Drive, OneDrive, Dropbox or anything else. Returned files are downloaded,
then dropped onto Transfers or chosen through **Import files**. No cloud API is involved at any point.

## Scanning: what Director will and will not read

A USB stick handed to a tournament director belongs to a volunteer. It has their photos on it.

Director looks in three places and no others:

1. `QBSheet/Results` and `QBSheet/Assignments`, which Director created
2. the root of a removable drive, shallowly and bounded, because "put it on the stick" is what a
   scorekeeper was actually told
3. a directory the director explicitly chose

**Director never recursively crawls arbitrary removable media.** A folder the director picked gets
the same restraint — it is their folder rather than a stranger's, but a recursive crawl of a Drive
root is still a bad thing to do during a round.

### Bounds

From [`limits.ts`](../src/director/transfers/limits.ts):

| Bound | Value |
| --- | --- |
| Largest QBJ document read | 8 MB |
| Entries examined per directory | 500 |
| Files parsed per batch | 200 |
| Entries examined in a drive root | 200 |
| Scan depth below a transfer root | 3 |
| JSON nesting depth | 64 |
| JSON nodes per document | 200,000 |

Anything that trips a bound is skipped **with a reason**, never silently: a director who put a file
in the right folder and saw nothing happen deserves to know why.

## Security boundaries

- **Every imported file is untrusted**, including one that arrived over an authenticated QBTCP
  session. The token says the connection is who it claims to be, not that the payload is well-formed.
- **Least-privilege filesystem access.** The window cannot read an arbitrary path. Every native
  operation resolves its argument against a registry of authorized roots — directories chosen in a
  native folder picker, or removable volumes the platform reported — and refuses anything outside
  one. The application never requests blanket access to the home directory.
- **Symlinks are never followed.** The authorization check runs on the *canonical* path, after
  symlinks and `..` are resolved, so a link on a stranger's stick pointing outside the transfer root
  is refused rather than read.
- **Path traversal is refused, not normalized.** A `..` component in a write path is rejected outright.
- **Prototype-pollution shapes are refused**: `__proto__`, `constructor` and `prototype` as keys.
- **Nothing is ever executed or opened.** The vocabulary is list, read, write, make a directory, ask
  about free space. There is no delete, no move, no rename, and no execute.
- **Nothing credential-shaped leaves Director.** `stripSecrets` runs over every document written to
  a file, unconditionally, including documents built entirely by Director's own code.
- **Transfer history is operational, not forensic.** It records that an assignment went to a drive
  and four results came back; it does not record file contents. A filesystem log dressed as
  tournament history would be both a privacy problem and useless during a round.

## Native implementation

[`apps/director/src-tauri/src/transfers.rs`](../apps/director/src-tauri/src/transfers.rs) provides:

| Command | Purpose |
| --- | --- |
| `transfers_list_volumes` | Enumerate mounted volumes via `sysinfo`'s disk API |
| `transfers_choose_folder` | Native folder picker; the pick is the grant |
| `transfers_authorize_root` | Re-grant a location saved in an earlier session |
| `transfers_forget_root` | Drop a grant |
| `transfers_list_directory` | One directory, bounded, links reported not followed |
| `transfers_read_file` | One file, size-checked from metadata before the read |
| `transfers_write_file` | Atomic write |
| `transfers_create_directory` | `mkdir -p` inside an authorized root |
| `transfers_exists`, `transfers_available_bytes` | Location status |

Volume detection reports mount point, display name, removable state, read-only state, and free
space. It does **not** hardcode `/Volumes` or Windows drive letters — `sysinfo` speaks to each
platform's own API, so a Linux stick under `/run/media/<user>/<label>` is found the same way.

Enumeration runs on a 4-second timer and folder scans on a 5-second timer, and a poll that finds
nothing writes no state at all. Only locations the director marked as *watched* are read; a
connected drive nobody asked to watch is left alone.

Filesystem access is behind a port
([`ports.ts`](../src/director/transfers/ports.ts)) so that platform behaviour is a property of one
small adapter. `MemoryTransferFileSystem` lets the tests unplug a drive between two lines of code.

## Browser preview

The browser-only Director preview cannot enumerate volumes, and it does not pretend to. It says so,
and offers drag-and-drop, a file picker, and browser downloads — which go through the same ingestion
pipeline as everything else. Nothing is removed from the desktop app to keep the preview at parity.

## Where things live

| | |
| --- | --- |
| Page | **Transfers**, under Run, between Tournament and Results |
| Internal subsystem name | triage (never user-facing) |
| Discover, import, stage, prepare, write, watch | Transfers |
| Inspect, review discrepancies, accept/reject/edit/reconcile | Results |

Shortcuts elsewhere navigate into Transfers rather than duplicating it: **Prepare assignment files**
on a round, **Prepare game file** on a room, **Import result files** on Results.

## Tests

| File | Covers |
| --- | --- |
| [`assignment.test.ts`](../src/director/transfers/assignment.test.ts) | QBJ shape, no leaked pairings, no secrets, filenames, manifest present and absent |
| [`filesystem.test.ts`](../src/director/transfers/filesystem.test.ts) | Volume discovery, disappearing drive, read-only drive, no space, bounds, symlinks, partial writes |
| [`ingest.test.ts`](../src/director/transfers/ingest.test.ts) | Classification, revisions, identity mismatches, batch with one bad file, input bounds |
| [`mixedTransport.test.ts`](../src/director/transfers/mixedTransport.test.ts) | Duplicate and conflict across transports, mixed-transport round, backup USB, locations appearing and disappearing, restart |
| [`workflow.test.ts`](../src/director/transfers/workflow.test.ts) | The whole tournament day against real temp directories, including opening an exported assignment with the scorer's own parser |
| `transfers.rs` tests | Root authorization, traversal refusal, symlink refusal, real atomic write |

For the parts CI cannot reach, see
[`TRANSFERS_DEVICE_CHECKLIST.md`](TRANSFERS_DEVICE_CHECKLIST.md).

## QBTCP is unchanged

File handoff supplements QBTCP; it does not replace or complicate it. QBTCP delivery is not routed
through the file subsystem — it writes the same history row a file delivery writes, so that "how did
room 104 get round 6" has one answer in one table.

A director may use file handoff as the primary transport, as a fallback, as a backup, or as a
recovery method, and QBSheet does not have an opinion about which.
