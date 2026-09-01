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

The browser preview is served at <http://127.0.0.1:1420/>. To run the native shell, install the
platform prerequisites documented by Tauri and run:

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

The updater endpoint and public signing key are release configuration. The checked-in configuration
keeps the updater plugin wired while `createUpdaterArtifacts` remains disabled until a release key
is supplied by the distribution pipeline.
