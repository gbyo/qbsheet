import { IScorekeeperFormat, scorekeeperFormatVersion } from '../scoring/ScorekeeperFormat';
import { bonusEventPoints, ScoreEvent } from '../scoring/ScoreEvents';
import { IGameSetup } from '../scoring/deriveGame';
import { ITeamRoster } from '../game/Roster';
import { LeftOrRight } from '../scoring/types';
import { regularBonusTotals } from '../scorer/bonusOptions';
import {
  bonusKeyLegend,
  KeyboardAction,
  keyboardActionLabels,
  keyboardSeatNumbers,
  keyboardShortcutLabels,
} from '../scorer/KeyboardScoring';

export type PracticeExpectation =
  | { kind: 'lineup' }
  | { kind: 'event'; matches: (event: ScoreEvent) => boolean }
  | { kind: 'history'; matches: (events: ScoreEvent[]) => boolean; supersedes?: string[] }
  | { kind: 'undo' }
  | { kind: 'submit' };

export interface IPracticeStep {
  id: string;
  title: string;
  /** What the room does, in the words a scorekeeper would actually hear. */
  call: string;
  /**
   * What to record, stated plainly.
   *
   * Shown to the scorekeeper, not hidden behind the hint. A guided game whose steps have to be
   * guessed at teaches guessing; the thing being practised is the scoresheet, not the riddle.
   */
  instruction: string;
  /**
   * Where the control is and why the ruling is what it is.
   *
   * The instruction says what to record. This says which button does it, names the part of the
   * screen it is on, and — where a step exists to teach a distinction — says what the neighbouring
   * control would have meant instead.
   */
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
  name: 'Greenwood',
  players: ['Tucker', 'Phillip', 'Efren', 'Valerie', 'Bella'].map((name) => ({ name })),
  startingLineup: ['Tucker', 'Phillip', 'Efren', 'Valerie'],
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

/**
 * The one substitution in the scenario, named once.
 *
 * Two things have to agree about it: the step that waits for the event, and the seat the Tossup 7
 * keystroke hint has to name. A substitute takes the seat of the player they replaced, so Olivia's key
 * is Owen's key — which `practiceSeatNumber` works out from this rather than being told separately.
 */
export const practiceSubstitution = { side: 'left', incoming: 'Olivia', outgoing: 'Owen' } as const;

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
      'Start Gibson, Jeremy, Owen and Lachlan for Ninety Six, and Tucker, Phillip, Efren and Valerie for Greenwood — in that order — then choose Start game.',
    hint:
      'Only four of each five may start, so leave Olivia and Bella on the Bench. Each Start action adds the player to the next available seat, and the ↑/↓ controls change that order without starting again. Start game stays disabled until both teams have four starters.',
    success: 'Good. The scorer now knows who should receive tossups heard from question 1.',
    section: 'Get ready',
    expectation: { kind: 'lineup' },
  },
  {
    id: 'q1-power',
    title: 'Tossup 1',
    call: 'Reader: “Power, Gibson on Ninety Six.”',
    instruction: 'Press 1, then P, for Gibson on the Ninety Six side.',
    hint:
      'Keyboard scoring uses the player’s seat number first, then the ruling: C is ordinary correct, P is power, N is neg, and 0 is wrong with no penalty. Gibson is seat 1, and a power is 15 in this practice format.',
    success: 'Correct — a power is worth 15 in this practice format.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: tossup(1, 'left', 'Gibson', 0) },
  },
  {
    id: 'q1-bonus',
    title: 'Bonus 1',
    call: 'Ninety Six gets 20 points on the bonus.',
    instruction: 'Press 20 in the bonus prompt that has just appeared.',
    hint:
      'A converted tossup opens the bonus on its own — there is no Tossup/Bonus switch to set. The totals shown are the ones this format can produce; Parts… is there when you would rather record each part.',
    success: 'Right — the bonus adds 20 to Ninety Six.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: bonus(1, 'left', 20) },
  },
  {
    id: 'q2-ten',
    title: 'Tossup 2',
    call: 'Reader: “Tucker, Greenwood — correct for 10.”',
    instruction: 'Press 5, then C, for Tucker on the Greenwood side.',
    hint: 'C is the ordinary correct answer, as opposed to P for a power. Greenwood is the right-hand team, so its first seat is 5.',
    success: 'Exactly.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: tossup(2, 'right', 'Tucker', 1) },
  },
  {
    id: 'q2-bonus',
    title: 'Bonus 2',
    call: 'Greenwood gets 10 on the bonus.',
    instruction: 'Press 10 in the bonus prompt.',
    hint: 'One part correct out of three. The prompt names the team the bonus belongs to, so there is nothing to choose.',
    success: 'Good.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: bonus(2, 'right', 10) },
  },
  {
    id: 'q3-neg',
    title: 'Tossup 3',
    call: 'Jeremy on Ninety Six interrupts and negs.',
    instruction: 'Press 2, then N, for Jeremy’s row.',
    hint:
      'N is the neg, worth −5 here. Watch what happens afterwards: Ninety Six’s buttons go quiet because they have had their answer, and Greenwood’s stay live because the tossup is not over.',
    success: 'Correct — Ninety Six loses 5, and Greenwood can still answer.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: tossup(3, 'left', 'Jeremy', 2) },
  },
  {
    id: 'q3-rebound',
    title: 'Tossup 3 continues',
    call:
      'Still on Tossup 3. The question is read out to the end, and Tucker answers it correctly for Greenwood.',
    instruction: 'Press 5, then C, for Tucker. Stay on Tossup 3 — do not use No buzz and do not advance the question.',
    hint:
      'Nothing needs advancing: the header still says Tossup 3 and it stays there until the tossup is settled. Ninety Six’s rulings are greyed out because they have used their answer, and Greenwood no longer shows N — a team that has heard the whole question cannot be negged. No buzz would mean Greenwood never answered, which is not what happened.',
    success: 'That is the common neg-and-rebound sequence.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: tossup(3, 'right', 'Tucker', 1) },
  },
  {
    id: 'q3-bonus',
    title: 'Bonus 3',
    call: 'Greenwood sweeps the bonus for 30.',
    instruction: 'Press 30 in the bonus prompt.',
    hint: 'All three parts correct. The bonus belongs to Greenwood because they converted the tossup, not because they negged nothing.',
    success: 'Correct.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: bonus(3, 'right', 30) },
  },
  {
    id: 'q4-wrong-no-penalty',
    title: 'Tossup 4: wrong, no penalty',
    call: 'Owen answers after the question is finished. The answer is wrong, but there is no penalty.',
    instruction: 'Press 3, then 0, for Owen’s row.',
    hint:
      'Three different things that all score nothing, and they are not interchangeable: N is a neg and costs 5, 0 is an answer that was simply wrong, and No buzz means nobody answered at all. Owen answered, so it is 0.',
    success: 'Correct — Owen answered, so that attempt belongs on the scoresheet even though it changed no points.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: wrongNoPenalty(4, 'left', 'Owen') },
  },
  {
    id: 'q4-dead',
    title: 'Tossup 4 continues',
    call: 'Greenwood does not buzz after Owen’s answer.',
    instruction: 'Press the No buzz button below the two teams.',
    hint:
      'It now reads “Greenwood has no answer”, because they are the only team left who could have buzzed. Owen’s 0 stays on the scoresheet; this only closes the tossup with nobody converting it, so there is no bonus.',
    success: 'Right — the scoresheet now distinguishes the wrong answer from the team that never buzzed.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: dead(4) },
  },
  {
    id: 'q5-ten',
    title: 'Tossup 5',
    call: 'Gibson answers correctly for 10.',
    instruction: 'Press 1, then C, for Gibson’s row.',
    hint: 'C, not P. The reader said correct, not power.',
    success: 'Correct.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: tossup(5, 'left', 'Gibson', 1) },
  },
  {
    id: 'q5-bonus',
    title: 'Bonus 5',
    call: 'Ninety Six gets 20 on the bonus.',
    instruction: 'Press 20 in the bonus prompt.',
    hint: 'Two parts correct, one missed.',
    success: 'Good.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: bonus(5, 'left', 20) },
  },
  {
    id: 'q5-correction',
    title: 'Correct an earlier question',
    call: 'The moderator checks the paper: Lachlan, not Gibson, answered Tossup 5.',
    instruction:
      'Select Q5 in the Recent column on the right, change Player to Lachlan, then choose Save correction.',
    hint:
      'The Recent column lists what you have scored; selecting a question opens the whole of it — every buzz on it and its bonus — in one editor. Change the Player dropdown from Gibson to Lachlan and leave the ruling alone. Nothing is written until Save correction, and Close or Close without saving leaves the question exactly as it was.',
    success: 'Fixed. QBSheet recalculated the player stats without changing the team score or later questions.',
    section: 'Fix mistakes',
    expectation: {
      kind: 'history',
      matches: correctedTossup(5, 'left', 'Lachlan', 1),
      supersedes: ['q5-ten'],
    },
  },
  {
    id: 'q6-ten',
    title: 'Tossup 6',
    call: 'Reader initially reports Jeremy as correct for 10.',
    instruction: 'Press 2, then C, for Jeremy’s row.',
    hint: 'Score the call exactly as you heard it, even though you are about to be told it was wrong. That is the point of the next two steps.',
    success: 'Recorded. Now the moderator corrects the call.',
    section: 'Fix mistakes',
    expectation: { kind: 'event', matches: tossup(6, 'left', 'Jeremy', 1) },
  },
  {
    id: 'q6-undo',
    title: 'Correct a scoring mistake',
    call: 'Correction: Jeremy’s answer was actually a power, not a 10.',
    instruction: 'Press Undo in the bottom-left toolbar (Ctrl+Z or ⌘Z also works).',
    hint:
      'Undo is for the thing you have just done; the question editor is for an older mistake. Never fix a wrong ruling by adjusting the team total — the score is worked out from the rulings, so a hand-patched total makes the player stats disagree with it.',
    success: 'Good — undo removes the event instead of making you reverse the arithmetic yourself.',
    section: 'Fix mistakes',
    expectation: { kind: 'undo' },
  },
  {
    id: 'q6-power',
    title: 'Tossup 6, corrected',
    call: 'Jeremy’s corrected ruling is a power.',
    instruction: 'Press 2, then P, for Jeremy’s row.',
    hint: 'P is the power, worth 15 in this format.',
    success: 'Correct. The history now contains the right ruling.',
    section: 'Fix mistakes',
    expectation: { kind: 'event', matches: tossup(6, 'left', 'Jeremy', 0) },
  },
  {
    id: 'q6-bonus',
    title: 'Bonus 6',
    call: 'Ninety Six gets 10 on the bonus.',
    instruction: 'Press 10 in the bonus prompt.',
    hint: 'One part correct.',
    success: 'Good.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: bonus(6, 'left', 10) },
  },
  {
    id: 'substitution',
    title: 'Substitution before Tossup 7',
    call: 'Ninety Six substitutes Olivia in for Owen.',
    instruction: 'Press ⇄ on Owen’s row, then choose Olivia.',
    hint:
      'Every player on the floor has a ⇄ button beside their rulings: it already knows who is coming off, so it only asks who comes on. Players in the bottom toolbar does the same thing and more — adding somebody to the roster, reordering the seats, or changing several players at once at halftime.',
    success: 'Correct — Olivia will receive tossups heard starting with Tossup 7.',
    section: 'Fix mistakes',
    expectation: {
      kind: 'event',
      matches: substitution(
        7,
        practiceSubstitution.side,
        practiceSubstitution.incoming,
        practiceSubstitution.outgoing,
      ),
    },
  },
  {
    id: 'q7-ten',
    title: 'Tossup 7',
    call: 'Olivia answers correctly for 10 immediately after entering.',
    instruction: 'Press 3, then C, on Olivia’s row.',
    hint: 'Olivia has taken Owen’s seat, so she is in the row Owen was in. Owen keeps the six tossups he actually heard.',
    success: 'Exactly. The substitution and tossups-heard history stay consistent.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: tossup(7, 'left', 'Olivia', 1) },
  },
  {
    id: 'q7-bonus',
    title: 'Bonus 7',
    call: 'Ninety Six gets 30.',
    instruction: 'Press 30 in the bonus prompt.',
    hint: 'All three parts correct.',
    success: 'Good.',
    section: 'Score the game',
    expectation: { kind: 'event', matches: bonus(7, 'left', 30) },
  },
  {
    id: 'q8-ten',
    title: 'Tossup 8',
    call: 'Phillip answers correctly for Greenwood for 10.',
    instruction: 'Press 6, then C, for Phillip on the Greenwood side.',
    hint: 'This is the last of the eight tossups in this practice format.',
    success: 'Correct.',
    section: 'Finish safely',
    expectation: { kind: 'event', matches: tossup(8, 'right', 'Phillip', 1) },
  },
  {
    id: 'q8-bonus',
    title: 'Bonus 8',
    call: 'Greenwood gets 20 on the final bonus.',
    instruction: 'Press 20 in the bonus prompt.',
    hint: 'Two parts correct. Once this is in, the game is over and the finish review replaces the tossup controls.',
    success: 'The practice game is now fully scored.',
    section: 'Finish safely',
    expectation: { kind: 'event', matches: bonus(8, 'right', 20) },
  },
  {
    id: 'submit',
    title: 'Finish the game',
    call: 'The round is over and the scoresheet is complete.',
    instruction: 'Read the finish review, then press the submit button at the bottom of it.',
    hint:
      'The review lists anything worth a second look before a result leaves the room, and refuses to send while a real blocker is outstanding. Nothing is uploaded or saved here — this is practice.',
    success: 'Practice complete.',
    section: 'Finish safely',
    expectation: { kind: 'submit' },
  },
];

