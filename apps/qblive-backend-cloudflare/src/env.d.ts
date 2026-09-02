/**
 * The Worker's bindings and secrets.
 *
 * Declared by hand rather than committing `wrangler types` output: that file is 600 KB of runtime
 * type definitions regenerated on every `wrangler.jsonc` edit, and a template a tournament director
 * clones should not carry it. The bindings a deployment actually has are the two below, and CI
 * checks them by building the Worker.
 */

declare namespace Cloudflare {
  interface Env {
    QBLIVE_PUBLICATION: DurableObjectNamespace<import('./publication').QblivePublication>;
    /**
     * The one-time setup token this deployment will accept in exchange for a management credential.
     *
     * A Worker secret, set by the deploying director. Absent means the backend refuses to be
     * claimed at all, which is the right posture for a deployment that was never finished.
     */
    QBLIVE_SETUP_TOKEN?: string;
  }
}

interface Env extends Cloudflare.Env {}
