#!/usr/bin/env node
/**
 * The version QBSheet Director is about to release, and whether every manifest agrees on it.
 *
 * # Why this exists
 *
 * Director's version is written down five times. `tauri.conf.json` is the copy that matters once the
 * application is installed — it names the installers, it is what the About window shows, and it is
 * what the updater compares against the version a running Director reports — but `package.json`,
 * `Cargo.toml`, and the two lockfiles that record the package each carry their own. Nothing in an
 * ordinary build checks that they agree, because nothing in an ordinary build reads more than one.
 *
 * A release reads all of them at once, and a disagreement there is not cosmetic:
 *
 * * A `director-v0.2.0` tag over a `tauri.conf.json` that still says `0.1.0` publishes a release
 *   called 0.2.0 whose installers are all named 0.1.0. Directors download the file, and the file
 *   disagrees with the page they downloaded it from.
 * * The updater compares versions and nothing else. A `latest.json` behind the version the installed
 *   application reports is an update every client refuses; one ahead of the binary it points at is
 *   an update every client installs and is then offered again, permanently.
 *
 * So `.github/workflows/director-release.yml` runs this before it spends a runner on a bundle, and
 * it is worth running by hand as the last step of a version bump:
 *
 *     node scripts/release/director-version.mjs
 *     node scripts/release/director-version.mjs --tag director-v0.2.0
 *
 * Dependency-free on purpose, for the same reason as `scripts/ci/classify-impact.mjs`: the job that
 * decides whether the release is worth installing anything for should not have to install anything.
 * `tests/release/director-version.test.ts` holds it to the real manifests.
 *
 * # What it reports and never fails on
 *
 * Whether this release can also carry signed automatic updates. That needs two independent halves —
 * the public key checked into `tauri.conf.json` and the private key held as a repository secret —
 * and neither is this script's to supply. When either is missing the release is still a complete
 * release of installers. It simply cannot also be an update, so the workflow leaves
 * `createUpdaterArtifacts` off rather than publishing signatures no installed Director could
 * verify. See `docs/DIRECTOR_RELEASE.md`.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The value `tauri.conf.json` carries until a real release keypair is generated. */
export const PLACEHOLDER_PUBKEY = 'REPLACE_WITH_RELEASE_PUBLIC_KEY';

/** Director's Tauri configuration, relative to the repository root. Read for two different things. */
const TAURI_CONF = 'apps/director/src-tauri/tauri.conf.json';

/**
 * `MAJOR.MINOR.PATCH`, optionally with a prerelease suffix.
 *
 * Required rather than merely preferred, because Tauri's updater orders versions by this shape. A
 * version it cannot parse is not a version it can decide is newer.
 */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The tag that releases Director.
 *
 * Prefixed, because this is a monorepo: the scorer, QBSheet Live, and Director are versioned apart,
 * and a bare `v0.2.0` would not say which of them moved.
 */
const TAG = /^director-v(.+)$/;

/** The version a Director release tag releases, or `null` if it is not one. */
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
 * Every place Director's version is written, and how to read it out.
 *
 * `tauri.conf.json` is first because it is the authority: it is the one an installed Director can
 * actually observe, so when the copies disagree it is the copy the others are wrong about. The
 * lockfiles are here because npm records the version of the workspace package itself, and a bump
 * that skips `npm install` leaves them behind without failing anything until a release reads them.
 */
export const SOURCES = [
  {
    path: TAURI_CONF,
    what: 'the version the installers, the About window, and the updater use',
    read: (text) => json(text).version,
  },
  {
    path: 'apps/director/package.json',
    what: 'the npm package the Tauri shell builds from',
    read: (text) => json(text).version,
  },
  {
    path: 'apps/director/src-tauri/Cargo.toml',
    what: 'the native crate',
    read: (text) => cargoVersion(text),
  },
  {
    // npm writes the top-level `version` and `packages[""].version` from the same source, so
    // reading one of them is reading both.
    path: 'apps/director/package-lock.json',
    what: "the standalone lockfile's record of the package",
    read: (text) => json(text).packages?.['']?.version ?? json(text).version,
  },
  {
    path: 'package-lock.json',
    what: "the workspace lockfile's record of apps/director",
    read: (text) => json(text).packages?.['apps/director']?.version,
  },
];

