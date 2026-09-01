import { describe, expect, it } from 'vitest';
import { practiceLineupsRecorded, replayPracticeProgress } from '../src/practice/PracticeScreen';
import {
  practiceBonusKey,
  practiceFormat,
  practiceKeystroke,
  practiceLeftTeam,
  practiceRightTeam,
  practiceSteps,
} from '../src/practice/PracticeScenario';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { validateCorrectedHistory } from '../src/scoring/validateScoresheet';

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
        lineupEvents(['Gibson', 'Jeremy', 'Owen', 'Lachlan'], ['Tucker', 'Phillip', 'Efren', 'Valerie']),
      ),
    ).toBe(true);
    expect(
      practiceLineupsRecorded(
        lineupEvents(['Gibson', 'Jeremy', 'Owen', 'Olivia'], ['Tucker', 'Phillip', 'Efren', 'Valerie']),
      ),
    ).toBe(false);
    expect(
      practiceLineupsRecorded(
        lineupEvents(['Jeremy', 'Gibson', 'Owen', 'Lachlan'], ['Tucker', 'Phillip', 'Efren', 'Valerie']),
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

  it('teaches the Starting and Bench controls used by the real prompt', () => {
    const lineup = practiceSteps[0];

    expect(lineup.instruction).toContain('Start Gibson, Jeremy, Owen and Lachlan');
    expect(lineup.hint).toContain('leave Olivia and Bella on the Bench');
    expect(lineup.hint).toContain('↑/↓ controls');
    expect(lineup.instruction).not.toMatch(/tick|untick/i);
    expect(lineup.hint).not.toMatch(/tick|untick|Reorder starters/i);
  });

  it('tells the guided game what to press on screen, not what to type', () => {
    // The first section teaches what a scoresheet records. Naming a seat number and a ruling letter
    // there taught the keyboard layout instead — to a scorekeeper who, by default, does not have it
    // switched on and is looking at buttons that say P and +10.
    const keySequence = /\d\s*,?\s+then\s+[CPN0]\b/i;
    practiceSteps.forEach((step) => {
      expect(step.instruction, `${step.id} instruction`).not.toMatch(keySequence);
      expect(step.hint, `${step.id} hint`).not.toMatch(keySequence);
    });

    const instruction = (id: string) => practiceSteps.find((step) => step.id === id)?.instruction;
    expect(instruction('q1-power')).toBe('Press P on Gibson’s row, on the Ninety Six side.');
    expect(instruction('q2-ten')).toBe('Press +10 on Tucker’s row, on the Greenwood side.');
    expect(instruction('q3-neg')).toBe('Press N on Jeremy’s row.');
    expect(instruction('q4-wrong-no-penalty')).toContain('0 button');
    // The exception, because this shortcut works whether or not keyboard scoring is on.
    expect(instruction('q6-undo')).toContain('Ctrl/⌘ + Z');

    // And the keys are still there, for the scorekeeper who asked for them.
    expect(practiceKeystroke('q1-power')).toBe('1 then P');
  });

  it('teaches only the keyboard rulings the scoresheet actually supports', () => {
    expect(practiceKeystroke('q1-power')).toBe('1 then P');
    expect(practiceKeystroke('q2-ten')).toBe('5 then C');
    expect(practiceKeystroke('q3-neg')).toBe('2 then N');
    expect(practiceKeystroke('q4-wrong-no-penalty')).toBe('3 then 0');
    expect(practiceKeystroke('q4-dead')).toBe('Space');
    expect(practiceKeystroke('q6-undo')).toBe('Ctrl/⌘ + Z');
  });

  it('names the seat the step names, on every step the keyboard can record', () => {
    // Q6 is scored twice by the same player — once as called, once corrected after the undo — so a hint
    // naming anybody else there is a hint that contradicts the instruction beside it.
    expect(practiceKeystroke('q6-ten')).toBe('2 then C');
    expect(practiceKeystroke('q6-power')).toBe('2 then P');
    // Olivia has taken Owen's seat by Tossup 7, so her key is his.
    expect(practiceKeystroke('q7-ten')).toBe('3 then C');
    expect(practiceKeystroke('q8-ten')).toBe('6 then C');

    // Only the four steps that are genuinely mouse work go unannotated.
    const mouseOnly = ['lineup', 'q5-correction', 'substitution', 'submit'];
    expect(
      practiceSteps.filter((step) => practiceKeystroke(step.id) === null).map((step) => step.id),
    ).toEqual(mouseOnly);
  });

  it('numbers the bonus digits from the totals the format can produce', () => {
    // The digit is the number of parts, never the points: 0 / 10 / 20 / 30 are the keys 0 to 3.
    expect(practiceBonusKey(0)).toBe('0');
    expect(practiceBonusKey(10)).toBe('1');
    expect(practiceBonusKey(20)).toBe('2');
    expect(practiceBonusKey(30)).toBe('3');
    expect(practiceBonusKey(15)).toBeNull();
    expect(practiceKeystroke('q2-bonus')).toBe('1');
    expect(practiceKeystroke('q6-bonus')).toBe('1');
    expect(practiceKeystroke('q7-bonus')).toBe('3');
  });

  it('replays the current scoresheet to a safe guide checkpoint', () => {
    const events = lineupEvents(
      ['Gibson', 'Jeremy', 'Owen', 'Lachlan'],
      ['Tucker', 'Phillip', 'Efren', 'Valerie'],
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

  it('allows the Question 5 correction after Question 4 ends without a conversion', () => {
    const events: ScoreEvent[] = [
      ...lineupEvents(['Gibson', 'Jeremy', 'Owen', 'Lachlan'], ['Tucker', 'Phillip', 'Efren', 'Valerie']),
      {
        id: 'q1-tu',
        type: 'tossup-buzz',
        questionNumber: 1,
        team: 'left',
        playerName: 'Gibson',
        answerTypeIndex: 0,
      },
      { id: 'q1-bonus', type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 20 },
      {
        id: 'q2-tu',
        type: 'tossup-buzz',
        questionNumber: 2,
        team: 'right',
        playerName: 'Tucker',
        answerTypeIndex: 1,
      },
      { id: 'q2-bonus', type: 'bonus', questionNumber: 2, team: 'right', controlledPoints: 10 },
      {
        id: 'q3-neg',
        type: 'tossup-buzz',
        questionNumber: 3,
        team: 'left',
        playerName: 'Jeremy',
        answerTypeIndex: 2,
      },
      {
        id: 'q3-tu',
        type: 'tossup-buzz',
        questionNumber: 3,
        team: 'right',
        playerName: 'Tucker',
        answerTypeIndex: 1,
      },
      { id: 'q3-bonus', type: 'bonus', questionNumber: 3, team: 'right', controlledPoints: 30 },
      { id: 'q4-wrong', type: 'tossup-no-penalty', questionNumber: 4, team: 'left', playerName: 'Owen' },
      { id: 'q4-dead', type: 'tossup-dead', questionNumber: 4 },
      {
        id: 'q5-tu',
        type: 'tossup-buzz',
        questionNumber: 5,
        team: 'left',
        playerName: 'Lachlan',
        answerTypeIndex: 1,
      },
      { id: 'q5-bonus', type: 'bonus', questionNumber: 5, team: 'left', controlledPoints: 20 },
    ];
    const validation = validateCorrectedHistory(
      practiceFormat,
      {
        left: { name: practiceLeftTeam.name, players: practiceLeftTeam.players.map((player) => player.name) },
        right: {
          name: practiceRightTeam.name,
          players: practiceRightTeam.players.map((player) => player.name),
        },
      },
      events,
    );

    expect(validation.blockers).toEqual([]);
    expect(replayPracticeProgress(events, 12)).toEqual({ stepIndex: 13, acceptedEventCount: 13 });
  });
});