export function practiceLineupMatches(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((player, index) => actual[index] === player);
}

export function practiceLineupReady(setup: IGameSetup): boolean {
  const left = setup.left.startingLineup ?? [];
  const right = setup.right.startingLineup ?? [];
  return (
    practiceLineupMatches(left, practiceLeftTeam.startingLineup) &&
    practiceLineupMatches(right, practiceRightTeam.startingLineup)
  );
}

/**
 * The keystroke that records a step, for a scorekeeper practising with the keyboard layer on.
 *
 * What is written down here is *what a step records* — a seat and a ruling, or a bonus total — and never
 * the key that records it. The key is worked out from the practice lineups and from the totals the
 * practice format can produce, so a hint cannot drift from what the keys actually do: moving a name in
 * `practiceLeftTeam.startingLineup` moves its key, and a bonus scored in fives renumbers its own digits.
 *
 * The four steps that are deliberately mouse work — the starting lineups, the question correction, the
 * substitution, and the finish review — are absent, and absent means no hint rather than a wrong one.
 */
const stepKeystrokes: Record<
  string,
  { side: LeftOrRight; player: string; action: KeyboardAction } | { bonus: number } | { literal: string }
> = {
  'q1-power': { side: 'left', player: 'Gibson', action: 'power' },
  'q1-bonus': { bonus: 20 },
  'q2-ten': { side: 'right', player: 'Tucker', action: 'correct' },
  'q2-bonus': { bonus: 10 },
  'q3-neg': { side: 'left', player: 'Jeremy', action: 'neg' },
  'q3-rebound': { side: 'right', player: 'Tucker', action: 'correct' },
  'q3-bonus': { bonus: 30 },
  'q4-wrong-no-penalty': { side: 'left', player: 'Owen', action: 'wrong' },
  'q4-dead': { literal: keyboardShortcutLabels.noBuzz },
  'q5-ten': { side: 'left', player: 'Gibson', action: 'correct' },
  'q5-bonus': { bonus: 20 },
  'q6-ten': { side: 'left', player: 'Jeremy', action: 'correct' },
  'q6-undo': { literal: keyboardShortcutLabels.undo },
  'q6-power': { side: 'left', player: 'Jeremy', action: 'power' },
  'q6-bonus': { bonus: 10 },
  'q7-ten': { side: 'left', player: 'Olivia', action: 'correct' },
  'q7-bonus': { bonus: 30 },
  'q8-ten': { side: 'right', player: 'Phillip', action: 'correct' },
  'q8-bonus': { bonus: 20 },
};

