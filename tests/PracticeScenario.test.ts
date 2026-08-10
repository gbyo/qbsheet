import { describe, expect, it } from 'vitest';
import { practiceLineupsRecorded } from '../src/practice/PracticeScreen';
import { practiceFormat, practiceSteps } from '../src/practice/PracticeScenario';
import { ScoreEvent } from '../src/scoring/ScoreEvents';

function lineupEvents(left: string[], right: string[]): ScoreEvent[] {
  return [
    { id: 'left-lineup', type: 'substitution', questionNumber: 1, team: 'left', activePlayers: left },
    { id: 'right-lineup', type: 'substitution', questionNumber: 1, team: 'right', activePlayers: right },
  ];
}

describe('guided practice scenario', () => {
  it('uses a short scoreable format with powers, tens, negs and bonuses', () => {
    expect(practiceFormat.regulation.tossupCount).toBe(8);
    expect(practiceFormat.answerTypes.map((answerType) => answerType.value)).toEqual([15, 10, -5]);
    expect(practiceFormat.bonus.enabled).toBe(true);
    expect(practiceFormat.players.maximumActive).toBe(4);
  });

  it('recognizes the real substitution events emitted by the starting-lineup prompt', () => {
    expect(
      practiceLineupsRecorded(
        lineupEvents(['Jordan', 'Alex', 'Sam', 'Taylor'], ['Maya', 'Chris', 'Riley', 'Evan']),
      ),
    ).toBe(true);
    expect(
      practiceLineupsRecorded(
        lineupEvents(['Jordan', 'Alex', 'Sam', 'Casey'], ['Maya', 'Chris', 'Riley', 'Evan']),
      ),
    ).toBe(false);
  });

  it('includes correction, substitution and submission lessons', () => {
    expect(practiceSteps.some((step) => step.expectation.kind === 'undo')).toBe(true);
    expect(practiceSteps.some((step) => step.id === 'substitution')).toBe(true);
    expect(practiceSteps.at(-1)?.expectation.kind).toBe('submit');
  });
});
