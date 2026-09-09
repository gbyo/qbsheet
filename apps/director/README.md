# QBSheet Director

This directory is the standalone Tauri 2 desktop application for tournament directors. It launches
the approved Director React surface from the repository's `src/director` tree while keeping the
desktop build, native runtime, capabilities, and data paths independent from the QBSheet Web scorer.

## Development

From the repository root:

```sh
npm install --prefix apps/director
npm run dev --prefix apps/director
```

That serves Director's user interface in a browser at <http://127.0.0.1:1420/>, which is how the UI
is developed and how `playwright.director.config.ts` drives it. It is not a way to run a tournament:
the durable store and the QBTCP listener are native, so the browser-served UI reports the limit
rather than pretending. To run the real desktop application, install the platform prerequisites
documented by Tauri and run:

```sh
npm run tauri:dev --prefix apps/director
```

The native build uses the package-local Vite output and can be produced with:

```sh
npm run tauri:build --prefix apps/director
```

The first install creates `apps/director/package-lock.json`; it is intentionally local to this
standalone package and does not alter the scorer's root lockfile or build configuration.

## Native boundary

The Rust side owns application directories, the durable SQLite store, native file selection and
save dialogs, diagnostic snapshots, atomic diagnostic export, and the lifecycle foundations for
single-instance behavior, window-state persistence, and signed updates. The React bridge in
`src/native.ts` is deliberately small so tournament repositories can be introduced without
leaking SQLite rows into the UI.

The Director React repository uses these native commands when running in Tauri:

- `director_load_state`, `director_save_state`, and `director_checkpoint` for the persisted
  document-shaped tournament state.
- `director_server_status`, `director_start_qbtcp_server`, and `director_stop_qbtcp_server` for
  the native QBTCP v1 LAN listener.

The server binds port `8787`, advertises the configured scoresheet origins, and projects saved room
metadata into the shared `qbtcp-server` protocol implementation. Add a room in Director before
starting it to receive a one-time pairing code and launch link.

## Releases

`.github/workflows/director-release.yml` builds Director for macOS, Windows, and Linux and publishes
them as one GitHub release. Push a `director-v*` tag to release; run the workflow by hand to build
the bundles without releasing them. The procedure, what the bundles are, and what code signing and
signed automatic updates still need is [`docs/DIRECTOR_RELEASE.md`](../../docs/DIRECTOR_RELEASE.md).

The updater endpoint and public signing key are release configuration. The checked-in configuration
keeps the updater plugin wired while `createUpdaterArtifacts` remains disabled: an ordinary build
needs no key and emits no signatures, and the release workflow enables updater artifacts for its own
build only once both halves of a release keypair exist.
