/**
 * Types for `qbbridge-version.mjs`.
 *
 * The guard is plain JavaScript because the release workflow runs it before any `npm ci` — see its
 * header. This declaration is what lets `tests/release/qbbridge-version.test.ts` import it under
 * `npm run typecheck`, and it is deliberately only the public surface. A signature that drifts from
 * the implementation shows up as a type error in that test.
 */

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

/** The Tauri configuration this guard reads, shaped only where the guard looks. */
export interface ITauriConf {
  version?: unknown;
  plugins?: { updater?: unknown };
  bundle?: { createUpdaterArtifacts?: unknown };
}

/** The version a QBBridge release tag releases, or `null` if it is not one. */
export declare function versionFromTag(tag: string | undefined): string | null;

/** Every source in `SOURCES`, read relative to a repository-root directory URL. */
export declare function readVersions(root: URL): IVersionEntry[];

/** QBBridge's Tauri configuration, parsed, or `undefined` if unreadable. */
export declare function readConf(root: URL): ITauriConf | undefined;

/** The authoritative version, and every disagreement found. */
export declare function check(
  entries: readonly IVersionEntry[],
  tag?: string,
): { version?: string; problems: string[] };

/** Every way the configuration claims an updater the release pipeline does not serve. */
export declare function noUpdaterConfigured(conf: ITauriConf | undefined): string[];
