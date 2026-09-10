import type { GameRecord, PlayerGameStat, TeamGameScore } from './model.js';

export const teamGameScoreCountFields = [
  'superpowers',
  'powers',
  'gets',
  'negs',
  'bonuses',
  'bonusPoints',
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
 * Bounceback points are optional (unknown when the source supplied no breakdown), but when
 * supplied they must be a canonical count (#748).
 */
export function invalidTeamGameScoreBouncebacks(score: TeamGameScore): 'bouncebacks' | null {
  const value = score.bouncebacks;
  return value === undefined || value === null || isCanonicalCount(value) ? null : 'bouncebacks';
}

/**
 * Bounceback points earned by one team line. An omitted field (programmatic construction)
 * is a zero; `null` is an explicit unknown from a manual/legacy source that supplied no
 * bounceback breakdown (#748).
 */
export function bouncebacksOf(score: TeamGameScore): number {
  return score.bouncebacks ?? 0;
}

/**
 * False only when the source explicitly left bouncebacks unknown (`null`), e.g. a manual
 * or legacy result without a bounceback breakdown — never a verified zero.
 */
export function bouncebacksKnownOf(score: TeamGameScore): boolean {
  return score.bouncebacks !== null;
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
