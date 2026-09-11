/**
 * Types for `relay-standalone.mjs`.
 *
 * The check is plain JavaScript because CI runs it as a standalone script, before and independently
 * of any TypeScript build. This declaration is what lets `tests/relay/standaloneBoundary.test.ts`
 * import it under `npm run typecheck`, and it is deliberately only the public surface.
 */

/** The package whose standalone deployability is the point. Repository-relative. */
export declare const RELAY_DIR: string;

/**
 * Every way the relay package at `root` (an absolute directory path) reaches outside itself:
 * imports that resolve above it, bare specifiers its manifest does not declare, and dependencies
 * pinned to a path rather than a registry version. Empty means it is standalone.
 */
export declare function standaloneProblems(root: string): string[];
