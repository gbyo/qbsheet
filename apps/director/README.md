# QBSheet Director desktop shell

This directory is a standalone Tauri 2 application for the Director surface. Its frontend imports the
existing Director UI from `src/director/DirectorApp.tsx` and `src/director/director.css` so the desktop
application stays visually aligned with the web preview without duplicating that UI.

## Development

From this directory:

```sh
npm install
npm run tauri:dev
```

The ordinary Vite preview is also useful when working on the shared UI:

```sh
npm run dev
```

The desktop shell requires Node.js 20 or later and a Rust toolchain supported by Tauri 2. The native
commands live in `src-tauri/src/lib.rs`; the TypeScript boundary is in `src/platform/tauri.ts`.

## Native boundary

- `get_app_data_paths` reports the OS-specific application directories resolved by Tauri.
- `open_tournament_file` opens a native file picker and reads only the selected UTF-8 QBJ/QBG/JSON file.
- `save_tournament_snapshot` opens a native save picker and writes only the path the user selected.
- `write_diagnostics` writes a small runtime report to the app log directory, while
  `export_diagnostics` uses a native save picker.
- SQLite is registered through `tauri-plugin-sql` and migrates `director_shell_events` in
  `sqlite:director.sqlite`. The frontend records shell lifecycle events as an integration hook for the
  future tournament store.
- Single-instance focus, window-state restore/save, and updater registration are initialized in Rust.
  Updater checks intentionally remain unavailable until a release signing public key and HTTPS
  endpoint are supplied in `src-tauri/tauri.conf.json`.

The capability file grants only the SQL and window-state operations used by this shell plus the
explicit application commands. File access is kept inside Rust commands rather than granting the
frontend a broad filesystem scope.

## Release preparation

Generate the platform icon set from the repository icon before packaging:

```sh
npm run tauri icon ../../public/icon.svg
```

Before enabling release updates, replace the updater public-key placeholder and add one or more HTTPS
endpoints in `src-tauri/tauri.conf.json`, then set `bundle.createUpdaterArtifacts` to `true` in the
release configuration. Keep the private signing key outside the repository.

Build platform bundles with:

```sh
npm run tauri:build
```

Platform-specific defaults are kept in `src-tauri/tauri.macos.conf.json`,
`src-tauri/tauri.windows.conf.json`, and `src-tauri/tauri.linux.conf.json`.
