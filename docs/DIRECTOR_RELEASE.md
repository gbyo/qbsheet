# Releasing QBSheet Director

Director is a Tauri desktop application, so a release is not one file. It is a set of per-platform
bundles that can only be built on their own operating system, gathered into a single GitHub release.
[`.github/workflows/director-release.yml`](../.github/workflows/director-release.yml) does the
gathering; this document is the procedure around it.

This is about *publishing* Director. What to verify before publishing is
[the tournament release smoke test](DIRECTOR_TOURNAMENT_RELEASE_CHECKLIST.md), and it is not
optional: the checks in CI cannot see removable media, OS permissions, write caching, or eject.

## Cut a release

1. **Bump the version.** Director's version is written in four places, and all four have to agree:

   | File | What its copy decides |
   | --- | --- |
   | `apps/director/src-tauri/tauri.conf.json` | the installer file names, the About window, and the version the updater compares |
   | `apps/director/package.json` | the npm package the Tauri shell builds from |
   | `apps/director/src-tauri/Cargo.toml` | the native crate |
   | `package-lock.json` | npm's record of `apps/director` in the workspace |

   Edit the first three by hand; `npm install` writes the workspace lockfile. Then check the result:

   ```sh
   node scripts/release/director-version.mjs --tag director-v0.2.0
   ```

   That is the same guard the workflow runs first, and it is worth running locally because it is
   the one failure that is expensive to discover late: a tag over a stale `tauri.conf.json`
   publishes a release named 0.2.0 whose installers are all named 0.1.0.

2. **Merge the bump.** A release is built from a tag, and a tag on a commit that is not on `main` is
   a release nobody can reproduce.

3. **Push the tag.**

   ```sh
   git tag director-v0.2.0
   git push origin director-v0.2.0
   ```

   The prefix is not decoration. This repository releases the scorer, QBSheet Live, and Director
   independently, and a bare `v0.2.0` would not say which of them moved.

4. **Watch the three bundle jobs.** They create a *draft* release and upload into it. The draft
   becomes visible only after all three succeed — so a Windows bundling failure cannot leave a
   published release that directors on Windows can see and cannot download. If one platform fails,
   the other two bundles are already in the draft: fix the cause, delete the tag, and push it again.

## Try the release build without releasing

Run the workflow from the Actions tab (`workflow_dispatch`). With no tag it creates no release and
publishes nothing; the bundles come back as workflow artifacts.

Do this after any change to the workflow, to `src-tauri`, or to a Rust dependency. A bundling
failure is specific to the bundler and the runner — the AppImage tooling, the WiX toolchain, a
cross-architecture build of `rusqlite`'s bundled SQLite — and ordinary CI never bundles, so CI
cannot tell you about it. A dispatch run is the only check that exists for it, and it does not cost
a tag you would then have to delete.

## What gets published

The macOS bundle is `universal-apple-darwin`: one download for both Apple silicon and Intel, so a
tournament director does not have to know which processor their Mac has.

| Platform | Files |
| --- | --- |
| macOS | `.dmg`, and `.app.tar.gz` when updates are signed |
| Windows | `-setup.exe` (NSIS), `.msi` (WiX, for administrator deployment) |
| Linux | `.AppImage`, `.deb`, `.rpm` |

The Linux bundles link against the glibc of the runner they were built on, so the runner image in
the workflow matrix decides the oldest distribution Director supports. It is pinned to
`ubuntu-22.04` for that reason rather than tracking `ubuntu-latest`, and moving it forward raises
the floor — worth a line in the release notes when it happens.

## Code signing is not configured

The published bundles are not code-signed, and users see it:

- **macOS** refuses an unsigned application on first open. Right-click it in Applications and choose
  Open, which is the escape hatch Apple leaves for exactly this. The release notes say so.
- **Windows** shows a SmartScreen warning until the download has enough reputation.

Both need paid certificates this project does not hold. When one exists, the change is confined to
the `bundle` job of the release workflow:

- **macOS** wants `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and,
  for notarization, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`. Set them only when the
  secrets exist — an empty `APPLE_CERTIFICATE` is not the same as an absent one, and the difference
  is a keychain import that fails halfway through a release.
- **Windows** wants a `bundle.windows.certificateThumbprint` or a `signCommand` in the Tauri
  configuration, which means the certificate has to be reachable from the runner.

Do not wire either one speculatively. A signing path that has never run is not a signing path.

## Signed automatic updates

Director ships the Tauri updater plugin, pointed at
`https://github.com/gbyo/qbsheet/releases/latest/download/latest.json`. It stays inert until both
halves of a signing keypair exist, and the halves live in deliberately different places.

1. **Generate the keypair.** Once, ever. Keep the private key somewhere it can be recovered:
   losing it means no installed Director can ever be updated again, because the public key it
   verifies against is baked into every copy already installed.

   ```sh
   npm run tauri --workspace=@qbsheet/director -- signer generate -w ~/.tauri/qbsheet-director.key
   ```

2. **Check the public key in.** Replace `REPLACE_WITH_RELEASE_PUBLIC_KEY` in
   `apps/director/src-tauri/tauri.conf.json` with the printed public key. It is public by design:
   every installed copy needs it to verify an update.

3. **Add the private key as a repository secret.** `TAURI_SIGNING_PRIVATE_KEY`, with
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if you gave it a password. Nothing else may ever hold it.

The workflow's `guard` job tests for both halves and reports what it found. When either is missing
the release is still a complete release of installers — it simply cannot also be an update, so the
workflow leaves `createUpdaterArtifacts` off rather than publishing signatures no installed Director
could verify. When both are present it layers
[`tauri.updater.conf.json`](../apps/director/src-tauri/tauri.updater.conf.json) over the checked-in
configuration for that build alone, and a `latest.json` covering all three platforms is published
with the release.

Keeping `createUpdaterArtifacts` off in the checked-in configuration is what makes a developer's
`tauri build` an ordinary build: it produces no signature files and needs no key.

### One constraint worth knowing before a second component releases

`releases/latest/download/latest.json` resolves against whichever release GitHub calls latest for
the *whole repository*, not for Director. That is why the `publish` job passes `--latest`, and it is
correct only while Director is the only component that publishes releases. Before another one does,
either mark its releases as not latest or move Director's updater endpoint to a URL that names
Director — and remember that changing the endpoint only reaches copies of Director installed
afterwards.
