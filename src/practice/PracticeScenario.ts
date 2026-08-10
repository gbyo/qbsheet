import { IScorekeeperFormat, scorekeeperFormatVersion } from '../scoring/ScorekeeperFormat';
import { bonusEventPoints, ScoreEvent } from '../scoring/ScoreEvents';
import { IGameSetup } from '../scoring/deriveGame';
import { ITeamRoster } from '../game/Roster';

export type PracticeExpectation =
  | { kind: 'lineup' }
  | { kind: 'event'; matches: (event: ScoreEvent) => boolean }
  | { kind: 'history'; matches: (events: ScoreEvent[]) => boolean }
  | { kind: 'undo' }
  | { kind: 'submit' };

export interface IPracticeStep {
  id: string;
  title: string;
  call: string;
  instruction: string;
  hint: string;
  success: string;
  section: 'Get ready' | 'Score the game' | 'Fix mistakes' | 'Finish safely';
  expectation: PracticeExpectation;
}

const answerTypes = [
  {
    index: 0,
    value: 15,
    label: 'Power',
    shortLabel: 'P',
    isPower: true,
    isNeg: false,
    awardsBonus: true,
    qbjId: 'AnswerType_Power',
  },
  {
    index: 1,
    value: 10,
    label: 'Correct',
    shortLabel: '10',
    isPower: false,
    isNeg: false,
    awardsBonus: true,
    qbjId: 'AnswerType_10',
  },
  {
    index: 2,
    value: -5,
    label: 'Neg',
    shortLabel: 'N',
    isPower: false,
    isNeg: true,
    awardsBonus: false,
    qbjId: 'AnswerType_Neg',
  },
];

export const practiceFormat: IScorekeeperFormat = {
  version: scorekeeperFormatVersion,
  name: 'Practice rules',
  answerTypes,
  regulation: { timed: false, tossupCount: 8, maximumTossupCount: 8 },
  bonus: {
    enabled: true,
    bounceBack: false,
    regular: true,
    divisor: 10,
    minimumParts: 3,
    maximumParts: 3,
    pointsPerPart: 10,
    maximumScore: 30,
  },
  overtime: { minimumQuestionCount: 3, suddenDeath: false, includesBonuses: false },
  lightning: { enabled: false, countPerTeam: 0, divisor: 10 },
  players: { maximumActive: 4 },
  totalDivisor: 5,
};

export const practiceLeftTeam: ITeamRoster & { startingLineup: string[] } = {
  name: 'Ninety Six',
  players: ['Gibson', 'Jeremy', 'Owen', 'Lachlan', 'Olivia'].map((name) => ({ name })),
  startingLineup: ['Gibson', 'Jeremy', 'Owen', 'Lachlan'],
};

export const practiceRightTeam: ITeamRoster & { startingLineup: string[] } = {
  name: 'Riverton Prep',
  players: ['Tucker', 'Sam', 'Efren', 'Valerie', 'Bella'].map((name) => ({ name })),
  startingLineup: ['Tucker', 'Sam', 'Efren', 'Valerie'],
};

function tossup(questionNumber: number, team: 'left' | 'right', playerName: string, answerTypeIndex: number) {
  return (event: ScoreEvent) =>
    event.type === 'tossup-buzz' &&
    event.questionNumber === questionNumber &&
    event.team === team &&
    event.playerName === playerName &&
    event.answerTypeIndex === answerTypeIndex;
}

function bonus(questionNumber: number, team: 'left' | 'right', points: number) {
  return (event: ScoreEvent) => {
    if (event.type !== 'bonus' || event.questionNumber !== questionNumber || event.team !== team) return false;
    return bonusEventPoints(event)[0] === points;
  };
}

function dead(questionNumber: number) {
  return (event: ScoreEvent) => event.type === 'tossup-dead' && event.questionNumber === questionNumber;
}

function wrongNoPenalty(questionNumber: number, team: 'left' | 'right', playerName: string) {
  return (event: ScoreEvent) =>
    event.type === 'tossup-no-penalty' &&
    event.questionNumber === questionNumber &&
    event.team === team &&
    event.playerName === playerName;
}

function correctedTossup(
  questionNumber: number,
  team: 'left' | 'right',
  playerName: string,
  answerTypeIndex: number,
) {
  return (events: ScoreEvent[]) =>
    events.some(tossup(questionNumber, team, playerName, answerTypeIndex)) &&
    !events.some(
      (event) =>
        event.type === 'tossup-buzz' &&
        event.questionNumber === questionNumber &&
        (event.team !== team || event.playerName !== playerName || event.answerTypeIndex !== answerTypeIndex),
    );
}

function substitution(questionNumber: number, team: 'left' | 'right', incoming: string, outgoing: string) {
  return (event: ScoreEvent) =>
    event.type === 'substitution' &&
    event.questionNumber === questionNumber &&
    event.team === team &&
    event.activePlayers.includes(incoming) &&
    !event.activePlayers.includes(outgoing);
}

