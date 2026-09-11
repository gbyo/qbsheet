#!/usr/bin/env node
/**
 * The version QBSheet Bridge is about to release, and whether every manifest agrees on it.
 *
 * # Why this exists
 *
 * QBBridge's version is written down five times. `tauri.conf.json` is the copy that matters once
 * the application is installed — it names the installers and it is what the application reports —
 * but `package.json`, `Cargo.toml`, and two lockfiles each carry their own. Nothing in an ordinary
 * build checks that they agree, because nothing in an ordinary build reads more than one.
 *
 * A release reads all of them at once, and a disagreement there is not cosmetic: a
 * `qbbridge-v0.2.0` tag over a `tauri.conf.json` that still says `0.1.0` publishes a release called
 * 0.2.0 whose installers are all named `QBSheet Bridge_0.1.0_x64-setup.exe`. The operator downloads
 * the file, and the file disagrees with the page they downloaded it from — on a tournament morning,
 * with two versions of the same application on the machine and no way to tell which is running.
 *
 * So `.github/workflows/qbbridge-release.yml` runs this before it spends a runner on a bundle, and
 * it is worth running by hand as the last step of a version bump:
 *
 *     node scripts/release/qbbridge-version.mjs
 *     node scripts/release/qbbridge-version.mjs --tag qbbridge-v0.2.0
 *
 * Dependency-free on purpose, exactly as `scripts/release/director-version.mjs` is: the job that
 * decides whether the release is worth installing anything for should not have to install anything.
 * `tests/release/qbbridge-version.test.ts` holds it to the real manifests.
 *
 * # What this deliberately does not check
 *
 * Anything about automatic updates. QBBridge has no updater: there is no `plugins.updater` in its
 * configuration and no `tauri-plugin-updater` in its crate, so a QBBridge release is installers and
 * nothing else, and there is no keypair for this script to have an opinion about. Director's guard
 * carries that half because Director has the plugin. Copying it here would be checking a mechanism
 * that does not exist — and `noUpdaterConfigured` below fails the release if that ever silently
 * changes, so the omission stays a fact rather than an assumption.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** QBBridge's Tauri configuration, relative to the repository root. Read for two different things. */
const TAURI_CONF = 'apps/qbbridge/src-tauri/tauri.conf.json';

/**
 * `MAJOR.MINOR.PATCH`, optionally with a prerelease suffix.
 *
 * Required rather than merely preferred: it is the shape the installer file names carry and the
 * shape an operator comparing two downloads will try to order.
 */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The tag that releases QBBridge.
 *
 * Prefixed, because this is a monorepo: the scorer, QBSheet Live, Director, and QBBridge are
 * versioned apart, and a bare `v0.2.0` would not say which of them moved. It also keeps this
 * workflow from building QBBridge for a `director-v*` tag.
 */
const TAG = /^qbbridge-v(.+)$/;

/** The version a QBBridge release tag releases, or `null` if it is not one. */
export function versionFromTag(tag) {
  const match = TAG.exec(tag ?? '');
  return match === null ? null : match[1];
}

function json(text) {
  return JSON.parse(text);
}

/**
 * The `version` of the `[package]` table of a `Cargo.toml`.
 *
 * A regex over the whole file would find `tauri-build`'s version first, so this narrows to the
 * `[package]` table — from its header to the next header — before looking for the key. Not a TOML
 * parser and it does not need to be: it reads one key of one table in a file this repository writes.
 */
function cargoVersion(text) {
  const header = /^[ \t]*\[package\][ \t]*$/m.exec(text);
  if (header === null) return undefined;
  const rest = text.slice(header.index + header[0].length);
  const next = /^[ \t]*\[/m.exec(rest);
  const table = next === null ? rest : rest.slice(0, next.index);
  return /^[ \t]*version[ \t]*=[ \t]*"([^"]*)"/m.exec(table)?.[1];
}

/**
 * The `version` of a named package in a `Cargo.lock`.
 *
 * `Cargo.lock` lists every dependency, so this finds the `[[package]]` block whose `name` is the
 * one asked for rather than the first `version` in the file. QBBridge's lockfile is checked in —
 * it is an application, not a library — so a bump that edits `Cargo.toml` alone leaves the lockfile
 * behind, and the next `cargo build` quietly rewrites it into a dirty tree on a release runner.
 */
function cargoLockVersion(text, name) {
  const blocks = text.split(/^\[\[package\]\]$/m);
  for (const block of blocks) {
    if (new RegExp(`^[ \\t]*name[ \\t]*=[ \\t]*"${name}"`, 'm').test(block)) {
      return /^[ \t]*version[ \t]*=[ \t]*"([^"]*)"/m.exec(block)?.[1];
    }
  }
  return undefined;
}

/**
 * Every place QBBridge's version is written, and how to read it out.
 *
 * `tauri.conf.json` is first because it is the authority: it is the one an installed QBBridge can
 * actually observe, so when the copies disagree it is the copy the others are wrong about. Both
 * lockfiles are here because each records the version of the package itself, and a bump that skips
 * `npm install` or a `cargo` command leaves one behind without failing anything until a release
 * reads them.
 */
export const SOURCES = [
  {
    path: TAURI_CONF,
    what: 'the version the installers and the application carry',
    read: (text) => json(text).version,
  },
  {
    path: 'apps/qbbridge/package.json',
    what: 'the npm package the Tauri shell builds from',
    read: (text) => json(text).version,
  },
  {
    path: 'apps/qbbridge/src-tauri/Cargo.toml',
    what: 'the native crate',
    read: (text) => cargoVersion(text),
  },
  {
    path: 'apps/qbbridge/src-tauri/Cargo.lock',
    what: "the crate lockfile's record of qbsheet-bridge",
    read: (text) => cargoLockVersion(text, 'qbsheet-bridge'),
  },
  {
    path: 'package-lock.json',
    what: "the workspace lockfile's record of apps/qbbridge",
    read: (text) => json(text).packages?.['apps/qbbridge']?.version,
  },
];