/**
 * Each source, read.
 *
 * `root` is a directory URL — `new URL('./', import.meta.url)` from a file at the repository root,
 * or whatever the caller says. An unreadable or unparseable manifest is reported as a problem
 * rather than thrown, because a release wants every problem at once rather than the first one.
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

/** The updater public key checked into Director's configuration, or `undefined` if unreadable. */
export function readPubkey(root) {
  try {
    const pubkey = json(readFileSync(new URL(TAURI_CONF, root), 'utf8')).plugins?.updater?.pubkey;
    return typeof pubkey === 'string' ? pubkey : undefined;
  } catch {
    return undefined;
  }
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
      `the manifests disagree about Director's version: ${known
        .map((entry) => `${entry.path} says ${entry.version}`)
        .join('; ')}`,
    );
  }

  if (version !== undefined && !SEMVER.test(version)) {
    problems.push(
      `${TAURI_CONF} says ${version}, which is not a MAJOR.MINOR.PATCH version; the updater orders ` +
        'releases by that shape and cannot compare anything else',
    );
  }

  if (tag !== undefined) {
    const tagged = versionFromTag(tag);
    if (tagged === null) {
      problems.push(`the tag ${tag} is not of the form director-vMAJOR.MINOR.PATCH`);
    } else if (version !== undefined && tagged !== version) {
      problems.push(`the tag ${tag} releases ${tagged}, but the manifests say ${version}`);
    }
  }

  return { version, problems };
}

/**
 * Whether this release can carry signed automatic updates, and if not, why not.
 *
 * Both halves of the keypair have to be present, and they are held in deliberately different
 * places: the public key is checked in because every installed Director needs it to verify an
 * update, and the private key is a repository secret because nothing else may ever hold it.
 */
export function updaterConfigured(pubkey, signingKeyPresent) {
  const reasons = [];
  if (typeof pubkey !== 'string' || pubkey.length === 0 || pubkey === PLACEHOLDER_PUBKEY) {
    reasons.push(
      `${TAURI_CONF} carries no release public key, so an installed Director could not verify an ` +
        'update signed for this release',
    );
  }
  if (!signingKeyPresent) {
    reasons.push(
      'the TAURI_SIGNING_PRIVATE_KEY repository secret is not set, so there is nothing to sign with',
    );
  }
  return { enabled: reasons.length === 0, reasons };
}

/** `--tag director-v0.2.0 --signing-key present` as an object. */
function parseArguments(argv) {
  const options = { tag: undefined, signingKeyPresent: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--tag') options.tag = argv[index + 1];
    if (argv[index] === '--signing-key') options.signingKeyPresent = argv[index + 1] === 'present';
  }
  return options;
}

function main(argv, root) {
  const { tag, signingKeyPresent } = parseArguments(argv);
  const entries = readVersions(root);
  const { version, problems } = check(entries, tag);
  const updater = updaterConfigured(readPubkey(root), signingKeyPresent);

  const lines = ['# Director release'];
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
    updater.enabled
      ? 'Signed automatic updates are configured, so this release publishes updater artifacts and a `latest.json`.'
      : 'This release publishes installers only. Signed automatic updates are not configured:',
  );
  lines.push('');
  for (const reason of updater.reasons) lines.push(`* ${reason}`);
  if (!updater.enabled) {
    lines.push('');
    lines.push('See `docs/DIRECTOR_RELEASE.md`. This does not fail the release.');
  }
  if (problems.length > 0) {
    lines.push('');
    lines.push('## Problems');
    lines.push('');
    for (const problem of problems) lines.push(`* ${problem}`);
  }

  console.log(`Director release version: ${version ?? 'undeterminable'}`);
  for (const entry of entries) {
    console.log(`  ${entry.path.padEnd(46)} ${entry.version ?? `!! ${entry.error}`}`);
  }
  console.log('');
  console.log(`  signed automatic updates: ${updater.enabled ? 'yes' : 'no'}`);
  for (const reason of updater.reasons) console.log(`    - ${reason}`);

  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
  if (process.env.GITHUB_OUTPUT !== undefined) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version ?? ''}\nupdater=${updater.enabled}\n`);
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
