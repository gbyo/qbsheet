# QBSheet

QBSheet is a standalone, offline-first browser scoresheet for quiz bowl games. It can be served as
a static site, installed as a PWA, or opened from a local build. A room can score from a single
`.qbg` game package without an account, a database, or a network connection.

QBSheet's package format remains provisional (`quizbowl-game`, version 1) and may be moved to a
shared package once the standalone and tournament applications have settled their ownership boundary.

## Workflows

- **Open a game file**: choose a `.qbg` package, score locally, and download the finished QBJ.
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

## Game packages and results

A `.qbg` contains one game: tournament identity, scheduled match identity when available, round and
assignment revision, room, both rosters, scoring format, procedure, and optional human handoff
instructions. It contains no room token, session token, device secret, server address, standings, or
other rooms' games.

Finished results are downloaded as portable QBJs. The `_scoresheet_source` extension identifies the
source tournament, scheduled match, round, revision, and room so tournament control can reconcile a
result without trusting a filename. The scorer's private recovery journal is intentionally omitted
from that portable file.

## Development boundary

The first-party scorer and browser application were extracted from YellowFruit/Fruity at source
commit `970ac055`. QBSheet is now the canonical home for the standalone scorer and its game package
workflow. Fruity retains its transitional in-tree copy until a later shared-package change can
remove duplication safely; changes to the portable package contract should therefore be kept
compatible and documented in both locations.

## License and attribution

This project remains available under the GNU Affero General Public License, version 3 or later; see
[`LICENSE`](LICENSE). It preserves the first-party scorer, UI, and attribution from the YellowFruit
project. See [`NOTICE.md`](NOTICE.md) for extraction provenance and the intended ownership boundary.
