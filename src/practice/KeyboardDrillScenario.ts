/**
 * The keyboard drill: the shortcuts on their own, in an order a game cannot produce.
 *
 * # Why this is not a second guided game
 *
 * `PracticeScenario` teaches the scoresheet, and it already annotates each of its steps with the
 * keystroke that would record it. That is the right thing for somebody learning to score and the wrong
 * thing for somebody learning the keys, for one reason: a guided game has to be a plausible game. It can
 * only ask for the keys its plot happens to need, it cannot ask for the same key twice, and every key it
 * does ask for arrives interleaved with everything else there is to learn about a scoresheet. Eight
 * tossups reach four of the eight seats and never once ask for redo.
 *
 * A drill has no game to be plausible about. It can walk the layout in the order the layout is built in —
 * the seats, then the rulings, then the keys that are not rulings — and it can say what each key is *not*,
 * which is where the mistakes actually are. N and 0 and Space all score nothing and are three different
 * facts about a tossup.
 *
 * # Nothing here is written down twice
 *
 * The seats come from the practice lineups, the rulings and their values from the live format through the
 * same resolution the listener uses, and the bonus digits from the totals that format can produce. A task
 * that hard-coded `1 then P` would be a second copy of the layout, and the copy is what goes stale. Every
 * key a task names is derived from the tables `useScorerKeyboard` reads.
 *
 * # And nothing here scores anything
 *
 * The drill is not the scorer. It listens for keystrokes and says whether they were the ones asked for;
 * there is no game underneath it, nothing is written to storage, and a wrong key costs nothing. That is
 * the difference between practising a key and practising a scoresheet, and it is why the drill can afford
 * to ask for undo twice in a row.
 */
import { LeftOrRight } from '../scoring/types';
import { regularBonusTotals } from '../scorer/bonusOptions';
import {
  actionForKey,
  bonusKeyLegend,
  KeyboardAction,
  keyboardActionLabels,
  keyboardActionNames,
  keyboardSeatNumbers,
  keyboardShortcutLabels,
  numberForCode,
  rulingForAction,
} from '../scorer/KeyboardScoring';
import { IScorekeeperAnswerType } from '../scoring/ScorekeeperFormat';
import { practiceFormat, practiceLeftTeam, practiceRightTeam } from './PracticeScenario';

export type DrillSection = 'Find the seat' | 'Record the ruling' | 'Close the tossup' | 'Fix a mistake';

export interface IDrillTask {
  id: string;
  section: DrillSection;
  /** The call, in the words a scorekeeper would hear it in. */
  call: string;
  /** What to press, said in words as well as in keys. */
  ask: string;
  /**
   * The keystrokes, in order, labelled exactly as the scoresheet's own legend labels them.
   *
   * Labels rather than matchers, so a task stays a piece of data that can be read in a test and printed
   * on screen — and so the string a person is asked for is the same string the drill checks against.
   */
  keys: string[];
  /** What the key means, and — where it matters — what the neighbouring key would have meant instead. */
  why: string;
  /** What the keys of this task address, said again when the wrong one arrives. */
  correction: string;
  success: string;
}

/**
 * What the scoresheet's keyboard layer would call this keystroke, or null if it would ignore it.
 *
 * Read through the same helpers the live listener uses, in the same order — the undo chord first, then
 * the plain keys — so a key the sheet would swallow is a key the drill also ignores rather than marks
 * wrong. A scorekeeper reaching for Tab or F5 during the drill has not made a mistake.
 */
export function readKeystrokeLabel(event: KeyboardEvent): string | null {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    return event.shiftKey ? keyboardShortcutLabels.redo : keyboardShortcutLabels.undo;
  }
  // Modifier chords are not part of the layout. Leave the browser's and the OS's own shortcuts alone.
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (event.key === ' ') return keyboardShortcutLabels.noBuzz;
  // Numbers are seats before they are anything else, which is the precedence the listener has too.
  const seat = numberForCode(event.code);
  if (seat !== null) return String(seat);
  const action = actionForKey(event.key);
  return action === null ? null : keyboardActionLabels[action];
}

const sides: Record<LeftOrRight, typeof practiceLeftTeam> = {
  left: practiceLeftTeam,
  right: practiceRightTeam,
};

const ordinals = ['first', 'second', 'third', 'fourth'];

/**
 * What a ruling is worth, for a sentence that is teaching what a key does.
 *
 * Deliberately not `rulingLabel`, which prefers the short label a format chose for its buttons — and this
 * format's short label for its power is the letter P, which would leave the drill saying "P is the power,
 * P here". The value is the thing being taught, so the value is what this reads out. The sign is written
 * to be read rather than parsed, exactly as the legend writes it.
 */
function pointsLabel(answerType: IScorekeeperAnswerType): string {
  return answerType.value > 0 ? `+${answerType.value}` : `−${Math.abs(answerType.value)}`;
}

