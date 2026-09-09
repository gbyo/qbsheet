/**
 * Types for `director-version.mjs`.
 *
 * The guard is plain JavaScript because the release workflow runs it before any `npm ci` — see its
 * header. This declaration is what lets `tests/release/director-version.test.ts` import it under
 * `npm run typecheck`, and it is deliberately only the public surface. A signature that drifts from
 * the implementation shows up as a type error in that test.
 */

/** The value `tauri.conf.json` carries until a real release keypair is generated. */
export declare const PLACEHOLDER_PUBKEY: string;

export interface IVersionSource {
  /** Repository-relative path of the manifest. */
  path: string;
  /** What this copy of the version decides, for the report. */
  what: string;
  read: (text: string) => string | undefined;
}

export declare const SOURCES: readonly IVersionSource[];

export interface IVersionEntry {
  path: string;
  what: string;
  /** The version read, or `undefined` when it could not be. */
  version?: string;
  /** Why it could not be read. */
  error?: string;
}

/** The version a Director release tag releases, or `null` if it is not one. */
export declare function versionFromTag(tag: string | undefined): string | null;

/** Every source in `SOURCES`, read relative to a repository-root directory URL. */
export declare function readVersions(root: URL): IVersionEntry[];

/** The updater public key checked into Director's configuration, or `undefined` if unreadable. */
export declare function readPubkey(root: URL): string | undefined;

/** The authoritative version, and every disagreement found. */
export declare function check(
  entries: readonly IVersionEntry[],
  tag?: string,
): { version?: string; problems: string[] };

/** Whether this release can carry signed automatic updates, and if not, why not. */
export declare function updaterConfigured(
  pubkey: string | undefined,
  signingKeyPresent: boolean,
): { enabled: boolean; reasons: string[] };
