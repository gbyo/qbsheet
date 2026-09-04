# Director tournament release smoke test

Run this on the actual Director computer and scorer machines using the release candidate.
Automated tests cannot verify removable-media detection, OS permissions, write caching, or eject.
Keep the detailed [device checklist](TRANSFERS_DEVICE_CHECKLIST.md) for platform and failure testing.

Record release commit/build, OS version, scorer version, drive label/filesystem, tester, date,
and pass/fail beside each step. Do not use the only copy of a real tournament for the recovery drill.

- [ ] Install the release build on the tournament Director computer.
- [ ] Create or open the real tournament. Confirm ten teams and the correct scoring rules.
- [ ] Use the full round-robin plan: nine rounds, five games per round, 45 unique pairings.
- [ ] Assign packets and optional rooms. Insert Lunch after Round 5; leave clock times blank.
- [ ] Restart Director. Check teams, assignments, and Round 1–5 / Lunch / Round 6–9 order.
- [ ] With no USB or QBTCP in use, confirm neither blocks Start Round 1.
- [ ] Insert the tournament USB. Confirm its correct label appears in the round's USB action.
- [ ] Prepare Round 1 from Rounds. Confirm “Round 1 copied to [drive] — eject normally.”
- [ ] Eject through the OS. Open the assignment on a scorer machine while offline; verify teams,
      room, round, packet, roster, and scoring rules.
- [ ] Score a game, save its completed QBJ in `QBSheet/Results`, and eject normally.
- [ ] Reinsert in Director while Overview or Rounds is open. Confirm returned-result attention appears.
- [ ] Open Review, verify matching, source, score, and warnings. Nothing is accepted automatically.
- [ ] Restart Director with this staged result. Verify it is still available for review.
- [ ] Accept the result. Verify one accepted game and correct standings.
- [ ] Prepare the same USB again. Unplug/reinsert after OS eject. No duplicate game or partial file.
- [ ] Check a round with a missing result: the outstanding count is exact and opens that round in Results.
- [ ] Finish all games in Round 5. Confirm Lunch appears before Round 6.
- [ ] If QBTCP will be used: pair an actual scorer on the tournament LAN, receive its assignment,
      submit one result, and verify review/accept. Also return that result by file: no second game.
- [ ] Disable internet access while preserving LAN connectivity if QBTCP is used. Run another complete
      round through Start, score, return/manual entry, accept, finish, and standings.
- [ ] In Settings → Recovery, create a recovery point. Change a team or remove a test round.
- [ ] Restore the earlier point. Verify the prior teams, rounds, scores, staged results, and day order.
- [ ] Verify “Before restoring…” exists; restore it to undo the restore. Operator identity stays unchanged.
- [ ] Restart again. Verify the tournament, transfer history, staged results, and recovery list persist.
- [ ] If QBTCP was active during restore: verify refreshed assignments and re-pair scorers as needed.
      Newer results must not silently reappear from retained native packets after restoring an older point.
- [ ] Export a portable archive to a separate device. Recovery points share the local database and
      do not protect against losing that computer or disk.

Any failure blocks tournament release until it is fixed and the affected steps pass again.
