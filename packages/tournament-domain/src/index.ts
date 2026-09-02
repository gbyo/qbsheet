/**
 * The canonical QBSheet tournament domain.
 *
 * # One domain
 *
 * `DirectorState` is the single authoritative tournament document. Director's React application
 * consumes it, the Tauri store persists it and projects it into normalized SQLite tables, the
 * portable archive serializes it, and QBSheet Live projects a sanitized public view of it. There is
 * no second copy of tournament state anywhere in the repository and no Live-specific mirror.
 *
 * `@qbsheet/tournament-core` remains a *planning and derivation engine* — scheduling, brackets,
 * advancement, division placement — that takes inputs adapted from this document and returns plans.
 * It does not hold tournament state. `src/director/domain` re-exports this package so existing
 * Director imports keep working while the boundary stays in one place.
 *
 * See `docs/QBLIVE.md` for the projection that hangs off this, and its privacy rules.
 */

export * from './model.js';
export * from './stats.js';
export * from './transfers.js';
export * from './timezone.js';
export * from './timeline.js';
export * from './publication.js';
