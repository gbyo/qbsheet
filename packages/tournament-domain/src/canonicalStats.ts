import type { GameRecord, PlayerGameStat, TeamGameScore } from './model.js';

export const teamGameScoreCountFields = [
  'superpowers',
  'powers',
  'gets',
  'negs',
  'bonuses',
  'bonusPoints',
  'bouncebacks',
] as const satisfies readonly (keyof TeamGameScore)[];

export const playerGameStatCountFields = [
  'superpowers',
  'powers',
  'gets',
  'negs',
  'bonusPoints',
] as const satisfies readonly (keyof PlayerGameStat)[];

/** Every canonical count is a finite, non-negative whole number. */
export function isCanonicalCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

export function invalidTeamGameScoreCountField(
  score: TeamGameScore,
): (typeof teamGameScoreCountFields)[number] | null {
  return teamGameScoreCountFields.find((field) => !isCanonicalCount(score[field])) ?? null;
}

/**
 * Overtime points are unknown when the source supplied no overtime-buzz breakdown, but when
 * supplied they must be a finite number (#746). Whole in practice; negativity is legal data
 * (an overtime neg with no conversion), so only non-finite values are rejected.
 */
export function invalidTeamGameScoreOvertimePoints(score: TeamGameScore): 'overtimePoints' | null {
  const value = score.overtimePoints;
  return value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value))
    ? null
    : 'overtimePoints';
}

export function invalidPlayerGameStatCountField(
  stat: PlayerGameStat,
): (typeof playerGameStatCountFields)[number] | null {
  return playerGameStatCountFields.find((field) => !isCanonicalCount(stat[field])) ?? null;
}

export type CompetitiveOutcome = 'win' | 'loss' | 'tie';

/**
 * Evaluate the recorded competitive result from one team's perspective.
 *
 * A forfeit's score line is documentary data and is commonly 0–0. When the forfeiting side is
 * recorded, that administrative outcome takes precedence over the stored scores everywhere that
 * rankings or records compare a game. A legacy/malformed forfeit without that identity falls
 * back to the score line for compatibility with existing records.
 */
export function gameOutcomeForTeam(game: GameRecord, teamId: string): CompetitiveOutcome | null {
  const own = game.scores.find((score) => score.teamId === teamId);
  if (!own) return null;
  if (game.status === 'forfeit' && game.forfeitedTeamId) {
    if (game.forfeitedTeamId === teamId) return 'loss';
    if (game.scores.some((score) => score.teamId === game.forfeitedTeamId)) return 'win';
  }
  const opponent = game.scores.find((score) => score.teamId !== teamId);
  if (!opponent) return null;
  if (own.score > opponent.score) return 'win';
  if (own.score < opponent.score) return 'loss';
  return 'tie';
}

/** Unknown detailed stats do not become known zeroes. Legacy records without the field stay known. */
export function gameDetailedCountsKnown(game: GameRecord): boolean {
  return game.detailedStats !== 'unknown';
}
