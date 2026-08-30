/**
 * Taking back an overtime that a correction has just made unnecessary.
 *
 * # How a room ends up here
 *
 * Regulation finishes level, the room plays overtime, and afterwards a protest is upheld: question 6
 * changes hands, and regulation was not tied after all. Everything the room did was right at the
 * time. What is wrong now is the scoresheet, which contains three tossups that the rules say were
 * never played — and which, on a paper scoresheet, somebody would strike through.
 *
 * The engine notices this on its own (`IDerivedGame.overtimeUnnecessary`) and says so as a warning,
 * because whether those tossups count is a ruling rather than an arithmetic fact: a director may
 * well decide the round stands as played, and `procedure-exception` is how that decision is
 * recorded. This is the other answer, for when the ruling is that they do not count.
 *
 * # What it removes, and what it deliberately does not
 *
 * The cycles played past the regulation boundary, and the two checkpoint events that opened the
 * period. Nothing else. Notes and protests recorded during overtime stay exactly where they are —
 * they describe things that happened in the room, and a room that struck out three tossups did not
 * thereby un-say what it wrote in the margin.
 *
 * Nothing is deleted quietly: the caller validates the result against `validateCorrectedHistory` and
 * writes a note beside it, so the removal is on the result rather than in somebody's memory.
 */
import { IDerivedGame } from './deriveGame';
import { ScoreEvent } from './ScoreEvents';
import { correctionNote } from './gameCorrection';

/** Events that belong to a tossup cycle rather than to the game as a whole. */
function isCycleEvent(event: ScoreEvent): boolean {
  return (
    event.type === 'tossup-buzz' ||
    event.type === 'tossup-no-penalty' ||
    event.type === 'tossup-reading-resumed' ||
    event.type === 'tossup-readout' ||
    event.type === 'tossup-dead' ||
    event.type === 'bonus' ||
    event.type === 'question-void'
  );
}

/** The tossups this game played in overtime, in order. Empty when it played none. */
export function overtimeQuestionNumbers(game: IDerivedGame): number[] {
  return game.questions
    .filter((question) => question.period === 'overtime')
    .map((question) => question.questionNumber);
}

/**
 * The history with the overtime span struck out.
 *
 * Pure, and returns the input array unchanged when there is no overtime to remove, so a caller can
 * compare identities to decide whether anything would happen.
 */
export default function removeOvertime(events: readonly ScoreEvent[], game: IDerivedGame): ScoreEvent[] {
  const removed = new Set(overtimeQuestionNumbers(game));
  if (removed.size === 0 && !game.overtimeStarted) return events.slice();
  return events.filter((event) => {
    if (event.type === 'begin-overtime' || event.type === 'begin-sudden-death') return false;
    return !(removed.has(event.questionNumber) && isCycleEvent(event));
  });
}

/** What the audit note says, so the removal is legible on the result rather than merely absent. */
export function overtimeRemovalNote(questionNumbers: readonly number[]): string {
  if (questionNumbers.length === 0) return correctionNote('Overtime removed: regulation was not tied');
  const list = questionNumbers.map((number) => `Q${number}`).join(', ');
  return correctionNote(
    `Overtime removed (${list}): a correction left regulation untied, so those tossups do not count`,
  );
}
