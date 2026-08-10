# QBSheet

QBSheet is a standalone offline-first browser scoresheet for quiz bowl games. You can serve it as a
static site, install it as a PWA, or open it from a local build. A room can score from a single QBJ
file without an account, a database, or a network connection.

QBSheet reads and writes QBJ, and it connects to tournament-control software with QBTCP.

QBSheet owns the browser-safe scorer core and the QBJ parsing that both applications share. Fruity
consumes that same core through the package entry point. The desktop application and the browser
application therefore hold no separate scoring engine and no separate QBJ reader.

## Architecture

The interoperability model is small:

- **Files are QBJ.** One serialization covers assignments, results, and mid-game backups.
- **The network is [QBTCP](docs/QBTCP.md)**, an application-layer HTTP/JSON protocol for
  communication between electronic scoresheets and tournament-control software. QBTCP is not a
  transport protocol, and it does not replace TCP/IP.
- QBJ holds the game data and the tournament data. QBTCP is the live conversation around that data.
  QBTCP does not duplicate the QBJ schema.
- A QBTCP assignment body is a QBJ document. The connected path and the file path therefore go
  through one parser, and they cannot drift apart.
- `GameDefinition` is the internal shape that the scorer runs on. It is not a file format, not a wire
  format, and it carries no public version contract.

Specifications:

| Document | Covers |
| --- | --- |
| [`docs/QBTCP.md`](docs/QBTCP.md) | The protocol: discovery, pairing, assignment, progress, result, recovery, help, writer ownership, CORS and local network access, security |
| [`docs/QBJ_ASSIGNMENT_PROFILE.md`](docs/QBJ_ASSIGNMENT_PROFILE.md) | Which QBJ fields QBSheet uses, graceful degradation, the `_qbtcp` extension, privacy rules, filenames |
| [`docs/QBG_MIGRATION.md`](docs/QBG_MIGRATION.md) | The retirement of `.qbg`, and the `/api/v1` → `/qbtcp/v1` route mapping |
| [`docs/TEST_FILE_GENERATION.md`](docs/TEST_FILE_GENERATION.md) | How developers and coding agents generate realistic QBJ, YFT, SQBS, QBG, recovery, and report fixtures |

Legacy `.qbg` game files and the older `/api/v1` server surface both still work. QBSheet writes
neither, and prefers neither.

## Workflows

- **Open a game file.** Choose a QBJ assignment, score locally, then download the finished QBJ. A
  whole-tournament QBJ opens a game picker. A document that omits the scoring rules asks for them
  instead of an assumed rule set.
- **Connect to tournament control.** Enter the address of the control server, verify the room
  identity, pair the room, then score the assigned game. The package and the credentials stay
  separate. QBSheet writes no token into a game package or a portable QBJ.
- **Recover locally.** QBSheet writes the current event journal synchronously to `localStorage`, and
  mirrors the package, the record state, and the finished QBJ in IndexedDB. When IndexedDB is
  unavailable, the scoresheet stays usable and reports that local persistence is not durable.

QBSheet retains a completed record locally for seven days. It does not remove a record because a
server accepted a result, and it does not remove a record because a scorekeeper downloaded a QBJ.

A connected game keeps an explicit handoff acknowledgement. A file-only game is complete once QBSheet
has written its QBJ successfully.

## Static hosting

The build needs no backend. It is configured for GitHub Pages and other static hosts:

```sh
npm ci
npm run lint
npm run typecheck
npm test -- --run
npm run build
```

Vite uses relative asset paths by default, so one build works at the domain root, below a GitHub
Pages repository path, and from a local directory. A deployment that needs an absolute path can set
`BASE_PATH`:

```sh
BASE_PATH=/qbsheet/ npm run build
```

The generated service worker precaches the shell and the content-hashed assets. It uses network-first
navigation with the cached shell as the offline fallback, and it does not cache a response from a
tournament-control origin.

The GitHub Pages workflow publishes `dist/` with the official Pages actions, and it needs no
repository secret. Set the repository Pages setting to **GitHub Actions**.

For local development, run `npm start`. Then configure Fruity's Local Tournament Server to allow the
origin that Vite prints, normally `http://localhost:5173`. Enter the local network address of the
server in the scoresheet. The origin allowlist of the local server is separate from room pairing.
Every operation on a paired room still needs a valid room or session credential.

## Files

Every public file is QBJ, at serialization version `2.1.1`, with the media type
`application/vnd.quizbowl.qbj+json`.

| Reads | Writes |
| --- | --- |
| Official serialized QBJ (`{version, objects}`) — one game or a whole tournament | Official serialized QBJ |
| Match-only QBJ, as MODAQ and older workflows produce | Match-only QBJ, under a secondary menu entry, for compatibility |
| Legacy `.qbg` game packages | — |

A filename carries a descriptive suffix: `.assignment.qbj`, `.result.qbj`, or `.partial.qbj`. The
suffix is guidance for a person. Nothing reads a filename to decide what a document is, or to decide
which game it belongs to. The identifiers inside the document carry the identity.

A completed result preserves the `Tournament`, `Phase`, `Round`, and `Match` of the assignment, and it
preserves the team and player identifiers. Reconciliation on the tournament-control side is therefore
a lookup rather than a match against a filename.

Operational information that QBJ cannot express travels in a small optional non-secret `_qbtcp`
extension on the Match. It covers the round revision, a stable room identifier, the procedure, the
handoff instruction, and whether rounds are timed.

A portable file never contains a room or session token, a pairing code, a device identifier, a server
address, or the private recovery journal of the scorer. Results written before this migration remain
readable through their `_qbsheet_source` and `_scoresheet_source` blocks.

## Recovery and portable files

**Game → Download current QBJ** writes the game so far as a portable partial. It carries the
statistics, the lineups, and the per-question record that standard QBJ can express, and QBSheet can
reopen it.

A portable partial is not the recovery mechanism. The local event journal in `localStorage` and
IndexedDB remains authoritative for exact recovery. It holds the event history, the undo state, the
clock internals, the connection state, and the outbox, and QBJ can represent none of them.

A portable partial therefore serves a device that is no longer available. It does not replace the
journal.

## Development boundary

The first-party scorer and browser application were extracted from YellowFruit/Fruity at source
commit `970ac055`. QBSheet is the canonical home for the scorer and the game package contract.

The root package entry point is browser-independent. Fruity pins this repository as a Git dependency
while the shared package stabilizes for a registry release. The room host in Fruity remains
desktop-specific, and its scoring engine and portable result projection come from QBSheet.

## Contributing

Bug reports, tests at real tournaments, and code are all welcome. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the setup, the checks to run before a pull request, the test
layout, the offline-first constraints, and the rules for a change to the specifications in `docs/`.

The [Code of Conduct](CODE_OF_CONDUCT.md) governs participation. Report a vulnerability through
[`SECURITY.md`](SECURITY.md) rather than a public issue.

## License and attribution

This project remains available under the GNU Affero General Public License, version 3 or later. See
[`LICENSE`](LICENSE). It preserves the first-party scorer, the UI, and the attribution from the
YellowFruit project. See [`NOTICE.md`](NOTICE.md) for the extraction provenance and the intended
ownership boundary.
