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
  /** Lightning points for this team-game; null when the result lacks the breakdown. */
  lightningPoints: number | null;
  /**
   * Bounceback parts heard off this game's opponent (canonical #748 arithmetic,
   * resolved by the adapter under the game's own definition). Null when the
   * opponent bonus detail is missing or the game's bonuses are irregular — never
   * a fabricated zero.
   */
  bouncebackPartsHeard: number | null;
  /** Bounceback parts converted off this game's opponent; null under the same conditions. */
  bouncebackPartsConverted: number | null;
  /** Own converted bonus parts in this game; null when detail or regularity is missing. */
  bonusPartsConverted: number | null;
  /** Own bonus parts heard in this game; null when detail or regularity is missing. */
  bonusPartsHeard: number | null;
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
}

// Keep this import semantically used so module augmentation is retained by
// declaration emit/bundlers even though this file only adds type information.
export type DetailedGameStatsRow = GameStatsRow;
