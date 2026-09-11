/**
 * SQBS authoritative-export preflight (#897).
 *
 * Completeness is a per-game fact the export must honor: a result accepted
 * with incomplete individual stats fails closed (partial player detail can
 * never publish as a complete game), unknown detail stays exportable with
 * explicit warnings, and the two recorded representations of a game — team
 * aggregates vs summed player lines, bonus aggregates vs bonus-earning
 * conversions — reconcile with warnings instead of silent picks.
 */
import { describe, expect, test } from 'vitest';
import { parseSqbsTournamentFile } from '@qbsheet/tournament-formats';
import { directorFixture } from '../transfers/testFixtures';
import { exportSqbsTournament } from './interchange';
import { isoNow, type DirectorState, type GameRecord } from '../domain/model';

function consistentGame(
  id: string,
  scheduledGameId: string,
  detailedStats: GameRecord['detailedStats'],
): GameRecord {
  const side = (teamId: string, score: number): GameRecord['scores'][number] => ({
    teamId,
    score,
    superpowers: 0,
    powers: 1,
    gets: 5,
    negs: 1,
    bonuses: 6,
    bonusPoints: 100,
  });
  const lines = (playerId: string, teamId: string): GameRecord['playerStats'][number] => ({
    playerId,
    teamId,
    superpowers: 0,
    powers: 1,
    gets: 5,
    negs: 1,
    bonusPoints: 0,
    tossupsHeard: 20,
  });
  return {
    id,
    scheduledGameId,
    roundId: 'round-5',
    packetId: 'packet-5',
    status: 'accepted',
    // 15 + 5×10 − 5 + 100 bonus = 160; decisive against the mirror side below.
    scores: [side('team-1', 160), side('team-2', 150)],
    playerStats: [lines('team-1-player-1', 'team-1'), lines('team-2-player-1', 'team-2')],
    tossupsRead: 20,
    overtimeTossupsRead: 0,
    source: 'manual',
    detailedStats,
    acceptedAt: isoNow(),
  };
}

function stateWith(game: GameRecord): DirectorState {
  const state = directorFixture();
  state.games.push(game);
  return state;
}

describe('SQBS authoritative-export preflight (#897)', () => {
  test('incomplete individual stats fail closed with no file', () => {
    const game = consistentGame('game-partial-1', 'game-5-1', 'incomplete');
    // Only one side's scorer turned in player detail.
    game.playerStats = game.playerStats.filter((entry) => entry.teamId === 'team-1');

    const exported = exportSqbsTournament(stateWith(game), {});
    expect(exported.ok).toBe(false);
    expect(exported.text).toBe('');
    expect(exported.errors.join('\n')).toMatch(/game-partial-1.*incomplete individual stats/);
  });

  test('verified-complete detail exports quietly', () => {
    const exported = exportSqbsTournament(
      stateWith(consistentGame('game-full-1', 'game-5-1', 'complete')),
      {},
    );
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(
      exported.warnings.filter((entry) =>
        /incomplete|does not match|bonuses heard|unknown completeness/i.test(entry),
      ),
    ).toEqual([]);
    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
  });

  test('team totals disagreeing with player lines warn by game, side, and category', () => {
    const game = consistentGame('game-mismatch-1', 'game-5-1', 'complete');
    game.scores[0] = { ...game.scores[0]!, powers: 4 };
    const exported = exportSqbsTournament(stateWith(game), {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.warnings.filter((entry) => /game-mismatch-1 left powers/.test(entry))).toHaveLength(1);
  });

  test('impossible bonus aggregates warn even where overtime could exist', () => {
    const game = consistentGame('game-bh-1', 'game-5-1', 'complete');
    game.overtimeTossupsRead = 2;
    game.scores[1] = { ...game.scores[1]!, bonuses: 9 };
    const exported = exportSqbsTournament(stateWith(game), {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    // Six correct conversions can never hear nine bonuses.
    expect(exported.warnings.filter((entry) => /game-bh-1 right.*9 bonuses heard/.test(entry))).toHaveLength(
      1,
    );
  });

  test('missing bonuses with provably no overtime warn; possible overtime stays quiet', () => {
    const noOvertime = consistentGame('game-bh-2', 'game-5-1', 'complete');
    noOvertime.overtimeTossupsRead = 0;
    noOvertime.scores[0] = { ...noOvertime.scores[0]!, bonuses: 4 };
    const quiet = exportSqbsTournament(stateWith(noOvertime), {});
    expect(quiet.ok).toBe(true);
    if (!quiet.ok) return;
    expect(quiet.warnings.filter((entry) => /bonuses heard for 6 correct/.test(entry))).toHaveLength(1);

    const maybeOvertime = consistentGame('game-bh-3', 'game-5-1', 'complete');
    maybeOvertime.overtimeTossupsRead = 2;
    maybeOvertime.scores[0] = { ...maybeOvertime.scores[0]!, bonuses: 4 };
    const loud = exportSqbsTournament(stateWith(maybeOvertime), {});
    expect(loud.ok).toBe(true);
    if (!loud.ok) return;
    // Four bonuses for six conversions is plausible with no-bonus overtime.
    expect(loud.warnings.filter((entry) => /bonuses heard/.test(entry))).toEqual([]);
  });

  test('unknown-completeness player lines export as recorded, flagged estimated', () => {
    const exported = exportSqbsTournament(
      stateWith(consistentGame('game-unknown-1', 'game-5-1', 'unknown')),
      {},
    );
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(
      exported.warnings.filter((entry) => /game-unknown-1.*unknown completeness/.test(entry)),
    ).toHaveLength(1);
    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.games[0]!.left.players).toHaveLength(1);
  });

  test('forfeit placeholders skip reconciliation', () => {
    const game = consistentGame('game-forfeit-1', 'game-5-1', 'complete');
    const exported = exportSqbsTournament(
      stateWith({
        ...game,
        status: 'forfeit',
        forfeitedTeamId: 'team-2',
        scores: [
          { ...game.scores[0]!, score: 0, powers: 0, gets: 0, negs: 0, bonuses: 0, bonusPoints: 0 },
          { ...game.scores[1]!, score: 0, powers: 0, gets: 0, negs: 0, bonuses: 0, bonusPoints: 0 },
        ],
      }),
      {},
    );
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.warnings.filter((entry) => /does not match|bonuses heard/.test(entry))).toEqual([]);
  });
});
