/**
 * The Director's view of the canonical tournament document.
 *
 * The document itself lives in `@qbsheet/tournament-domain`, which is the one place tournament
 * state is defined for Director, persistence, interchange, and QBSheet Live. This module is the
 * Director-side name for it, so the several hundred existing imports of `../domain/model` keep
 * resolving and there is still exactly one definition behind them.
 */

export * from '@qbsheet/tournament-domain';
