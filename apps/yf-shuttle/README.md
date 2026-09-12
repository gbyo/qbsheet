# YF Shuttle

A small offline desktop helper for tournaments that run YellowFruit → QBSheet → YellowFruit.

```text
YellowFruit  →  QBSheet Scorer  →  YellowFruit
```

YF Shuttle reads a `.yft`, writes ordinary one-game QBJ assignments into room `IN` folders,
reads completed QBJs back out of the `OUT` folders, and copies the chosen results byte-for-byte
into flat `YellowFruit Import/Round N` folders. The director imports those with stock
YellowFruit's own **Games → Import** workflow. After prelims, the director rebrackets in
YellowFruit, and YF Shuttle generates the playoff assignments from the reloaded file.

It is **not** a director, stats program, scheduler, server, or cloud client. YellowFruit stays
authoritative for identity, teams, rosters, scoring rules, phases, rounds, pools, standings,
advancement, and final data. YF Shuttle never writes, patches, or outputs a `.yft`.

## Tournament day

1. Open the `.yft` in YF Shuttle and confirm the Wildcat 12-team format.
2. Confirm the six room names, choose a project folder, create folders & prelim games.
3. Score each game in QBSheet from its room's `IN` file; place finished QBJs in that room's `OUT`.
4. Rescan OUT folders, resolve any duplicates, and prepare each round for YellowFruit.
5. In YellowFruit: Games → Import the prepared files, review standings, confirm Gold/Maroon
   advancement, save the `.yft`.
6. Load the updated file in YF Shuttle, confirm the F1–F6 / B1–B6 slots, generate playoffs.
7. Repeat steps 3–4 for rounds 6–8.

## What comes from the `.yft`

The file is read through QBSheet's existing importer (`@qbsheet/tournament-formats`) — no
second parser, and the file itself is never modified. Assignments take the tournament id and
name, teams and ids, rosters, registrations, phases, rounds, pools (for display), and the
completed scoring rules. Standings, advancement, statistics, and games already in the file are
left with YellowFruit.

## Identity

A game's identity is its QBJ `Match.id`: a hash of tournament id, round id, stable room-slot
id, and the two team ids in order. Regenerating an assignment reproduces the id; renaming a
room does not change it. Filenames are human guidance only — results are reconciled by Match
id, so a file in the wrong OUT folder is still identified correctly.

## The native shell

Tauri exists for the desktop capabilities a browser tab cannot do: a native `.yft` picker, a
native folder picker, creating nested folders, and writing dozens of files without download
prompts. The Rust layer only performs filesystem operations:

```text
open_yellowfruit_file()
choose_project_parent()
create_directories(base, dirs)
list_directory(path)
read_text_file(path)
write_text_file(path, contents, overwrite)
copy_file(src, dst, overwrite)
```

Assignment writes are exclusive; only the manifest and the derived import batches are ever
overwritten, on explicit action. Nothing is deleted automatically.

## Developing

```bash
npm run yf-shuttle:dev    # Vite, http://127.0.0.1:1426
npm run yf-shuttle:test   # unit tests
npm run yf-shuttle:build  # typecheck and production build
npm run yf-shuttle:tauri:dev    # the desktop application
npm run yf-shuttle:tauri:build  # YF Shuttle.app and the platform equivalents
```

Tests cover the places where a mistake ruins a real match: the preset transcription (30
prelims, full round robins, 18 playoffs), that QBSheet's own parser opens an assignment into
a playable game with no questions asked, that a scored result preserves the Match id inside a
document stock YellowFruit's importer resolves, Match-id stability, wrong-folder and
duplicate handling, untouched-assignment exclusion, foreign-tournament rejection, and
YellowFruit-faithful playoff ordering with ties that stop the line.
