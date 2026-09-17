/**
 * The stat sheet a room reads out when there is nothing to submit to.
 *
 * The claim under test is that this is a *presentation* of the derived game and nothing else: the
 * columns are the format's answer types, the numbers are the ones the review tables show, and no
 * value here is calculated a second time. So every case builds a real format, scores real events
 * through `deriveGame`, and compares the sheet against the derived game rather than against a
 * fixture somebody typed out.
 */
import { describe, expect, test } from 'vitest';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import { basicScorekeeperFormat, basicScoringRulesDefaults } from '../src/qbj/BasicScoringRules';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { derivedStatsGrid, serializeDerivedStats, statsCell } from '../src/scoring/statsSheet';
import { event } from './events';

const setup: IGameSetup = {
  left: { name: 'Dorman', players: ['Alice', 'Bob'] },
  right: { name: 'Wren A', players: ['Cleo', 'Dev'] },
};

/** The emergency format: 15/10, bonuses, no negs, 20 tossups. */
function noNegFormat(): IScorekeeperFormat {
  const format = basicScorekeeperFormat({
    ...basicScoringRulesDefaults,
    tossupValue: 10,
    powerValue: 15,
    negValue: undefined,
    useBonuses: true,
    tossupCount: 20,
  });
  if (!format) throw new Error('The 15/10 no-neg rules did not produce a format.');
  return format;
}

function negFormat(): IScorekeeperFormat {
  const format = basicScorekeeperFormat({
    ...basicScoringRulesDefaults,
    tossupValue: 10,
    powerValue: 15,
    negValue: -5,
    useBonuses: true,
    tossupCount: 20,
  });
  if (!format) throw new Error('The 15/10/-5 rules did not produce a format.');
  return format;
}

function typeIndex(format: IScorekeeperFormat, value: number): number {
  const found = format.answerTypes.find((answerType) => answerType.value === value);
  if (!found) throw new Error(`No answer type worth ${value}`);
  return found.index;
}

function buzz(
  questionNumber: number,
  team: 'left' | 'right',
  playerName: string,
  answerTypeIndex: number,
): ScoreEvent {
  return event({ type: 'tossup-buzz', questionNumber, team, playerName, answerTypeIndex });
}

function bonusFor(questionNumber: number, team: 'left' | 'right', controlledPoints: number): ScoreEvent {
  return event({ type: 'bonus', questionNumber, team, controlledPoints });
}

/** Four cycles: a power and a correct for each side, each with a bonus. */
function playedEvents(format: IScorekeeperFormat): ScoreEvent[] {
  return [
    buzz(1, 'left', 'Alice', typeIndex(format, 15)),
    bonusFor(1, 'left', 20),
    buzz(2, 'right', 'Cleo', typeIndex(format, 10)),
    bonusFor(2, 'right', 10),
    buzz(3, 'left', 'Bob', typeIndex(format, 10)),
    bonusFor(3, 'left', 30),
    buzz(4, 'right', 'Dev', typeIndex(format, 15)),
    bonusFor(4, 'right', 0),
  ];
}

function rowsOf(grid: string[][], heading: string): string[][] {
  const start = grid.findIndex((row) => row[0] === heading && row[1] === 'Player');
  if (start === -1) throw new Error('No player table in the stat sheet.');
  return grid.slice(start + 1).filter((row) => row.length > 0);
}

describe('the columns come from the format', () => {
  test('a format with no neg does not invent a neg column', () => {
    const format = noNegFormat();
    const game = deriveGame(format, setup, playedEvents(format));

    const header = derivedStatsGrid(format, game).find((row) => row[1] === 'Player');

    expect(header).toEqual(['Team', 'Player', 'TUH', '+15', '+10', 'Pts']);
    expect(header).not.toContain('-5');
  });

  test('a format with negs shows the neg column', () => {
    const format = negFormat();
    const game = deriveGame(format, setup, [
      ...playedEvents(format),
      buzz(5, 'left', 'Alice', typeIndex(format, -5)),
    ]);

    const grid = derivedStatsGrid(format, game);
    const header = grid.find((row) => row[1] === 'Player');

    expect(header).toEqual(['Team', 'Player', 'TUH', '+15', '+10', '-5', 'Pts']);
    const alice = rowsOf(grid, 'Team').find((row) => row[1] === 'Alice');
    expect(alice?.[5]).toBe('1');
  });

  test('a format with a different tier set is described in its own values', () => {
    const format = basicScorekeeperFormat({
      ...basicScoringRulesDefaults,
      tossupValue: 10,
      powerValue: 20,
      negValue: -5,
      useBonuses: false,
      tossupCount: 24,
    });
    if (!format) throw new Error('The 20/10/-5 rules did not produce a format.');
    const game = deriveGame(format, setup, [buzz(1, 'left', 'Alice', typeIndex(format, 20))]);

    const header = derivedStatsGrid(format, game).find((row) => row[1] === 'Player');

    expect(header).toEqual(['Team', 'Player', 'TUH', '+20', '+10', '-5', 'Pts']);
  });
});

