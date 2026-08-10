import { describe, expect, it } from 'vitest';
import { IGameSetup } from '../src/scoring/deriveGame';
import {
  practiceFormat,
  practiceLeftTeam,
  practiceLineupReady,
  practiceRightTeam,
  practiceSteps,
} from '../src/practice/PracticeScenario';

function setup(left: string[], right: string[]): IGameSetup {
  return {
    left: { name: practiceLeftTeam.name, players: practiceLeftTeam.players.map((player) => player.name), startingLineup: left },
    right: {
      name: practiceRightTeam.name,
      players: practiceRightTeam.players.map((player) => player.name),
      startingLineup: right,
    },
  };
}

describe('guided practice scenario', () => {
  it('uses a short scoreable format with powers, tens, negs and bonuses', () => {
    expect(practiceFormat.regulation.tossupCount).toBe(8);
    expect(practiceFormat.answerTypes.map((answerType) => answerType.value)).toEqual([15, 10, -5]);
    expect(practiceFormat.bonus.enabled).toBe(true);
    expect(practiceFormat.players.maximumActive).toBe(4);
  });

  it('requires the intended four starters before advancing', () => {
    expect(practiceLineupReady(setup(['Jordan', 'Alex', 'Sam', 'Taylor'], ['Maya', 'Chris', 'Riley', 'Evan']))).toBe(true);
    expect(practiceLineupReady(setup(['Jordan', 'Alex', 'Sam', 'Casey'], ['Maya', 'Chris', 'Riley', 'Evan']))).toBe(false);
  });

  it('includes correction, substitution and submission lessons', () => {
    expect(practiceSteps.some((step) => step.expectation.kind === 'undo')).toBe(true);
    expect(practiceSteps.some((step) => step.id === 'substitution')).toBe(true);
    expect(practiceSteps.at(-1)?.expectation.kind).toBe('submit');
  });
});
