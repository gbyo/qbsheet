# QBSheet

QBSheet is a standalone, offline-first browser scoresheet for quiz bowl games. It can be served as
a static site, installed as a PWA, or opened from a local build. A room can score from a single QBJ
file without an account, a database, or a network connection.

> **QBSheet reads and writes QBJ, and connects to tournament-control software using QBTCP.**

QBSheet owns the browser-safe scorer core and the QBJ parsing that both applications share. Fruity
consumes that same core through the package entry point, so the desktop and browser applications do
not maintain separate scoring engines or separate QBJ readers.

## Architecture

The interoperability model is deliberately small:

- **Files are QBJ.** One serialization for assignments, results, and mid-game backups.
- **The network is [QBTCP](docs/QBTCP.md)**, an application-layer HTTP/JSON protocol for
  communication between electronic scoresheets and tournament-control software. It is *not* a
  transport protocol and not a replacement for TCP/IP.
- QBJ is the game and tournament data; QBTCP is the live conversation around that data. QBTCP does
  not duplicate QBJ's schema.
- A QBTCP assignment body *is* a QBJ document, so the connected path and the file path go through
  one parser and cannot drift apart. `GameDefinition`, what the scorer runs on, is internal: not a
  file format, not a wire format, and not versioned as a public contract.

Specifications:

| Document | Covers |
| --- | --- |
| [`docs/QBTCP.md`](docs/QBTCP.md) | The protocol: discovery, pairing, assignment, progress, result, recovery, help, writer ownership, CORS/LAN, security |
| [`docs/QBJ_ASSIGNMENT_PROFILE.md`](docs/QBJ_ASSIGNMENT_PROFILE.md) | Which QBJ fields are used, graceful degradation, the `_qbtcp` extension, privacy rules, filenames |
| [`docs/QBG_MIGRATION.md`](docs/QBG_MIGRATION.md) | Retiring `.qbg`, and the `/api/v1` → `/qbtcp/v1` route mapping |

Legacy `.qbg` game files and the older `/api/v1` server surface both still work; neither is written
or preferred any more.

## Workflows

- **Open a game file**: choose a QBJ assignment, score locally, and download the finished QBJ. A
  whole-tournament QBJ opens a game picker; a document that omits scoring rules asks for them
  rather than assuming a rule set.
- **Connect to tournament control**: enter the control server address, verify the room identity,
  pair the room, and score the assigned game. The package and the credentials stay separate; no
  token is written into a game package or portable QBJ.
- **Recover locally**: the current event journal is written synchronously to `localStorage`, while
  the package, record state, and finished QBJ are mirrored in IndexedDB. If IndexedDB is unavailable,
  the scoresheet remains usable but says that local persistence is not durable.

Completed records are retained locally for seven days. They are never removed merely because a
server accepted a result or because a QBJ was downloaded. Connected games keep an explicit handoff
acknowledgement; file-only games are complete once their QBJ has been written successfully.

## Static hosting

The build has no backend requirement. It is configured for GitHub Pages and other static hosts:

```sh
npm ci
npm run lint
npm run typecheck
npm test -- --run
npm run build
```

Vite uses relative asset paths by default, so the same build works at the domain root, below a
GitHub Pages repository path, and from a local directory. A deployment that needs an absolute path
can set `BASE_PATH`, for example:

```sh
BASE_PATH=/qbsheet/ npm run build
```

The generated service worker precaches the shell and content-hashed assets. It uses network-first
navigation with the cached shell as the offline fallback and deliberately does not cache responses
from a tournament-control origin.

The GitHub Pages workflow publishes `dist/` with the official Pages actions and does not require a
repository secret. The repository's Pages setting must still be configured to use **GitHub Actions**.

For local development, run `npm start` and configure Fruity's Local Tournament Server to allow the
origin printed by Vite (normally `http://localhost:5173`). Enter the server's LAN address in the
scoresheet; the local server's origin allowlist is separate from room pairing and still requires a
valid room/session credential.

## Files

Every public file is QBJ, at serialization version `2.1.1`, with the media type
`application/vnd.quizbowl.qbj+json`.

| Reads | Writes |
| --- | --- |
| Official serialized QBJ (`{version, objects}`) — one game or a whole tournament | Official serialized QBJ |
| Match-only QBJ, as MODAQ and older workflows produce | Match-only QBJ, under a secondary menu entry, for compatibility |
| Legacy `.qbg` game packages | — |

Filenames carry a descriptive suffix — `.assignment.qbj`, `.result.qbj`, `.partial.qbj` — which is
guidance for humans. Nothing reads a filename to decide what a document is or which game it belongs
to; the ids inside it are the identity.

A completed result preserves the assignment's `Tournament`, `Phase`, `Round`, `Match`, team and
player ids, so reconciliation on the tournament-control side is a lookup rather than a fuzzy match.
Operational information QBJ cannot express — the round revision, a stable room id, procedure, the
handoff instruction, and whether rounds are timed — travels in a small, optional, non-secret
`_qbtcp` extension on the Match.

Portable files never contain a room or session token, a pairing code, a device id, a server address,
or the scorer's private recovery journal. Results written before this migration remain readable via
their `_qbsheet_source` and `_scoresheet_source` blocks.

## Recovery, and what a portable file is not

**Game → Download current QBJ** writes the game so far as a portable partial. It carries the
statistics, lineups and per-question record that standard QBJ can express, and it can be reopened.

It is not the recovery mechanism. The local event journal in `localStorage` and IndexedDB remains
authoritative for exact recovery — event history, undo, clock internals, connection state and the
outbox — none of which QBJ can faithfully represent. A partial QBJ is a lifeboat for a dead
Chromebook, not a substitute for the journal.

## Development boundary

The first-party scorer and browser application were extracted from YellowFruit/Fruity at source
commit `970ac055`. QBSheet is the canonical home for the scorer and game package contract. The root
package entry point is intentionally browser-independent; Fruity pins this repository as a Git
dependency while the shared package is stabilized for a registry release. Its room host remains
desktop-specific, but its scoring engine and portable result projection come from QBSheet.

## License and attribution

This project remains available under the GNU Affero General Public License, version 3 or later; see
[`LICENSE`](LICENSE). It preserves the first-party scorer, UI, and attribution from the YellowFruit
project. See [`NOTICE.md`](NOTICE.md) for extraction provenance and the intended ownership boundary.
