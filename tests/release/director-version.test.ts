/**
 * The release guard in `scripts/release/director-version.mjs`.
 *
 * Two different things are tested here, and the split matters:
 *
 * * **The rules**, against synthetic entries. Every way a version bump goes wrong is cheap to
 *   construct and impossible to construct by editing the repository, so the disagreement cases are
 *   built by hand.
 * * **The repository**, against its real manifests. The guard is only worth having if the five
 *   places Director's version is written agree right now, and that is a fact about this checkout
 *   rather than about the rules — so it is asserted directly, and a bump that forgets `npm install`
 *   fails here rather than at release time.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  check,
  type IVersionEntry,
  PLACEHOLDER_PUBKEY,
  readPubkey,
  readVersions,
  SOURCES,
  updaterConfigured,
  versionFromTag,
} from '../../scripts/release/director-version.mjs';

/** The repository root, as the guard's own entry point computes it. */
const root = new URL('../../', import.meta.url);

/** Entries that all agree, as the happy path produces them. */
const agreeing = (version: string): IVersionEntry[] =>
  SOURCES.map((source) => ({ path: source.path, what: source.what, version }));

describe('the release tag', () => {
  it('reads the version out of a Director tag', () => {
    expect(versionFromTag('director-v0.2.0')).toBe('0.2.0');
    expect(versionFromTag('director-v1.0.0-rc.1')).toBe('1.0.0-rc.1');
  });

  it('does not accept a tag that names no component', () => {
    // A monorepo releases more than Director. A bare `v0.2.0` does not say what moved, and the
    // workflow must not build Director for another component's tag.
    expect(versionFromTag('v0.2.0')).toBeNull();
    expect(versionFromTag('0.2.0')).toBeNull();
    expect(versionFromTag(undefined)).toBeNull();
  });
});

describe('version agreement', () => {
  it('accepts manifests that agree, with and without a tag', () => {
    expect(check(agreeing('0.2.0')).problems).toEqual([]);
    expect(check(agreeing('0.2.0'), 'director-v0.2.0').problems).toEqual([]);
    expect(check(agreeing('0.2.0')).version).toBe('0.2.0');
  });

  it('reports every manifest that disagrees, naming each one', () => {
    const entries = agreeing('0.2.0');
    entries[3] = { ...entries[3], version: '0.1.0' };
    const { problems } = check(entries);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('apps/director/package-lock.json says 0.1.0');
    expect(problems[0]).toContain('apps/director/src-tauri/tauri.conf.json says 0.2.0');
  });

  it('takes tauri.conf.json as the authority when they disagree', () => {
    // It is the only copy an installed Director can observe, so it is the one the others are wrong
    // about — and the version the release is therefore called.
    const entries = agreeing('0.1.0');
    entries[0] = { ...entries[0], version: '0.2.0' };
    expect(check(entries).version).toBe('0.2.0');
  });

  it('reports a manifest it could not read', () => {
    const entries = agreeing('0.2.0');
    entries[2] = { path: entries[2].path, what: entries[2].what, error: 'no version found' };
    expect(check(entries).problems).toEqual(['apps/director/src-tauri/Cargo.toml: no version found']);
  });

  it('refuses a version the updater could not order', () => {
    // The updater decides whether an update is newer by comparing these strings as semver. One it
    // cannot parse is one it cannot compare, so it would never offer the update at all.
    expect(check(agreeing('0.2')).problems).toHaveLength(1);
    expect(check(agreeing('2024-09-01')).problems).toHaveLength(1);
    expect(check(agreeing('0.2.0-rc.1')).problems).toEqual([]);
  });

  it('refuses a tag that releases a version the manifests do not carry', () => {
    const { problems } = check(agreeing('0.1.0'), 'director-v0.2.0');
    expect(problems).toEqual(['the tag director-v0.2.0 releases 0.2.0, but the manifests say 0.1.0']);
  });

  it('refuses a tag of the wrong shape', () => {
    expect(check(agreeing('0.1.0'), 'director-0.1.0').problems).toEqual([
      'the tag director-0.1.0 is not of the form director-vMAJOR.MINOR.PATCH',
    ]);
  });
});

describe('signed automatic updates', () => {
  it('needs both halves of the keypair', () => {
    expect(updaterConfigured('a-real-public-key', true).enabled).toBe(true);
    expect(updaterConfigured('a-real-public-key', false).enabled).toBe(false);
    expect(updaterConfigured(PLACEHOLDER_PUBKEY, true).enabled).toBe(false);
    expect(updaterConfigured(undefined, true).enabled).toBe(false);
    expect(updaterConfigured('', true).enabled).toBe(false);
  });

  it('says which half is missing', () => {
    expect(updaterConfigured(PLACEHOLDER_PUBKEY, false).reasons).toHaveLength(2);
    expect(updaterConfigured(PLACEHOLDER_PUBKEY, true).reasons[0]).toContain('tauri.conf.json');
    expect(updaterConfigured('a-real-public-key', false).reasons[0]).toContain('TAURI_SIGNING_PRIVATE_KEY');
  });
});

describe('this repository', () => {
  it('has a readable version in every place it writes one', () => {
    const entries = readVersions(root);
    expect(entries).toHaveLength(SOURCES.length);
    for (const entry of entries) {
      expect(entry.error, entry.path).toBeUndefined();
      expect(entry.version, entry.path).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it('agrees with itself about the version it is going to release', () => {
    expect(check(readVersions(root)).problems).toEqual([]);
  });

  it('reads the updater public key out of the configuration it is checked into', () => {
    // Whichever key is there, `readPubkey` has to find it: the whole updater decision rests on
    // telling the placeholder apart from a real key, and it cannot do that if it reads nothing.
    expect(typeof readPubkey(root)).toBe('string');
  });

  it('keeps an ordinary build free of updater artifacts, and turns them on only in the patch', () => {
    // The default configuration cannot emit updater artifacts, because a developer's `tauri build`
    // must not produce signature files, and because the release only enables them once both halves
    // of the keypair exist. `tauri.updater.conf.json` is the whole of that switch.
    const conf = (name: string) =>
      JSON.parse(readFileSync(new URL(`apps/director/src-tauri/${name}`, root), 'utf8')) as {
        bundle: { createUpdaterArtifacts?: boolean };
      };
    expect(conf('tauri.conf.json').bundle.createUpdaterArtifacts).toBe(false);
    expect(conf('tauri.updater.conf.json').bundle.createUpdaterArtifacts).toBe(true);
  });
});
