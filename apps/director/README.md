# QBSheet Director

This directory is the Tauri 2 desktop application for tournament directors. It launches the approved
Director React surface from the repository's `src/director` tree while keeping the desktop build,
native runtime, capabilities, and data paths independent from the QBSheet Web scorer. That
independence is a product and runtime boundary, not a packaging one: Director ships as its own
application, and it builds as a workspace of this repository.

## Development

Director is a workspace of the repository root, and the root install is the only install. From the
repository root:

```sh
npm ci
npm run director:dev
```

There is no package-local install. `npm install --prefix apps/director` cannot work, and neither can
a lockfile committed beside this README, for two reasons that are both structural rather than
incidental:

- `src/main.tsx` imports `../../../src/director/DirectorApp`. The application Director compiles is
  the root repository's `src/director` tree, so the surface being built lives outside this package
  and resolves its own imports from the root `node_modules` no matter what this package installed.
- That surface depends on `@qbsheet/tournament-core` and `@qbsheet/tournament-formats`, which are
  built out of `packages/` by the root `prepare` script and published to no registry. A
  non-workspace install has nowhere to resolve them from.

`npm ci` at the root is what `.github/workflows/ci.yml`'s `director-ui` job runs, so the documented
path and the tested path are the same one.

`npm run director:dev` serves Director's user interface in a browser at <http://127.0.0.1:1420/>,
which is how the UI is developed and how `playwright.director.config.ts` drives it. It is not a way
to run a tournament: the durable store and the QBTCP listener are native, so the browser-served UI
reports the limit rather than pretending. To run the real desktop application, install the platform
prerequisites documented by Tauri and run:

```sh
npm run director:tauri:dev
```

The native build uses the package-local Vite output and can be produced with:

```sh
npm run director:tauri:build
```

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

The updater endpoint and public signing key are release configuration. The checked-in configuration
keeps the updater plugin wired while `createUpdaterArtifacts` remains disabled until a release key
is supplied by the distribution pipeline.