describe('the numbers are the derived game', () => {
  test('every player line matches what the engine derived', () => {
    const format = noNegFormat();
    const game = deriveGame(format, setup, playedEvents(format));
    const grid = derivedStatsGrid(format, game);

    const lines = rowsOf(grid, 'Team');
    for (const team of [game.left, game.right]) {
      for (const player of team.players) {
        if (player.tossupsHeard === 0 && player.answerCounts.size === 0) continue;
        const line = lines.find((row) => row[0] === team.name && row[1] === player.name);
        expect(line).toBeDefined();
        expect(line?.[2]).toBe(String(player.tossupsHeard));
        expect(line?.slice(3, 3 + format.answerTypes.length)).toEqual(
          format.answerTypes.map((answerType) => String(player.answerCounts.get(answerType.index) ?? 0)),
        );
        expect(line?.[line.length - 1]).toBe(String(player.points));
      }
    }
  });

  test('the header carries the result and the tossups heard', () => {
    const format = noNegFormat();
    const game = deriveGame(format, setup, playedEvents(format));

    const grid = derivedStatsGrid(format, game, { gameLabel: 'R1 · 315' });

    expect(grid[0]).toEqual(['Game', 'R1 · 315']);
    expect(grid[1]).toEqual([
      'Result',
      'Dorman',
      String(game.left.points),
      'Wren A',
      String(game.right.points),
    ]);
    expect(grid[2]).toEqual(['Tossups heard', String(game.tossupsRead)]);
  });

  test('team totals are the derived tossup, bonus and final points', () => {
    const format = noNegFormat();
    const game = deriveGame(format, setup, playedEvents(format));

    const grid = derivedStatsGrid(format, game);
    const heading = grid.findIndex((row) => row[0] === 'Team' && row[1] === 'Points');

    expect(grid[heading]).toEqual(['Team', 'Points', 'Tossups', 'Bonuses']);
    expect(grid[heading + 1]).toEqual([
      'Dorman',
      String(game.left.points),
      String(game.left.tossupPoints),
      String(game.left.bonusPoints),
    ]);
    expect(grid[heading + 2]).toEqual([
      'Wren A',
      String(game.right.points),
      String(game.right.tossupPoints),
      String(game.right.bonusPoints),
    ]);
  });

  test('a game with no bouncebacks, lightning or adjustments has no columns for them', () => {
    const format = noNegFormat();
    const game = deriveGame(format, setup, playedEvents(format));

    const heading = derivedStatsGrid(format, game).find((row) => row[1] === 'Points');

    expect(heading).not.toContain('Bouncebacks');
    expect(heading).not.toContain('Lightning');
    expect(heading).not.toContain('Adjustment');
  });

  test('an adjustment is reported when the game has one', () => {
    const format = noNegFormat();
    const game = deriveGame(format, setup, [
      ...playedEvents(format),
      event({ type: 'adjustment', questionNumber: 4, team: 'left', points: -10, reason: 'Protest' }),
    ]);

    const heading = derivedStatsGrid(format, game).find((row) => row[1] === 'Points');

    expect(heading).toContain('Adjustment');
    expect(game.left.adjustmentPoints).toBe(-10);
  });

  test('nobody who never heard a tossup is given a row of zeroes', () => {
    const format = noNegFormat();
    const game = deriveGame(format, setup, []);

    const grid = derivedStatsGrid(format, game);

    expect(rowsOf(grid, 'Team')).toEqual([]);
  });
});

describe('the text a scorekeeper pastes', () => {
  test('is the grid, tab separated, one row per line', () => {
    const format = noNegFormat();
    const game = deriveGame(format, setup, playedEvents(format));

    const tsv = serializeDerivedStats(format, game, { gameLabel: 'R1 · 315' });

    expect(tsv.split('\n')).toEqual(
      derivedStatsGrid(format, game, { gameLabel: 'R1 · 315' }).map((row) => row.join('\t')),
    );
    expect(tsv).toContain('Team\tPlayer\tTUH\t+15\t+10\tPts');
    const alice = game.left.players.find((player) => player.name === 'Alice');
    expect(tsv).toContain(`Dorman\tAlice\t${alice?.tossupsHeard}\t1\t0\t${alice?.points}`);
  });

  test('has no game label line when the game was never named', () => {
    const format = noNegFormat();
    const game = deriveGame(format, setup, playedEvents(format));

    const lines = serializeDerivedStats(format, game).split('\n');

    expect(lines[0].startsWith('Result\t')).toBe(true);
    expect(lines.some((line) => line.startsWith('Game\t'))).toBe(false);
  });

  test('a cell cannot break the grid or become a formula', () => {
    expect(statsCell('Wren\tA')).toBe('Wren A');
    expect(statsCell('Wren\nA')).toBe('Wren A');
    expect(statsCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(statsCell('  Dorman  ')).toBe('Dorman');
  });
});
