/**
 * The rules the lineup editors, the undo feedback and the Game menu are built out of.
 *
 * Kept apart from the screens that use them because these are the parts with an answer that can be
 * stated: what array a membership change produces, which names a boundary makes unavailable, what
 * one sentence describes a frame of events, and where a rule belongs between groups that may or may
 * not exist. Testing them here means the component tests can be about what a scorekeeper sees.
 */
import { describe, expect, test } from 'vitest';
import { orderedActivePlayers, playersAddedAfter, sameMembership } from '../src/scorer/LineupEditing';
import { frameDescription, frameQuestion } from '../src/scorer/OperationsDialogs';
import { joinMenuGroups, IGameMenuItem } from '../src/scorer/GameMenu';
import { assignmentStateKey, checkStatusLine, lastCheckLabel } from '../src/app/ConnectedSetup';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import { IDerivedGame } from '../src/scoring/deriveGame';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';

const roster = ['Sarah', 'James', 'Olivia', 'Priya'];

describe('the lineup a membership change produces', () => {
  test('keeps the players who stayed in the order the event already had them', () => {
    // Deliberately not roster order: this is what the recorded event says, and it is what survives.
    const recorded = ['Olivia', 'Sarah'];
    expect(orderedActivePlayers(recorded, roster, new Set(['Sarah', 'Olivia']))).toEqual(['Olivia', 'Sarah']);
  });

  test('appends genuinely new players in roster order, whatever order they were pressed in', () => {
    const recorded = ['Sarah'];
    const pressedLate = new Set(['Sarah', 'Priya', 'James']);
    const pressedEarly = new Set(['Sarah', 'James', 'Priya']);

    expect(orderedActivePlayers(recorded, roster, pressedLate)).toEqual(['Sarah', 'James', 'Priya']);
    // The same membership reached the other way round is the same event. This is the whole point.
    expect(orderedActivePlayers(recorded, roster, pressedEarly)).toEqual(
      orderedActivePlayers(recorded, roster, pressedLate),
    );
  });

  test('a player taken off and put back is not moved to the end', () => {
    const recorded = ['Sarah', 'James', 'Olivia'];
    const after = new Set(recorded);
    after.delete('James');
    after.add('James');

    expect(orderedActivePlayers(recorded, roster, after)).toEqual(recorded);
  });

  test('a name on no roster is kept rather than silently dropped', () => {
    expect(orderedActivePlayers(['Sarah'], roster, new Set(['Sarah', 'Ghost']))).toEqual(['Sarah', 'Ghost']);
  });

  test('membership is compared without regard to order', () => {
    expect(sameMembership(['Sarah', 'James'], ['James', 'Sarah'])).toBe(true);
    expect(sameMembership(['Sarah', 'James'], ['Sarah', 'Olivia'])).toBe(false);
    expect(sameMembership(['Sarah'], ['Sarah', 'James'])).toBe(false);
  });
});

describe('who the roster did not have yet', () => {
  const events: ScoreEvent[] = [
    { id: 'a', type: 'roster-add', questionNumber: 5, team: 'left', playerName: 'Olivia' },
    { id: 'b', type: 'roster-add', questionNumber: 14, team: 'left', playerName: 'Priya' },
    { id: 'c', type: 'roster-add', questionNumber: 2, team: 'right', playerName: 'Nadia' },
  ];

  test('nobody, at a boundary after every addition', () => {
    expect(Array.from(playersAddedAfter(events, 'left', 20))).toEqual([]);
  });

  test('the additions that had not happened yet, at an earlier boundary', () => {
    expect(Array.from(playersAddedAfter(events, 'left', 8))).toEqual(['Priya']);
    expect(Array.from(playersAddedAfter(events, 'left', 1))).toEqual(['Olivia', 'Priya']);
  });

  test('a boundary exactly at the addition counts the player as rostered', () => {
    expect(playersAddedAfter(events, 'left', 5).has('Olivia')).toBe(false);
  });

  test('the other team is a different roster', () => {
    expect(playersAddedAfter(events, 'left', 1).has('Nadia')).toBe(false);
  });
});