/**
 * Which global key number sits under a player during the practice game.
 *
 * The starting lineups decide it, plus the one scripted substitution: a substitute takes the seat of the
 * player they replaced, so Olivia answers to Owen's key from Tossup 7 on. Null for anybody this layout
 * cannot address — a fifth player who never comes on, or a seat beyond the four the keys reach.
 */
export function practiceSeatNumber(side: LeftOrRight, playerName: string): number | null {
  const lineup = side === 'left' ? practiceLeftTeam.startingLineup : practiceRightTeam.startingLineup;
  const seated =
    side === practiceSubstitution.side && playerName === practiceSubstitution.incoming
      ? practiceSubstitution.outgoing
      : playerName;
  const seat = lineup.indexOf(seated);
  return seat >= 0 && seat < keyboardSeatNumbers[side].length ? keyboardSeatNumbers[side][seat] : null;
}

/**
 * Which digit selects a bonus total in the practice format's prompt.
 *
 * Read out of `bonusKeyLegend`, which is the legend the prompt itself draws and the table
 * `bonusOptionForCode` is the other half of. Asking it rather than recounting the row is what keeps this
 * hint right through a change to how the digits are numbered. Null for a total this format cannot be
 * worth, and for a total past the last digit — beyond that the buttons are the only way.
 */
export function practiceBonusKey(points: number): string | null {
  const totals = regularBonusTotals(practiceFormat.bonus);
  if (totals === null) return null;
  return bonusKeyLegend(totals).find((row) => row.meaning === String(points))?.keys ?? null;
}

export function practiceKeystroke(stepId: string): string | null {
  const entry = stepKeystrokes[stepId];
  if (!entry) return null;
  if ('literal' in entry) return entry.literal;
  if ('bonus' in entry) return practiceBonusKey(entry.bonus);
  const number = practiceSeatNumber(entry.side, entry.player);
  if (number === null) return null;
  return `${number} then ${keyboardActionLabels[entry.action]}`;
}
