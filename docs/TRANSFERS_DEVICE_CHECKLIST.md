# Transfers: real-device checklist

The automated tests cover everything a temp directory and a fake filesystem can cover, which is most
of it — see [`TRANSFERS.md`](TRANSFERS.md#tests). This is the remainder: the things that need a
physical drive, a real operating system, and a person watching.

Run it on macOS, Windows and Linux before a release that touches
[`src/director/transfers/`](../src/director/transfers/) or
[`apps/director/src-tauri/src/transfers.rs`](../apps/director/src-tauri/src/transfers.rs).

## What you need

- The Director desktop app (`npm run director:tauri:dev`), not the browser preview
- Two USB drives: one FAT32 or exFAT, one formatted by the platform you are testing on
- Optionally, one drive with a physical write-protect switch, or a mounted read-only image
- A cloud sync client signed in (Google Drive, OneDrive or Dropbox), if testing cloud folders
- A tournament with at least four teams, two rooms and one released round

Record the platform, OS version, and drive filesystem next to each result. A failure that only
happens on exFAT is a different bug from one that happens everywhere.

---

## 1. Detection

| # | Step | Expected |
| --- | --- | --- |
| 1.1 | Open Transfers with no drive connected | No removable locations listed |
| 1.2 | Insert an empty drive | It appears in **Locations** within ~5 seconds, named as the OS names it |
| 1.3 | Check the name | Matches the volume label the OS shows, not the mount path |
| 1.4 | Remove the drive | It stays listed, marked **Not connected** — it is not deleted |
| 1.5 | Re-insert it | Returns to **Connected**; still one row, not two |
| 1.6 | Confirm the internal disk is not listed | Only removable volumes are adopted automatically |

**Linux note.** Sticks usually mount under `/run/media/<user>/<label>` or `/media/<user>/<label>`
depending on the desktop environment. Both must work. If a drive is not detected, check whether it
was auto-mounted at all before filing a bug.

**Windows note.** Check both a lettered drive (`E:\`) and, if you can arrange one, a volume mounted
into a directory. Neither may be special-cased.

**macOS note.** The first read of a removable volume may raise the system's own removable-media
permission prompt. Grant it and confirm detection then works; then confirm it still works after a
restart of the app.

---

## 2. Not scanning someone's drive

| # | Step | Expected |
| --- | --- | --- |
| 2.1 | Put photos, documents and a few hundred unrelated files on a drive, in nested folders | Drive appears; **no** notice about QBSheet data |
| 2.2 | Watch CPU and disk while it is connected for a minute | No sustained activity; no crawl of the nested folders |
| 2.3 | Put one loose `.qbj` result in the drive root | Notice appears naming the count |
| 2.4 | Put a `.qbj` five folders deep, outside `QBSheet/` | **Not** found — this is the point of the rule |
| 2.5 | Put a 2 GB file renamed to `.qbj` in `QBSheet/Results` | Skipped with a size reason; the window does not stall |

---

## 3. Preparing a drive

| # | Step | Expected |
| --- | --- | --- |
| 3.1 | Prepare the current round onto an empty drive | `QBSheet/Assignments`, `QBSheet/Results`, `README.txt`, `transfer.json` all created |
| 3.2 | Read the filenames on the drive in the OS file manager | `Round 5 - Room 101 - Ninety Six A vs Greenwood A.qbj` — readable, no mangled characters |
| 3.3 | Open `README.txt` in the platform's default text editor | Readable; line endings do not run together |
| 3.4 | Confirm the completion message | Says *eject the drive normally*; does **not** say safe to remove |
| 3.5 | Move the drive to another platform and list it | Every filename opens; none is rejected as invalid |
| 3.6 | Prepare the same round twice onto the same drive | Files replaced cleanly; no `.tmp` files left in `Assignments` |

**Filename stress.** Temporarily rename a team to include `: / \ ? *` and a trailing dot, and one to
a long name, and prepare again. Every file must be creatable and openable on all three platforms.

---

## 4. Interoperability

| # | Step | Expected |
| --- | --- | --- |
| 4.1 | Open a prepared `.qbj` in QBSheet Web on another machine, offline | Opens directly; correct teams, room, round, rosters |
| 4.2 | Check the scoring setup | Format is taken from the file; the scorer does not ask you to choose one |
| 4.3 | Score the game to completion and save the result QBJ | Saves without error |
| 4.4 | Open a prepared `.qbj` in a non-QBSheet QBJ tool if one is available | Reads it as ordinary QBJ |
| 4.5 | Inspect the file in a text editor | No token, no pairing code, no other round, no other room's pairing |

---

## 5. The round trip

| # | Step | Expected |
| --- | --- | --- |
| 5.1 | Put the completed result into `QBSheet/Results` on the drive and re-insert it | Notice names the completed game count |
| 5.2 | Open Transfers | The result is listed **Ready**, matched to the right room and round |
| 5.3 | Rename the file to another room's game before importing | Still matched to the correct game — identity comes from the QBJ |
| 5.4 | Accept it on Results | Standings update |
| 5.5 | Re-insert the same drive | The result is **not** staged a second time |
| 5.6 | Copy the same result file to the drive root as well and re-insert | Recognised as a duplicate; no second game |

---

## 6. Media that misbehaves

| # | Step | Expected |
| --- | --- | --- |
| 6.1 | Prepare onto a write-protected drive | Refused with a read-only message; nothing written |
| 6.2 | Prepare onto a nearly full drive | Refused before writing, or partial success naming what did not fit |
| 6.3 | **Pull the drive during a prepare** | Error message names the drive; app does not hang or crash |
| 6.4 | Re-insert the drive from 6.3 and inspect `Assignments` | Only complete files; **no `.tmp` files and no truncated `.qbj`** |
| 6.5 | Pull the drive during a scan | Scan reports the drive went away; already-read results are kept |
| 6.6 | Insert a drive with a `QBSheet/transfer.json` truncated mid-file | Manifest ignored; the `.qbj` files still import |
| 6.7 | Delete `transfer.json` entirely and re-scan | Everything still imports |
| 6.8 | On Unix, put a symlink in `QBSheet/Results` pointing outside the drive | Not followed; listed as skipped |

6.4 is the most important line in this document. A truncated `.qbj` that still parses is the failure
mode that loses a game quietly.

---

## 7. Cloud-synced folders

| # | Step | Expected |
| --- | --- | --- |
| 7.1 | Add a folder inside Google Drive / OneDrive / Dropbox | Added; provider named; offline advisory shown |
| 7.2 | Confirm the advisory wording | Recommends making it available offline; does not claim QBSheet can do it |
| 7.3 | Prepare a round into it and watch the sync client | Files appear and sync |
| 7.4 | On a second machine, drop a completed result into its `Results` folder | Staged on the first machine within ~5 seconds of syncing |
| 7.5 | Set the folder to online-only / evict a file, then scan | Explains that the file is not available locally; retry works after the client fetches it |
| 7.6 | Confirm the evicted file afterwards | Unchanged and not deleted |
| 7.7 | Sign out of the sync client so the folder disappears | Location marked unavailable with a reason; not deleted from the list |
| 7.8 | Sign back in | Location recovers on its own |

---

## 8. Network shares and external drives

| # | Step | Expected |
| --- | --- | --- |
| 8.1 | Add a folder on an SMB/AFP/NFS share | Works like any other folder |
| 8.2 | Disconnect from the network mid-round | Location reports unavailable; the rest of Director keeps working |
| 8.3 | Reconnect | Recovers without re-adding |
| 8.4 | Add a folder on a non-removable external drive | Addable manually even though it is not auto-detected |

---

## 9. Restart and persistence

| # | Step | Expected |
| --- | --- | --- |
| 9.1 | Configure a USB location and a folder location, then quit and reopen Director | Both still listed |
| 9.2 | Check the folder location after restart | Readable without re-picking it |
| 9.3 | Check the USB location with the drive absent, then insert it | Marked not connected, then reconnects |
| 9.4 | Confirm staged-but-unaccepted results survived the restart | Still in the Results inbox |
| 9.5 | Re-scan a drive whose results were imported before the restart | Nothing staged twice |

---

## 10. Mixed transport, end to end

Run one round where each room uses a different mechanism:

| Room | Mechanism |
| --- | --- |
| 101 | QBTCP |
| 102 | USB |
| 103 | Cloud-synced folder |
| 104 | Paper, entered by hand on Results |

| # | Step | Expected |
| --- | --- | --- |
| 10.1 | Prepare files for **all four** rooms, including the connected one | All four files written; no complaint about room 101 being connected |
| 10.2 | Return each result by its own route | All four land on the right scheduled games |
| 10.3 | Also return room 101's result on the USB drive | Recognised as a duplicate; one game |
| 10.4 | Return a **different** result for room 102 by the other route | Conflict staged for review; neither accepted automatically |
| 10.5 | Check the transfer history | Reads as one list; QBTCP deliveries appear alongside file deliveries |
| 10.6 | Close the round | Closes normally once all four are accepted |

---

## 11. Offline

| # | Step | Expected |
| --- | --- | --- |
| 11.1 | Disable Wi-Fi and unplug Ethernet | — |
| 11.2 | Repeat sections 3, 4 and 5 in full | Everything behaves identically |
| 11.3 | Confirm no error mentions the network | — |

---

## 12. Stale revisions

| # | Step | Expected |
| --- | --- | --- |
| 12.1 | Prepare a round onto a drive | — |
| 12.2 | Regenerate or repair the round so its revision increases | — |
| 12.3 | Score one of the **old** files and return it | Staged **Needs review**, explaining it came from an older revision |
| 12.4 | Confirm the current scheduled game | Not silently overwritten |

---

## Reporting

For anything that fails, record: platform and version, drive filesystem and size, the step number,
what happened, and whether a `.tmp` or truncated file was left on the drive. Attach the transfer
history from the Transfers page and the diagnostics bundle from Settings.