describe('naming an undo or redo frame', () => {
  const format: IScorekeeperFormat = scoringRulesToScorekeeperFormat(new ScoringRules(CommonRuleSets.AcfPowers));
  const game = { left: { name: 'Ninety Six' }, right: { name: 'Greenwood' } } as unknown as IDerivedGame;
  const buzz = (id: string, questionNumber: number, playerName: string): ScoreEvent => ({
    id,
    type: 'tossup-buzz',
    questionNumber,
    team: 'left',
    playerName,
    answerTypeIndex: 1,
  });

  test('one event is named by what it was', () => {
    expect(frameDescription([buzz('a', 7, 'Jeremy')], format, game)).toBe('Q7 · Jeremy +10');
  });

  test('both opening lineups are one action with a name of its own', () => {
    const frame: ScoreEvent[] = [
      { id: 'a', type: 'substitution', questionNumber: 1, team: 'left', activePlayers: ['Sarah'] },
      { id: 'b', type: 'substitution', questionNumber: 1, team: 'right', activePlayers: ['Emma'] },
    ];
    expect(frameDescription(frame, format, game)).toBe('starting lineups');
  });

  test('several records on one question are counted rather than listed', () => {
    const frame: ScoreEvent[] = [
      buzz('a', 12, 'Jeremy'),
      { id: 'b', type: 'bonus', questionNumber: 12, team: 'left', controlledPoints: 20 },
    ];
    expect(frameDescription(frame, format, game)).toBe('Q12 · 2 scoring records');
  });

  test('a mixed frame on one question says how much changed, not what the machinery was', () => {
    const frame: ScoreEvent[] = [
      { id: 'a', type: 'note', questionNumber: 9, text: 'Question replaced: wrong packet', flagged: true },
      { id: 'b', type: 'question-void', questionNumber: 9, scope: 'tossup', reason: 'wrong packet' },
    ];
    expect(frameDescription(frame, format, game)).toBe('Q9 · 2 changes');
  });

  test('a frame spanning questions points at no single one', () => {
    const frame = [buzz('a', 3, 'Jeremy'), buzz('b', 4, 'Sarah')];
    expect(frameDescription(frame, format, game)).toBe('2 changes');
    expect(frameQuestion(frame)).toBeUndefined();
    expect(frameQuestion([buzz('a', 3, 'Jeremy')])).toBe(3);
  });
});

describe('ruling between menu groups', () => {
  const entry = (label: string): IGameMenuItem => ({ label, icon: 'game', onSelect: () => undefined });

  test('a rule appears between each pair of groups that both have entries', () => {
    const joined = joinMenuGroups([[entry('a'), entry('b')], [entry('c')], [entry('d')]]);
    expect(joined.map((item) => `${item.dividerBefore ? '|' : ''}${item.label}`)).toEqual(['a', 'b', '|c', '|d']);
  });

  test('an empty group leaves no rule behind it', () => {
    const joined = joinMenuGroups([[entry('a')], [], [entry('b')]]);
    expect(joined.filter((item) => item.dividerBefore).map((item) => item.label)).toEqual(['b']);
  });

  test('nothing is ruled off the top, and one group is ruled nowhere', () => {
    expect(joinMenuGroups([[], [entry('a')], []])[0].dividerBefore).toBeUndefined();
    expect(joinMenuGroups([[entry('a'), entry('b')]]).some((item) => item.dividerBefore)).toBe(false);
  });
});

describe('what the room screen says about checking', () => {
  test('the same assignment read twice is the same meaningful state', () => {
    const assigned = { state: 'assigned', scheduledMatchId: 'm-5', definition: {} };
    expect(assignmentStateKey(assigned as never)).toBe(assignmentStateKey({ ...assigned } as never));
  });

  test('the four situations, and the game inside the one that has one', () => {
    expect(assignmentStateKey(null)).toBe('none');
    expect(assignmentStateKey({ state: 'held' } as never)).toBe('held');
    expect(assignmentStateKey({ state: 'blocked' } as never)).toBe('blocked');
    expect(assignmentStateKey({ state: 'none', definition: null } as never)).toBe('none');
    expect(assignmentStateKey({ state: 'assigned', scheduledMatchId: 'm-6', definition: {} } as never)).toBe(
      'assigned:m-6',
    );
    // An assignment whose game changed is a different state, and is the one that should move.
    expect(assignmentStateKey({ state: 'assigned', scheduledMatchId: 'm-7', definition: {} } as never)).not.toBe(
      'assigned:m-6',
    );
  });

  test('before the first answer it says it is asking', () => {
    expect(checkStatusLine({ forbidden: '', lastSuccessfulCheckAt: null, now: 1000, failing: false })).toBe(
      'Checking tournament control…',
    );
  });

  test('a healthy room says it checks on its own, and when it last did', () => {
    expect(checkStatusLine({ forbidden: '', lastSuccessfulCheckAt: 1000, now: 3000, failing: false })).toBe(
      'QBSheet checks automatically · checked just now',
    );
    expect(
      checkStatusLine({ forbidden: '', lastSuccessfulCheckAt: 0, now: 5 * 60_000, failing: false }),
    ).toBe('QBSheet checks automatically · checked 5 minutes ago');
  });

  test('a failed poll does not let it claim it is currently in touch', () => {
    const line = checkStatusLine({ forbidden: '', lastSuccessfulCheckAt: 1000, now: 20_000, failing: true });
    expect(line).toBe('Automatic checks continue · last successful check less than a minute ago');
    expect(line).not.toContain('just now');
  });

  test('a refusal stops the checking, so the line stops claiming it happens', () => {
    const line = checkStatusLine({ forbidden: 'Not allowed.', lastSuccessfulCheckAt: 1000, now: 2000, failing: false });
    expect(line).toBe('Automatic checks paused · choose Check now after this is fixed.');
    expect(line).not.toContain('checks automatically');
  });

  test('ages are said the way somebody would say them', () => {
    expect(lastCheckLabel(0)).toBe('less than a minute ago');
    expect(lastCheckLabel(90_000)).toBe('1 minute ago');
    expect(lastCheckLabel(7 * 60_000)).toBe('7 minutes ago');
    expect(lastCheckLabel(70 * 60_000)).toBe('over an hour ago');
    expect(lastCheckLabel(200 * 60_000)).toBe('over 3 hours ago');
  });
});
