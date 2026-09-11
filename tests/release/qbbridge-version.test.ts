/**
 * The release guard in `scripts/release/qbbridge-version.mjs`.
 *
 * Two different things are tested here, and the split matters:
 *
 * * **The rules**, against synthetic entries. Every way a version bump goes wrong is cheap to
 *   construct and impossible to construct by editing the repository, so the disagreement cases are
 *   built by hand.
 * * **The repository**, against its real manifests. The guard is only worth having if the five
 *   places QBBridge's version is written agree right now, and that is a fact about this checkout
 *   rather than about the rules — so it is asserted directly, and a bump that forgets `npm install`
 *   fails here rather than at release time.
 */
import { describe, expect, it } from 'vitest';
import {
  check,
  type IVersionEntry,
  noUpdaterConfigured,
  readConf,
  readVersions,
  SOURCES,
  versionFromTag,
} from '../../scripts/release/qbbridge-version.mjs';

/** The repository root, as the guard's own entry point computes it. */
const root = new URL('../../', import.meta.url);

/** Entries that all agree, as the happy path produces them. */
const agreeing = (version: string): IVersionEntry[] =>
  SOURCES.map((source) => ({ path: source.path, what: source.what, version }));

describe('the release tag', () => {
  it('reads the version out of a QBBridge tag', () => {
    expect(versionFromTag('qbbridge-v0.2.0')).toBe('0.2.0');
    expect(versionFromTag('qbbridge-v1.0.0-rc.1')).toBe('1.0.0-rc.1');
  });

  it('does not accept a tag that names no component', () => {
    // A monorepo releases more than QBBridge. A bare `v0.2.0` does not say what moved.
    expect(versionFromTag('v0.2.0')).toBeNull();
    expect(versionFromTag('0.2.0')).toBeNull();
    expect(versionFromTag(undefined)).toBeNull();
  });

  it('does not accept the tag of another component', () => {
    // The two release workflows filter on their own tag prefixes, but the guard is the thing that
    // would actually build the wrong application if a prefix were ever widened.
    expect(versionFromTag('director-v0.2.0')).toBeNull();
  });
});

describe('version agreement', () => {
  it('accepts manifests that agree, with and without a tag', () => {
    expect(check(agreeing('0.2.0')).problems).toEqual([]);
    expect(check(agreeing('0.2.0'), 'qbbridge-v0.2.0').problems).toEqual([]);
    expect(check(agreeing('0.2.0')).version).toBe('0.2.0');
  });

  it('reports every manifest that disagrees, naming each one', () => {
    const entries = agreeing('0.2.0');
    entries[4] = { ...entries[4], version: '0.1.0' };
    const { problems } = check(entries);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('package-lock.json says 0.1.0');
    expect(problems[0]).toContain('apps/qbbridge/src-tauri/tauri.conf.json says 0.2.0');
  });

  it('notices a Cargo.lock left behind by a bump', () => {
    // The failure this catches is quiet: `cargo build` rewrites the lockfile rather than failing,
    // so a release runner discovers it as a dirty tree rather than as a wrong version.
    const entries = agreeing('0.2.0');
    entries[3] = { ...entries[3], version: '0.1.0' };
    expect(check(entries).problems[0]).toContain('apps/qbbridge/src-tauri/Cargo.lock says 0.1.0');
  });

  it('takes tauri.conf.json as the authority when they disagree', () => {
    // It is the only copy an installed QBBridge can observe, so it is the one the others are wrong
    // about — and the version the release is therefore called.
    const entries = agreeing('0.1.0');
    entries[0] = { ...entries[0], version: '0.2.0' };
    expect(check(entries).version).toBe('0.2.0');
  });

  it('reports a manifest it could not read', () => {
    const entries = agreeing('0.2.0');
    entries[2] = { path: entries[2].path, what: entries[2].what, error: 'no version found' };
    expect(check(entries).problems).toEqual(['apps/qbbridge/src-tauri/Cargo.toml: no version found']);
  });

  it('refuses a version an operator could not order', () => {
    expect(check(agreeing('0.2')).problems).toHaveLength(1);
    expect(check(agreeing('2024-09-01')).problems).toHaveLength(1);
    expect(check(agreeing('0.2.0-rc.1')).problems).toEqual([]);
  });

  it('refuses a tag that releases a version the manifests do not carry', () => {
    const { problems } = check(agreeing('0.1.0'), 'qbbridge-v0.2.0');
    expect(problems).toEqual(['the tag qbbridge-v0.2.0 releases 0.2.0, but the manifests say 0.1.0']);
  });

  it('refuses a tag of the wrong shape', () => {
    expect(check(agreeing('0.1.0'), 'qbbridge-0.1.0').problems).toEqual([
      'the tag qbbridge-0.1.0 is not of the form qbbridge-vMAJOR.MINOR.PATCH',
    ]);
  });
});

describe('the absence of an updater', () => {
  it('accepts the configuration QBBridge actually has', () => {
    expect(noUpdaterConfigured({ bundle: { createUpdaterArtifacts: false } })).toEqual([]);
    expect(noUpdaterConfigured({})).toEqual([]);
  });

  it('fails a release that would ship updater configuration nothing serves', () => {
    // The whole point: adding the plugin has to stop the release rather than quietly produce one
    // that offers installed copies an update with no signature behind it.
    expect(noUpdaterConfigured({ plugins: { updater: { endpoints: [] } } })).toHaveLength(1);
    expect(noUpdaterConfigured({ bundle: { createUpdaterArtifacts: true } })).toHaveLength(1);
    expect(
      noUpdaterConfigured({ plugins: { updater: {} }, bundle: { createUpdaterArtifacts: true } }),
    ).toHaveLength(2);
  });

  it('says nothing about a configuration it could not read', () => {
    // `check` already reports an unreadable manifest as a problem; reporting it twice would only
    // bury the real one.
    expect(noUpdaterConfigured(undefined)).toEqual([]);
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

  it('still has no updater, so the release pipeline still owes no signatures', () => {
    expect(noUpdaterConfigured(readConf(root))).toEqual([]);
  });
});
