/**
 * The QBSheet Live public projection.
 *
 * One pure transformation from the canonical tournament document plus its publication settings to a
 * QBLive snapshot, and the section diffing the publication worker uses to decide what to send.
 *
 * This package is the privacy boundary. See `./projection.ts` for why it constructs rather than
 * filters, and `tests/privacy.test.ts` for the property that keeps it honest.
 */

export * from './projection.js';
export * from './diff.js';
export * from './tables.js';