/** Who sits in a seat during the practice game, and which key addresses them. */
function seatOf(side: LeftOrRight, seat: number) {
  return {
    player: sides[side].startingLineup[seat],
    team: sides[side].name,
    key: String(keyboardSeatNumbers[side][seat]),
  };
}

/** The two ends of the number row, said once so three tasks can quote the same fact. */
const seatSpan = `${keyboardSeatNumbers.left[0]} to ${keyboardSeatNumbers.left[keyboardSeatNumbers.left.length - 1]} for ${practiceLeftTeam.name} and ${keyboardSeatNumbers.right[0]} to ${keyboardSeatNumbers.right[keyboardSeatNumbers.right.length - 1]} for ${practiceRightTeam.name}`;

function seatTask(side: LeftOrRight, seat: number, why: string): IDrillTask {
  const { player, team, key } = seatOf(side, seat);
  return {
    id: `seat-${side}-${seat}`,
    section: 'Find the seat',
    call: `${player} is in ${team}’s ${ordinals[seat]} seat.`,
    ask: `Press the key for ${player}’s seat.`,
    keys: [key],
    why,
    correction: `The seats are ${seatSpan}.`,
    success: `${key} is ${player}.`,
  };
}

/**
 * A two-key ruling task, or null when this format has no such ruling.
 *
 * Resolved through `rulingForAction`, which is the function the keystroke itself goes through. A format
 * with no power gets no P task rather than a task that teaches a dead key — the same promise the legend
 * makes when it strikes a row through.
 */
function rulingTask(input: {
  id: string;
  side: LeftOrRight;
  seat: number;
  action: Exclude<KeyboardAction, 'wrong'>;
  call: string;
  why: (points: string) => string;
}): IDrillTask | null {
  const ruling = rulingForAction(practiceFormat, input.action, true);
  if (ruling === null) return null;
  const { player, team, key } = seatOf(input.side, input.seat);
  const actionKey = keyboardActionLabels[input.action];
  const points = pointsLabel(ruling.answerType);
  return {
    id: input.id,
    section: 'Record the ruling',
    call: input.call,
    ask: `Press ${key}, then ${actionKey}, for ${player}.`,
    keys: [key, actionKey],
    why: input.why(points),
    correction: `A ruling is the seat and then the ruling key: ${Object.values(keyboardActionLabels).join(', ')}.`,
    success: `${keyboardActionNames[input.action]} ${points} for ${player}, ${team}.`,
  };
}

function wrongAnswerTask(): IDrillTask {
  const { player, key } = seatOf('left', 2);
  const actionKey = keyboardActionLabels.wrong;
  return {
    id: 'ruling-wrong',
    section: 'Record the ruling',
    call: `${player} answers after the question has been read out, and is wrong. The rules assess no penalty.`,
    ask: `Press ${key}, then ${actionKey}, for ${player}.`,
    keys: [key, actionKey],
    why: `${actionKey} is an answer that was simply wrong. Three keys score nothing and they are three different facts: ${keyboardActionLabels.neg} is a neg and costs points, ${actionKey} is a wrong answer that costs none, and ${keyboardShortcutLabels.noBuzz} is nobody answering at all. Every format can record a used chance, so ${actionKey} is the one ruling key that is never unavailable.`,
    correction: `A ruling is the seat and then the ruling key: ${Object.values(keyboardActionLabels).join(', ')}.`,
    success: `Wrong with no penalty. The attempt is on the scoresheet and ${player}’s team has used its answer.`,
  };
}

function noBuzzTask(): IDrillTask {
  const key = keyboardShortcutLabels.noBuzz;
  return {
    id: 'no-buzz',
    section: 'Close the tossup',
    call: 'The question is read out to the end and neither team buzzes.',
    ask: `Press ${key}.`,
    keys: [key],
    why: `${key} closes a tossup nobody converted, so there is no bonus. It is the one shortcut that works whether or not keyboard scoring is switched on — and on the scoresheet it is left alone while a button has focus, because there ${key} means "press this button".`,
    correction: `${key} is the whole shortcut. There is no seat to choose: the point of it is that nobody answered.`,
    success: 'The tossup is closed with nobody converting it.',
  };
}

/**
 * The bonus digits, or null for a format whose bonuses are irregular.
 *
 * An irregular bonus is a typed number rather than a row of buttons, and there is no digit mapping to
 * learn — so there is nothing to drill and the task is left out.
 */
