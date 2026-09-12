import { describe, expect, test } from 'vitest';
import { basicScorekeeperFormat, basicScoringRulesDefaults } from '../src/qbj/BasicScoringRules';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import { derivedStatsGrid, serializeDerivedStats } from '../src/scoring/statsSheet';
import { event } from './events';

const setup: IGameSetup = {
  left: { name: 'Dorman', players: ['Alice'] },
  right: { name: 'Wren A', players: ['Cleo'] },
};

function overtimeFormat() {
  const format = basicScorekeeperFormat({
    ...basicScoringRulesDefaults,
    tossupValue: 10,
    powerValue: 15,
    negValue: undefined,
    useBonuses: true,
    tossupCount: 1,
    overtimeQuestionCount: 1,
    overtimeIncludesBonuses: false,
  });
  if (!format) throw new Error('The overtime test rules did not produce a format.');
  return format;
}

function typeIndex(format: ReturnType<typeof overtimeFormat>, value: number): number {
  const answerType = format.answerTypes.find((candidate) => candidate.value === value);
  if (!answerType) throw new Error(`No answer type worth ${value}`);
  return answerType.index;
}

describe('the copied stat sheet preserves overtime handoff data', () => {
  test('keeps team-level overtime answer counts separate from the player totals', () => {
    const format = overtimeFormat();
    const correct = typeIndex(format, 10);
    const game = deriveGame(format, setup, [
      event({ type: 'tossup-dead', questionNumber: 1 }),
      event({
        type: 'tossup-buzz',
        questionNumber: 2,
        team: 'left',
        playerName: 'Alice',
        answerTypeIndex: correct,
      }),
    ]);

    // The player's ordinary answer counts include the overtime conversion, while the team keeps the
    // same conversion separately so YellowFruit-style bonus-heard math can exclude no-bonus overtime.
    expect(game.left.players[0].answerCounts.get(correct)).toBe(1);
    expect(game.left.overtimeBuzzes.get(correct)).toBe(1);
    expect(game.left.bonusesHeard).toBe(0);

    const grid = derivedStatsGrid(format, game);
    const overtime = grid.findIndex((row) => row[0] === 'Overtime answer counts');

    expect(overtime).toBeGreaterThan(-1);
    expect(grid[overtime + 1]).toEqual(['Team', '+15', '+10']);
    expect(grid[overtime + 2]).toEqual(['Dorman', '0', '1']);
    expect(grid[overtime + 3]).toEqual(['Wren A', '0', '0']);

    const tsv = serializeDerivedStats(format, game);
    expect(tsv).toContain('Overtime tossups\t1');
    expect(tsv).toContain('Overtime answer counts\nTeam\t+15\t+10\nDorman\t0\t1\nWren A\t0\t0');
    expect(tsv).toContain('Dorman\tAlice\t2\t0\t1\t10');
  });
});
