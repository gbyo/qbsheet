/**
 * Standings and statistics derived from the canonical tournament document.
 *
 * The derivation moved to `@qbsheet/tournament-domain` so that QBSheet Live's public projection
 * uses the same code that produces Director's own tables. Live must never recompute official
 * placement independently; sharing one implementation is how that is enforced rather than promised.
 */

export * from '@qbsheet/tournament-domain';
