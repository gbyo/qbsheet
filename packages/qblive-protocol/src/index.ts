/**
 * QBLive v1 — the open, vendor-neutral QBSheet Live protocol.
 *
 * This package is the wire contract and nothing else: types, bounded validators, the bootstrap URL
 * format, and the fixtures the TypeScript, Swift and server test suites all read. It has no
 * dependency on Director, on Cloudflare, on Apple, or on qbsheet.com, which is the point — a
 * third-party server implementing these shapes is a first-class QBLive server.
 *
 * See `docs/QBLIVE.md` for the normative specification.
 */

export * from './types.js';
export * from './management.js';
export * from './validate.js';
export * from './bootstrap.js';
export * from './client.js';
