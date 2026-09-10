/**
 * The QBLive conformance suite: the hosting-neutral contract made runnable.
 *
 * A reusable check that a server implements `docs/QBLIVE.md` and
 * `docs/QBLIVE_SERVER_CONTRACT.md`. Runs against the Cloudflare reference
 * backend, a standalone QBServer, Director's local-network server
 * (with `profile: 'local'`), and any third-party implementation.
 */

export * from './suite.js';
export * from './setup.js';
