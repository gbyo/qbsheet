import { describe, expect, it } from 'vitest';
import { practiceLineupsRecorded, replayPracticeProgress } from '../src/practice/PracticeScreen';
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
        lineupEvents(['Gibson', 'Jeremy', 'Owen', 'Lachlan'], ['Tucker', 'Sam', 'Efren', 'Valerie']),
      ),
    ).toBe(true);
    expect(
      practiceLineupsRecorded(
        lineupEvents(['Gibson', 'Jeremy', 'Owen', 'Olivia'], ['Tucker', 'Sam', 'Efren', 'Valerie']),
      ),
    ).toBe(false);
  });

  it('includes correction, substitution and submission lessons', () => {
    expect(practiceSteps.some((step) => step.expectation.kind === 'undo')).toBe(true);
    expect(practiceSteps.some((step) => step.expectation.kind === 'history')).toBe(true);
    expect(practiceSteps.some((step) => step.id === 'q4-wrong-no-penalty')).toBe(true);
    expect(practiceSteps.some((step) => step.id === 'substitution')).toBe(true);
    expect(practiceSteps.at(-1)?.expectation.kind).toBe('submit');
  });

  it('replays the current scoresheet to a safe guide checkpoint', () => {
    const events = lineupEvents(
      ['Gibson', 'Jeremy', 'Owen', 'Lachlan'],
      ['Tucker', 'Sam', 'Efren', 'Valerie'],
    );
    expect(replayPracticeProgress(events)).toEqual({ stepIndex: 1, acceptedEventCount: 2 });

    events.push({
      id: 'q1',
      type: 'tossup-buzz',
      questionNumber: 1,
      team: 'left',
      playerName: 'Gibson',
      answerTypeIndex: 0,
    });
    expect(replayPracticeProgress(events)).toEqual({ stepIndex: 2, acceptedEventCount: 3 });

    events[2] = { ...events[2], answerTypeIndex: 1 } as ScoreEvent;
    expect(replayPracticeProgress(events)).toEqual({ stepIndex: 1, acceptedEventCount: 2 });
  });
});
