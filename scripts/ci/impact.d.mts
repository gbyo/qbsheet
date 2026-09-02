/**
 * Types for `impact.mjs`.
 *
 * The classifier is plain JavaScript because the `changes` job runs it before any `npm ci` — see the
 * header of `classify-impact.mjs`. This declaration is what lets `tests/ci/impact.test.ts` import it
 * under `npm run typecheck`, and it is deliberately only the public surface. A signature that drifts
 * from the implementation shows up as a type error in that test.
 */

/** Every domain `ci.yml` can route to. */
export declare const DOMAINS: readonly string[];

/** A one-line description of each domain, for the step summary. */
export declare const DOMAIN_LABELS: Record<string, string>;

export interface IImpactRule {
  glob: string;
  domains: readonly string[];
  why: string;
  docs?: true;
}

export declare const RULES: readonly IImpactRule[];

/** What each lockfile project entry means for CI. */
export declare const LOCKFILE_PROJECT_DOMAINS: Record<string, readonly string[]>;

/** Whether the quality job has to run because of one file. */
export declare function qualityFor(path: string): boolean;

/** The first rule that matches a path, or `undefined` when it is unrecognised. */
export declare function ruleFor(path: string): (IImpactRule & { pattern: RegExp }) | undefined;

/** Which lockfile projects a `package-lock.json` change reaches, and what it cannot explain. */
export declare function lockfileProjects(
  base: unknown,
  head: unknown,
): { projects: string[]; unexplained: string[] };

export interface IImpact {
  files: string[];
  domains: Record<string, boolean>;
  /** For each domain, the changed files that turned it on. */
  because: Record<string, string[]>;
  /** Paths that matched no rule, and so turned everything on. */
  unclassified: string[];
  notes: string[];
  /** Every changed file is prose. */
  'docs-only': boolean;
  /** At least one domain runs. */
  any: boolean;
}

export declare function classify(
  paths: readonly string[],
  lockfiles?: { base: unknown; head: unknown },
): IImpact;
