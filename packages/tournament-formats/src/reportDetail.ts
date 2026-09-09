import type { GameStatsRow } from './stats.js';

/**
 * Canonical per-game team detail carried alongside the score-level game row.
 *
 * Nullable statistics mean the accepted result did not provide trustworthy
 * detail for that field. They are intentionally distinct from known zeroes.
 */
export interface GameTeamStatsRow {
  teamId: string;
  teamName: string;
  points: number;
  superpowers: number | null;
  powers: number | null;
  gets: number | null;
  negs: number | null;
  tossupsHeard: number | null;
  bonusesHeard: number | null;
  bonusPoints: number | null;
  ppb: number | null;
  bouncebacks: number | null;
}

/**
 * Canonical player participation/stat detail for one accepted game.
 *
 * A row exists only when the result contains a player line. Roster membership
 * alone never creates a game appearance.
 */
export interface GamePlayerStatsRow {
  playerId: string;
  playerName: string;
  teamId: string;
  teamName: string;
  tossupsHeard: number | null;
  superpowers: number | null;
  powers: number | null;
  gets: number | null;
  negs: number | null;
  bonusPoints: number | null;
  points: number | null;
}

export interface RoundStatsCoverage {
  playedGames: number;
  detailGames: number;
  tossupsReadGames: number;
  regulationGames: number;
  bonusGames: number;
}

/**
 * A report-safe canonical round aggregate. Every nullable metric carries the
 * strict knownness decision made by the tournament-domain derivation; HTML
 * renderers only format these values and never recalculate competitive stats.
 */
export interface RoundStatsRow {
  roundId: string;
  roundName: string;
  phaseId?: string;
  phaseName?: string;
  packetName: string | null;
  games: number;
  teams: number;
  playedGames: number;
  regulationTossupCount: number | null;
  tossupsRead: number | null;
  pointsPerTeamPerXTuh: number | null;
  superpowerRate: number | null;
  powerRate: number | null;
  tossupConversionRate: number | null;
  negRatePerXTuh: number | null;
  ppb: number | null;
  bonusConversionRate: number | null;
  superpowerApplicable: boolean | null;
  powerApplicable: boolean | null;
  negApplicable: boolean | null;
  bonusApplicable: boolean | null;
  coverage: RoundStatsCoverage;
  notes: string[];
}

/**
 * Extend the existing public game row without breaking version-1 snapshot
 * consumers. Older snapshots simply omit these optional fields; richer
 * Director snapshots can carry the normalized detail needed by printable
 * box scores, team logs, player logs, and round aggregates.
 */
declare module './stats.js' {
  interface GameStatsRow {
    poolId?: string;
    packetId?: string;
    packetName?: string;
    forfeitedTeamId?: string;
    /** Exact tossups read when the canonical source knows it; null means unknown. */
    tossupsRead?: number | null;
    /** Exact overtime tossups read when known; null means unknown. */
    overtimeTossupsRead?: number | null;
    teamStats?: GameTeamStatsRow[];
    playerStats?: GamePlayerStatsRow[];
  }

  interface StatsSnapshot {
    /** Canonical round aggregates in the snapshot's already-filtered scope. */
    rounds?: RoundStatsRow[];
    /** Overall aggregate recomputed from every game in scope, never averaged from round rows. */
    roundTotal?: RoundStatsRow | null;
  }
}

// Keep this import semantically used so module augmentation is retained by
// declaration emit/bundlers even though this file only adds type information.
export type DetailedGameStatsRow = GameStatsRow;
