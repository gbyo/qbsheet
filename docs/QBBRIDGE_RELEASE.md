# Releasing QBSheet Bridge

QBBridge is a Tauri desktop application, so a release is not one file. It is a set of per-platform
bundles that can only be built on their own operating system, gathered into a single GitHub release.
[`.github/workflows/qbbridge-release.yml`](../.github/workflows/qbbridge-release.yml) does the
gathering; this document is the procedure around it.

It is deliberately the same procedure as [Director's](DIRECTOR_RELEASE.md), because two release
pipelines that differ only where they must are two pipelines one person can hold in their head. The
places they differ are listed at the end.

## Cut a release

1. **Bump the version.** QBBridge's version is written in five places, and all five have to agree:

   | File                                      | What its copy decides                                            |
   | ----------------------------------------- | ---------------------------------------------------------------- |
   | `apps/qbbridge/src-tauri/tauri.conf.json` | the installer file names and the version the application carries |
   | `apps/qbbridge/package.json`              | the npm package the Tauri shell builds from                      |
   | `apps/qbbridge/src-tauri/Cargo.toml`      | the native crate                                                 |
   | `apps/qbbridge/src-tauri/Cargo.lock`      | the crate lockfile's record of `qbsheet-bridge`                  |
   | `package-lock.json`                       | npm's record of `apps/qbbridge` in the workspace                 |

   Edit the first three by hand; `npm install` writes the workspace lockfile and
   `cargo update -p qbsheet-bridge --manifest-path apps/qbbridge/src-tauri/Cargo.toml` (or any
   `cargo` command over that manifest) writes the crate lockfile. Then check the result:

   ```sh
   node scripts/release/qbbridge-version.mjs --tag qbbridge-v0.3.0
   ```

   That is the same guard the workflow runs first, and it is worth running locally because it is
   the one failure that is expensive to discover late: a tag over a stale `tauri.conf.json`
   publishes a release named 0.3.0 whose installers are all named 0.2.0. On a tournament morning
   that leaves two versions of the same application on a machine with no way to tell them apart.

2. **Merge the bump.** A release is built from a tag, and a tag on a commit that is not on `main` is
   a release nobody can reproduce.

3. **Push the tag.**

   ```sh
   git tag qbbridge-v0.3.0
   git push origin qbbridge-v0.3.0
   ```

   The prefix is not decoration. This repository releases the scorer, QBSheet Live, Director, and
   QBBridge independently, and a bare `v0.3.0` would not say which of them moved. It is also what
   keeps a `director-v*` tag from building QBBridge and the reverse.

4. **Watch the three bundle jobs.** They create a _draft_ release and upload into it. The draft
   becomes visible only after all three succeed — so a Windows bundling failure cannot leave a
   published release that operators on Windows can see and cannot download. Before publishing, the
   `publish` job additionally asserts the draft carries exactly the documented platform set
   (Windows `-setup.exe` + `.msi`, macOS `.dmg`, Linux `.AppImage` + `.deb` + `.rpm`) and nothing
   else: a green job that uploaded nothing fails the release instead of publishing a promise the
   platform cannot download.

   If one platform fails, the other two bundles are already in the draft. Two ways back:

   - **Resume:** fix the cause, delete the tag (`git push origin :qbbridge-v0.3.0`), and push it
     again. The workflow reuses the same draft, so the platforms that already uploaded keep their
     bundles and only the fixed platform rebuilds.
   - **Clean redo:** additionally delete the draft release itself (Releases page → delete the
     draft for the tag). Do this when the fix changes artifact names or you no longer trust what
     is in the draft: reusing a draft never removes stale assets, and a corrected rebuild must
     not publish alongside files from the abandoned attempt.

   Never publish the incomplete draft by hand to "get something out". An incomplete draft is not a
   release: it is a page that offers an operator a download their platform does not have.

## Try the release build without releasing

Run the workflow from the Actions tab (`workflow_dispatch`). With no tag it creates no release and
publishes nothing; the bundles come back as workflow artifacts.

Do this after any change to the workflow, to `src-tauri`, or to a Rust dependency. A bundling
failure is specific to the bundler and the runner — the AppImage tooling, the WiX toolchain — and
ordinary CI never bundles, so CI cannot tell you about it. A dispatch run is the only check that
exists for it, and it does not cost a tag you would then have to delete.

The `verify-dispatch` job fails the run unless every platform produced an inspectable workflow
artifact, so a dispatch run that silently uploads nothing reads as red, not green.

## What gets published

The macOS bundle is `universal-apple-darwin`: one download for both Apple silicon and Intel, so an
operator does not have to know which processor their Mac has.

| Platform | Files                                                           |
| -------- | --------------------------------------------------------------- |
| Windows  | `-setup.exe` (NSIS), `.msi` (WiX, for administrator deployment) |
| macOS    | `.dmg`                                                          |
| Linux    | `.AppImage`, `.deb`, `.rpm`                                     |

The Linux bundles link against the glibc of the runner they were built on, so the runner image in
the workflow matrix decides the oldest distribution QBBridge supports. It is pinned to
`ubuntu-22.04` for that reason rather than tracking `ubuntu-latest`, and moving it forward raises
the floor — worth a line in the release notes when it happens.

Every path in every `bundle.icon` list (`tauri.conf.json` and the macOS overlay) must be a raster
image file that exists in the repository. `apps/qbbridge/src/bundleConfig.test.ts` fails that in
milliseconds on every CI run. It exists because Director's abandoned 0.1.0 macOS release died in
Xcode's `actool` — one opaque line, after a full compile — over `icons/icon.icon`, which is an
Xcode Icon Composer _source directory_, not an image. Keep Icon Composer sources in the tree as
design inputs, but never in a `bundle.icon` list.

## Where this differs from Director

### QBBridge does not update itself

Director has `tauri-plugin-updater` and an updater endpoint. QBBridge has neither: no
`plugins.updater` in its configuration, no updater crate, no keypair, no `latest.json`, and no
`TAURI_SIGNING_PRIVATE_KEY` anywhere in its release workflow. A QBBridge release is installers, and
an operator moves to a new version by downloading it.

This is not an oversight to be corrected quietly. Adding an updater changes every one of those facts
at once, so both halves of the pipeline assert the absence rather than assume it:
`scripts/release/qbbridge-version.mjs` fails the release if the configuration starts claiming an
updater, and the `publish` job fails it if the runners produce a `.sig` or a `latest.json`. Read the
signing section of [`DIRECTOR_RELEASE.md`](DIRECTOR_RELEASE.md) before wiring one.

### A QBBridge release is never marked "Latest"

Director's updater resolves `releases/latest/download/latest.json`. Whichever release GitHub calls
latest is therefore the release every installed Director checks for updates against — and a QBBridge
release holding that slot answers each of those checks with a 404, silently, for as long as it is
the newest release in the repository.

So `publish` sets `make_latest=false`. QBBridge loses nothing by declining the slot, because it has
no updater to point at it; Director cannot afford to lose it. This is the cost
[`DIRECTOR_RELEASE.md`](DIRECTOR_RELEASE.md) predicted once a second component started releasing,
and it is paid here rather than there.

The visible consequence is that the Releases page marks the newest _Director_ release as Latest even
when a newer QBBridge release exists. Link operators to the QBBridge tag directly.

### There is no macOS toolchain probe

Director's workflow records `xcodebuild -version` and `xcrun --find actool` before building,
because that is where its 0.1.0 macOS bundle died. QBBridge relies on `bundleConfig.test.ts`
instead, which fails the same cause in milliseconds and runs on every ordinary CI run rather than
only during a release.
