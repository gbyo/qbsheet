/**
 * Which Scorer build stamps the results this process writes.
 *
 * QbjResult needs the build at result time, but it is also compiled into library bundles whose
 * module target predates `import.meta` — so it cannot read the injected build identity itself
 * (see `pwa/BuildVersion.ts`, which is app-shell-only for exactly this reason). Instead the app
 * entry tells this module once at startup, and everything stamps from here.
 *
 * The default is the honest dev placeholder, never a fictional release: a process that never
 * set its build — tests, scripts, a future entry point someone adds without the call — stamps
 * `dev`, which tournament control treats as unverifiable rather than pinned.
 */

/** The two strings that identify a build: release number plus short source commit. */
export interface ScorerBuildStamp {
  version: string;
  commit: string;
}

const developmentStamp: ScorerBuildStamp = { version: '0.0.0', commit: 'dev' };

let current: ScorerBuildStamp = developmentStamp;

/** The stamp new results carry. */
export function scorerBuildStamp(): ScorerBuildStamp {
  return current;
}

/**
 * Set the stamp once at app startup from the injected build identity. Last call wins so tests
 * can stage builds; production calls it exactly once from the app entry.
 */
export function setScorerBuildStamp(stamp: ScorerBuildStamp): void {
  current = { version: stamp.version, commit: stamp.commit };
}

/** Forget any staged stamp. Tests only — production never unsets its build. */
export function resetScorerBuildStamp(): void {
  current = developmentStamp;
}
