/**
 * Which build of QBSheet is running, said out loud.
 *
 * # Why a scoresheet needs a version on screen at all
 *
 * Because the alternative is a phone call that cannot be resolved. A director hears that Room 12 has
 * stopped sending scores; the only device that knows anything is in Room 12; and the first question —
 * is that Chromebook running the same application as the eleven that are working? — has no answer
 * unless the application says so. Every other diagnostic is worth less without this one, so it is
 * printed on the readiness screen and carried in the diagnostics bundle.
 *
 * # Where the value comes from
 *
 * The build injects it (see `vite.config.ts`), keyed off the commit rather than the build clock so
 * that identical source is identical build and no room is told to update to what it already has.
 *
 * A context the build never touched — a unit test, the library entry point, a `vite dev` server —
 * reads `undefined` and gets `developmentBuild`. That is honest: those really are not a deployed
 * build, and claiming a version number for them would put a fictional one into a diagnostics file
 * somebody is trying to debug from.
 */

export interface IBuildVersion {
  /** The human number, from `package.json`. */
  version: string;
  /** Short commit of the source this was built from, or `unknown` off a checkout-less build. */
  commit: string;
  /** ISO instant of that commit, or `''` when git could not be asked. */
  builtAt: string;
}

/** What a build that did not come from `vite build` reports about itself. */
export const developmentBuild: IBuildVersion = { version: '0.0.0', commit: 'dev', builtAt: '' };

function injected(): IBuildVersion | null {
  // `import.meta.env` exists under Vite and under Vitest; the key exists only when the build defined
  // it. The shape is checked rather than trusted, because a half-applied define is a worse lie than
  // an absent one.
  const value: unknown = import.meta.env?.QBSHEET_BUILD;
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Partial<IBuildVersion>;
  if (typeof candidate.version !== 'string' || typeof candidate.commit !== 'string') return null;
  return {
    version: candidate.version,
    commit: candidate.commit,
    builtAt: typeof candidate.builtAt === 'string' ? candidate.builtAt : '',
  };
}

export const buildVersion: IBuildVersion = injected() ?? developmentBuild;

/**
 * The one-line identifier — `0.1.0 · a1b2c3d`.
 *
 * Short enough to sit in a status line, specific enough that two devices reporting different strings
 * are provably running different code.
 */
export function buildLabel(build: IBuildVersion = buildVersion): string {
  if (build.commit === '' || build.commit === 'unknown') return build.version;
  return `${build.version} · ${build.commit}`;
}

/** Whether this is a real deployed build, or a dev server / test / library context. */
export function isDeployedBuild(build: IBuildVersion = buildVersion): boolean {
  return build.commit !== developmentBuild.commit && build.commit !== 'unknown';
}