/**
 * Each source, read.
 *
 * `root` is a directory URL. An unreadable or unparseable manifest is reported as a problem rather
 * than thrown, because a release wants every problem at once rather than the first one.
 */
export function readVersions(root) {
  return SOURCES.map((source) => {
    let version;
    let error;
    try {
      version = source.read(readFileSync(new URL(source.path, root), 'utf8'));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    if (error === undefined && typeof version !== 'string') {
      error = 'no version found where one was expected';
      version = undefined;
    }
    return { path: source.path, what: source.what, version, error };
  });
}

/**
 * Whether the manifests agree, and on what.
 *
 * Returns the authoritative version and every problem found, so the caller can print all of them.
 * `tag` is optional: a `workflow_dispatch` build has no tag to agree with.
 */
export function check(entries, tag) {
  const problems = [];
  const version = entries[0]?.version;

  for (const entry of entries) {
    if (entry.error !== undefined) problems.push(`${entry.path}: ${entry.error}`);
  }

  const known = entries.filter((entry) => entry.version !== undefined);
  const distinct = [...new Set(known.map((entry) => entry.version))];
  if (distinct.length > 1) {
    problems.push(
      `the manifests disagree about QBBridge's version: ${known
        .map((entry) => `${entry.path} says ${entry.version}`)
        .join('; ')}`,
    );
  }

  if (version !== undefined && !SEMVER.test(version)) {
    problems.push(
      `${TAURI_CONF} says ${version}, which is not a MAJOR.MINOR.PATCH version; the installers are ` +
        'named after it and an operator has to be able to order two of them',
    );
  }

  if (tag !== undefined) {
    const tagged = versionFromTag(tag);
    if (tagged === null) {
      problems.push(`the tag ${tag} is not of the form qbbridge-vMAJOR.MINOR.PATCH`);
    } else if (version !== undefined && tagged !== version) {
      problems.push(`the tag ${tag} releases ${tagged}, but the manifests say ${version}`);
    }
  }

  return { version, problems };
}

/**
 * That QBBridge still has no updater, and therefore still needs no signing key.
 *
 * The release workflow publishes installers and asserts exactly that set. If an updater plugin is
 * ever added to QBBridge, every one of those facts changes at once: the bundles gain `.sig` files
 * and a `latest.json`, the release needs `TAURI_SIGNING_PRIVATE_KEY`, the published release has to
 * become the one GitHub calls latest, and this script has to grow the half of Director's guard that
 * was deliberately left out. None of that happens by itself, and a release that quietly shipped
 * updater configuration with no signature is one that offers every installed copy an update it
 * cannot verify. So the absence is asserted rather than assumed.
 */
export function noUpdaterConfigured(conf) {
  const problems = [];
  if (conf?.plugins?.updater !== undefined) {
    problems.push(
      `${TAURI_CONF} configures the updater plugin, but the QBBridge release pipeline publishes no ` +
        'signatures and no latest.json; see docs/QBBRIDGE_RELEASE.md before releasing',
    );
  }
  if (conf?.bundle?.createUpdaterArtifacts === true) {
    problems.push(
      `${TAURI_CONF} turns on createUpdaterArtifacts, which emits signature files nothing serves`,
    );
  }
  return problems;
}

/** QBBridge's Tauri configuration, parsed, or `undefined` if unreadable. */
export function readConf(root) {
  try {
    return json(readFileSync(new URL(TAURI_CONF, root), 'utf8'));
  } catch {
    return undefined;
  }
}

/** `--tag qbbridge-v0.2.0` as an object. */
function parseArguments(argv) {
  const options = { tag: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--tag') options.tag = argv[index + 1];
  }
  return options;
}

function main(argv, root) {
  const { tag } = parseArguments(argv);
  const entries = readVersions(root);
  const { version, problems } = check(entries, tag);
  problems.push(...noUpdaterConfigured(readConf(root)));

  const lines = ['# QBBridge release'];
  lines.push('');
  lines.push(
    `Releasing **${version ?? 'an undeterminable version'}**${tag === undefined ? '' : ` as \`${tag}\``}.`,
  );
  lines.push('');
  lines.push('| Where the version is written | What it decides | Version |');
  lines.push('| --- | --- | --- |');
  for (const entry of entries) {
    lines.push(`| \`${entry.path}\` | ${entry.what} | ${entry.version ?? `**${entry.error}**`} |`);
  }
  lines.push('');
  lines.push(
    'QBBridge has no updater, so this release publishes installers only. Nothing already installed ' +
      'is offered this version; operators download it. See `docs/QBBRIDGE_RELEASE.md`.',
  );
  if (problems.length > 0) {
    lines.push('');
    lines.push('## Problems');
    lines.push('');
    for (const problem of problems) lines.push(`* ${problem}`);
  }

  console.log(`QBBridge release version: ${version ?? 'undeterminable'}`);
  for (const entry of entries) {
    console.log(`  ${entry.path.padEnd(46)} ${entry.version ?? `!! ${entry.error}`}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
  if (process.env.GITHUB_OUTPUT !== undefined) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version ?? ''}\n`);
  }

  if (problems.length > 0) {
    console.log('');
    for (const problem of problems) console.log(`::error::${problem}`);
    return 1;
  }
  return 0;
}

/** Only when run, not when imported by the test. */
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2), new URL('../../', import.meta.url));
}