export const practiceSteps: IPracticeStep[] = [
  {
    id: 'lineup',
    title: 'Set the starting lineups',
    call: 'Before the game starts, each team has five players available.',
    instruction:
      'Choose Gibson, Jeremy, Owen and Lachlan for Ninety Six, and Tucker, Sam, Efren and Valerie for Riverton Prep.',
    hint: 'Select exactly four starters for each team, leaving Olivia and Bella on the bench.',
    success: 'Good. The scorer now knows who should receive tossups heard from question 1.',
    section: 'Get ready',
    expectation: { kind: 'lineup' },
  },
  {
    id: 'q1-power',
    title: 'Tossup 1',
    call: 'Reader: “Power, Gibson on Ninety Six.”',
    instruction: 'Record Gibson’s power.',
    hint: 'Choose Gibson on the Ninety Six side, then record the 15-point answer.',
    success: 'Correct — a power is worth 15 in this practice format.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: tossup(1, 'left', 'Gibson', 0) },
  },
  {
    id: 'q1-bonus',
    title: 'Bonus 1',
    call: 'Ninety Six gets 20 points on the bonus.',
    instruction: 'Record 20 bonus points.',
    hint: 'Enter two correct bonus parts and one miss, or use the equivalent total if the scorer offers it.',
    success: 'Right — the bonus adds 20 to Ninety Six.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: bonus(1, 'left', 20) },
  },
  {
    id: 'q2-ten',
    title: 'Tossup 2',
    call: 'Reader: “Tucker, Riverton Prep — correct for 10.”',
    instruction: 'Record Tucker for 10.',
    hint: 'Choose Tucker, then the normal 10-point correct answer.',
    success: 'Exactly.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: tossup(2, 'right', 'Tucker', 1) },
  },
  {
    id: 'q2-bonus',
    title: 'Bonus 2',
    call: 'Riverton Prep gets 10 on the bonus.',
    instruction: 'Record a 10-point bonus.',
    hint: 'One bonus part correct, two missed.',
    success: 'Good.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: bonus(2, 'right', 10) },
  },
  {
    id: 'q3-neg',
    title: 'Tossup 3',
    call: 'Jeremy on Ninety Six interrupts and negs.',
    instruction: 'Record Jeremy’s neg.',
    hint: 'Choose Jeremy and the −5 answer. The tossup should remain live for Riverton Prep.',
    success: 'Correct — Ninety Six loses 5, and Riverton Prep can still answer.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: tossup(3, 'left', 'Jeremy', 2) },
  },
  {
    id: 'q3-rebound',
    title: 'Tossup 3 continues',
    call: 'Tucker answers correctly for Riverton Prep after the neg.',
    instruction: 'Record Tucker for 10 on the same tossup.',
    hint: 'Do not advance the question; score Riverton Prep’s conversion on Tossup 3.',
    success: 'That is the common neg-and-rebound sequence.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: tossup(3, 'right', 'Tucker', 1) },
  },
  {
    id: 'q3-bonus',
    title: 'Bonus 3',
    call: 'Riverton Prep sweeps the bonus for 30.',
    instruction: 'Record all 30 bonus points.',
    hint: 'All three bonus parts are correct.',
    success: 'Correct.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: bonus(3, 'right', 30) },
  },
  {
    id: 'q4-wrong-no-penalty',
    title: 'Tossup 4: wrong, no penalty',
    call: 'Owen answers after the question is finished. The answer is wrong, but there is no penalty.',
    instruction: 'Record Owen’s zero-point wrong answer.',
    hint: 'Use Owen’s “Wrong (0)” action. A no-penalty wrong answer is not a neg and is not the same as no buzz.',
    success: 'Correct — Owen answered, so that attempt belongs on the scoresheet even though it changed no points.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: wrongNoPenalty(4, 'left', 'Owen') },
  },
  {
    id: 'q4-dead',
    title: 'Tossup 4 continues',
    call: 'Riverton Prep does not buzz after Owen’s answer.',
    instruction: 'Record no buzz to close the tossup and move on.',
    hint: 'Use the no-buzz action. Owen’s zero-point attempt stays recorded, and the tossup then closes as dead.',
    success: 'Right — the scoresheet now distinguishes the wrong answer from the team that never buzzed.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: dead(4) },
  },
  {
    id: 'q5-ten',
    title: 'Tossup 5',
    call: 'Gibson answers correctly for 10.',
    instruction: 'Record Gibson for 10.',
    hint: 'This one is a normal correct answer, not a power.',
    success: 'Correct.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: tossup(5, 'left', 'Gibson', 1) },
  },
  {
    id: 'q5-bonus',
    title: 'Bonus 5',
    call: 'Ninety Six gets 20 on the bonus.',
    instruction: 'Record 20.',
    hint: 'Two parts correct, one missed.',
    success: 'Good.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: bonus(5, 'left', 20) },
  },
  {
    id: 'q5-correction',
    title: 'Correct an earlier question',
    call: 'The moderator checks the paper: Lachlan, not Gibson, answered Tossup 5.',
    instruction: 'Open Question 5 from Recent and change the tossup player to Lachlan.',
    hint: 'Select Q5 in the Recent column, choose Lachlan in the question editor, then save the correction.',
    success: 'Fixed. QBSheet recalculated the player stats without changing the team score or later questions.',
    section: 'Fix mistakes',
    expectation: { kind: 'history', matches: correctedTossup(5, 'left', 'Lachlan', 1) },
  },
  {
    id: 'q6-ten',
    title: 'Tossup 6',
    call: 'Reader initially reports Jeremy as correct for 10.',
    instruction: 'Record Jeremy for 10.',
    hint: 'Score the call exactly as you heard it. We will correct it next.',
    success: 'Recorded. Now the moderator corrects the call.',
    section: 'Fix mistakes',
    expectation: { kind: 'event', matches: tossup(6, 'left', 'Jeremy', 1) },
  },
  {
    id: 'q6-undo',
    title: 'Correct a scoring mistake',
    call: 'Correction: Jeremy’s answer was actually a power, not a 10.',
    instruction: 'Use Undo to remove the answer you just recorded.',
    hint: 'Use the scorer’s Undo action. Do not patch the team total by hand.',
    success: 'Good — undo removes the event instead of making you reverse the arithmetic yourself.',
    section: 'Fix mistakes',
    expectation: { kind: 'undo' },
  },
  {
    id: 'q6-power',
    title: 'Tossup 6, corrected',
    call: 'Jeremy’s corrected ruling is a power.',
    instruction: 'Record Jeremy for 15.',
    hint: 'Choose Jeremy and the power answer.',
    success: 'Correct. The history now contains the right ruling.',
    section: 'Fix mistakes',
    expectation: { kind: 'event', matches: tossup(6, 'left', 'Jeremy', 0) },
  },
  {
    id: 'q6-bonus',
    title: 'Bonus 6',
    call: 'Ninety Six gets 10 on the bonus.',
    instruction: 'Record 10.',
    hint: 'One part correct.',
    success: 'Good.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: bonus(6, 'left', 10) },
  },
  {
    id: 'substitution',
    title: 'Substitution before Tossup 7',
    call: 'Ninety Six substitutes Olivia in for Owen.',
    instruction: 'Change the Ninety Six lineup so Olivia is playing and Owen is on the bench.',
    hint: 'Open Players, choose Owen to sub out, then put Olivia in.',
    success: 'Correct — Olivia will receive tossups heard starting with Tossup 7.',
    section: 'Fix mistakes',
    expectation: { kind: 'event', matches: substitution(7, 'left', 'Olivia', 'Owen') },
  },
  {
    id: 'q7-ten',
    title: 'Tossup 7',
    call: 'Olivia answers correctly for 10 immediately after entering.',
    instruction: 'Record Olivia for 10.',
    hint: 'Olivia should now appear as an active Ninety Six player.',
    success: 'Exactly. The substitution and tossups-heard history stay consistent.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: tossup(7, 'left', 'Olivia', 1) },
  },
  {
    id: 'q7-bonus',
    title: 'Bonus 7',
    call: 'Ninety Six gets 30.',
    instruction: 'Record 30.',
    hint: 'All three parts correct.',
    success: 'Good.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: bonus(7, 'left', 30) },
  },
  {
    id: 'q8-ten',
    title: 'Tossup 8',
    call: 'Sam answers correctly for Riverton Prep for 10.',
    instruction: 'Record Sam for 10.',
    hint: 'This is the final regulation tossup.',
    success: 'Correct.',
    section: 'Finish safely',
    expectation: { kind: 'event', matches: tossup(8, 'right', 'Sam', 1) },
  },
  {
    id: 'q8-bonus',
    title: 'Bonus 8',
    call: 'Riverton Prep gets 20 on the final bonus.',
    instruction: 'Record 20.',
    hint: 'Two parts correct.',
    success: 'The practice game is now fully scored.',
    section: 'Finish safely',
    expectation: { kind: 'event', matches: bonus(8, 'right', 20) },
  },
  {
    id: 'submit',
    title: 'Finish the game',
    call: 'The round is over and the scoresheet is complete.',
    instruction: 'Finish/submit the game the same way you would in a real room.',
    hint: 'Use the scorer’s finish or submit action. Practice mode will not upload or save a result anywhere.',
    success: 'Practice complete.',
    section: 'Finish safely',
    expectation: { kind: 'submit' },
  },
];

export function practiceLineupReady(setup: IGameSetup): boolean {
  const left = setup.left.startingLineup ?? [];
  const right = setup.right.startingLineup ?? [];
  const same = (actual: string[], expected: string[]) =>
    actual.length === expected.length && expected.every((player) => actual.includes(player));
  return same(left, practiceLeftTeam.startingLineup) && same(right, practiceRightTeam.startingLineup);
}
