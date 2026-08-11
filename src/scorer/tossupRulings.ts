/**
 * Which rulings a tossup actually offers, and which of them a fixed keyboard layout can name.
 *
 * # Why this is its own file
 *
 * `TeamPanel` worked out the available rulings inline, which was fine for as long as buttons were the
 * only way to record one. A keyboard layer that re-derived the same thing would be a second copy of a
 * rule that decides whether a neg is legal — and the two copies would disagree the first time either
 * changed. So the derivation moved here and both callers read it: the buttons draw what this returns,
 * and the keyboard binds to what this returns. A ruling the keyboard can reach that the buttons cannot
 * is impossible by construction rather than by review.
 *
 * # Nothing here knows what a quiz bowl format looks like
 *
 * No +15, no +10, no −5. A format is a list of answer types with values, and the "normal" tossup is
 * whichever positive one is worth least — that is what a base tossup *is*, in any format. The power is
 * the most valuable positive one, and only exists when there is more than one to choose between.
 *
 * That derivation deliberately does not use `isPower`, which the format documents as being exactly
 * `value > 10`. A tournament whose base tossup is worth 20 has `isPower` set on the only answer it
 * has, and binding Shift to it while leaving the unmodified key with nothing would be a keyboard
 * layout built out of a quirk in a derived flag.
 */
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../scoring/ScorekeeperFormat';

/**
 * The rulings a team may be given on this tossup, in the order the format lists them.
 *
 * Negs disappear once anybody has answered: a team answering second has heard the whole question and
 * cannot be penalized for missing it. This is the rule `TeamPanel` used to hold on its own.
 */
export function availableAnswerTypes(
  format: IScorekeeperFormat,
  negsAvailable: boolean,
): IScorekeeperAnswerType[] {
  return negsAvailable ? format.answerTypes : format.answerTypes.filter((type) => !type.isNeg);
}

/** Every answer worth something, cheapest first. */
function correctTypes(format: IScorekeeperFormat): IScorekeeperAnswerType[] {
  return format.answerTypes.filter((type) => type.value > 0).sort((first, second) => first.value - second.value);
}

/**
 * The base tossup: the least valuable correct answer.
 *
 * Null only for a format with no positive answer at all, which is not a format anybody can score a
 * game under. Handled rather than asserted because a scoresheet must not refuse to open over it.
 */
export function normalCorrect(format: IScorekeeperFormat): IScorekeeperAnswerType | null {
  return correctTypes(format)[0] ?? null;
}

/**
 * The power: the most valuable correct answer, when there is a choice.
 *
 * Null when the format has exactly one positive answer, which is the common case outside NAQT rules
 * and is why Shift has to be able to be unavailable rather than aliasing the unmodified key.
 */
export function powerCorrect(format: IScorekeeperFormat): IScorekeeperAnswerType | null {
  const correct = correctTypes(format);
  return correct.length > 1 ? correct[correct.length - 1] : null;
}

/**
 * The penalty.
 *
 * The format's own first negative answer. A format with more than one — a −5 and a −10, say — leaves
 * the others to the mouse rather than growing a second modifier, which is the rule for every extra
 * ruling this layout cannot name.
 */
export function negRuling(format: IScorekeeperFormat): IScorekeeperAnswerType | null {
  return format.answerTypes.find((type) => type.isNeg) ?? null;
}

/**
 * Answer types this keyboard layout cannot reach.
 *
 * Reported so the legend can say so out loud. A format with three positive tiers gets its middle one
 * left on the buttons, and a scorekeeper who has been told that will reach for the mouse instead of
 * hunting for a chord that was never designed.
 */
export function unreachableAnswerTypes(format: IScorekeeperFormat): IScorekeeperAnswerType[] {
  const reachable = new Set(
    [normalCorrect(format), powerCorrect(format), negRuling(format)]
      .filter((type): type is IScorekeeperAnswerType => type !== null)
      .map((type) => type.index),
  );
  return format.answerTypes.filter((type) => !reachable.has(type.index));
}

/** "+15" / "−5" / a label the format chose. Shared with the buttons so the legend cannot disagree. */
export function rulingLabel(answerType: IScorekeeperAnswerType): string {
  if (answerType.shortLabel !== String(answerType.value)) return answerType.shortLabel;
  // The minus sign rather than a hyphen: this is read, not parsed.
  return answerType.value > 0 ? `+${answerType.value}` : `−${Math.abs(answerType.value)}`;
}