function bonusTask(): IDrillTask | null {
  const totals = regularBonusTotals(practiceFormat.bonus);
  if (totals === null || totals.length < 2) return null;
  // The legend the prompt itself draws, so the drill teaches the digits the prompt is bound to.
  const legend = bonusKeyLegend(totals);
  // A middling total rather than the top one, so the digit has to be counted rather than guessed at.
  const row = legend[legend.length - 2];
  const mapping = legend.map((entry) => `${entry.keys} is ${entry.meaning}`).join(', ');
  return {
    id: 'bonus-total',
    section: 'Close the tossup',
    call: `${practiceLeftTeam.name} converts the tossup and gets two of the three bonus parts, for ${row.meaning}.`,
    ask: `Press ${row.keys}.`,
    keys: [row.keys],
    why: `A converted tossup opens the bonus on its own, and while it is open the digits address what is on screen rather than seats: ${mapping}. The digit is the number of parts, which is what you have just heard — and it is why ${legend[0].keys}, not ${legend[1].keys}, is the bonus that scored nothing. The row is the totals this format can produce, so a bonus scored in fives renumbers its own digits. There is deliberately no cancel key on this first prompt: a bonus that belongs to the wrong team is fixed by undoing the tossup. A format whose bonuses bounce back asks part by part instead, and its digits say who scored the part rather than how many were got — the map on the scoresheet always names them.`,
    correction: `During a bonus the digits are the totals on screen: ${mapping}.`,
    success: `${row.meaning} to ${practiceLeftTeam.name}, and the scoresheet moves on to the next tossup.`,
  };
}

function undoTask(): IDrillTask {
  return {
    id: 'undo',
    section: 'Fix a mistake',
    call: 'The ruling you have just recorded is called back by the moderator.',
    ask: `Press ${keyboardShortcutLabels.undo}.`,
    keys: [keyboardShortcutLabels.undo],
    why: 'Undo removes the event. It never asks you to reverse the arithmetic yourself — the score is worked out from the rulings, so a hand-patched total is how the player stats come to disagree with the team score. Undo is for what you have just done; an older mistake belongs in the question editor, which is mouse work.',
    correction: 'Hold Ctrl, or ⌘ on a Mac, and press Z.',
    success: 'The last action is off the scoresheet.',
  };
}

function redoTask(): IDrillTask {
  return {
    id: 'redo',
    section: 'Fix a mistake',
    call: 'That undo went one step too far.',
    ask: `Press ${keyboardShortcutLabels.redo}.`,
    keys: [keyboardShortcutLabels.redo],
    why: 'Shift turns undo into redo, and it stays available until you record something different. Neither one reaches the scoresheet while a dialog is open, so a keystroke aimed at a dialog cannot walk back through the game behind it.',
    correction: 'Same chord as undo, with Shift held.',
    success: 'Back where you were.',
  };
}

/**
 * The drill, in the order the layout is built in.
 *
 * Three seats rather than all eight: the thing to learn is that the numbers run straight across the room
 * instead of restarting per team, and the fourth and seventh seats prove that between them. Eight tasks
 * of pressing a single number would be a typing test.
 */
export const drillTasks: IDrillTask[] = [
  seatTask(
    'left',
    0,
    `${practiceLeftTeam.name} is the left-hand team, so its seats are the first four keys, in the order the rows are drawn. Nothing lands yet: a seat on its own is half a sequence, and the scoresheet waits a couple of seconds for the ruling before forgetting it.`,
  ),
  seatTask(
    'left',
    3,
    'The key is the row, not the person. When somebody is substituted the key stays where it is and whoever comes on answers to it — which is why a substitution never asks you to relearn the number row mid-game.',
  ),
  seatTask(
    'right',
    2,
    `The right-hand team does not start again at 1. The seats run straight across the room — ${seatSpan} — so no key ever means two people, and there is no side to select before the seat.`,
  ),
  rulingTask({
    id: 'ruling-correct',
    side: 'right',
    seat: 0,
    action: 'correct',
    call: `Reader: “${seatOf('right', 0).player}, ${practiceRightTeam.name} — correct.”`,
    why: (points) =>
      `The seat first, then the ruling. ${keyboardActionLabels.correct} is the ordinary correct answer, ${points} here. What it is worth comes from the format rather than from this drill, so the same key is right at a tournament whose tossups are worth 20.`,
  }),
  rulingTask({
    id: 'ruling-power',
    side: 'left',
    seat: 0,
    action: 'power',
    call: `${seatOf('left', 0).player} buzzes early and is correct.`,
    why: (points) =>
      `${keyboardActionLabels.power} is the power, ${points} here. ${keyboardActionLabels.correct} would have recorded the ordinary correct answer instead and quietly cost the room the difference, which makes this the one pair worth having in the fingers before you rely on the keys in a round.`,
  }),
  rulingTask({
    id: 'ruling-neg',
    side: 'left',
    seat: 1,
    action: 'neg',
    call: `${seatOf('left', 1).player} interrupts the question and is wrong.`,
    why: (points) =>
      `${keyboardActionLabels.neg} is the penalty, ${points} here. It only lands while a neg is legal: once a team has heard the whole question, ${keyboardActionLabels.neg} does nothing at all rather than recording a penalty the rules do not allow.`,
  }),
  wrongAnswerTask(),
  noBuzzTask(),
  bonusTask(),
  undoTask(),
  redoTask(),
].filter((task): task is IDrillTask => task !== null);
