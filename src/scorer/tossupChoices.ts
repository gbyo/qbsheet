/**
 * The rulings on this tossup, shaped for something that draws them.
 *
 * # Why this is not in `tossupRulings`
 *
 * That file answers questions about the format: which answer types are legal right now, which one is
 * the base tossup, which is the power. This one turns those answers into a list a picker can walk —
 * the value to print, the word to print under it, and the zero-point ruling that has no answer type
 * behind it at all. Keeping the two apart is what stops presentation concerns leaking into the module
 * the keyboard layer also binds to.
 *
 * # The zero is not an answer type, here or anywhere
 *
 * A wrong answer with no penalty is `tossup-no-penalty`, a distinct event with its own callback. It
 * is carried in this list because it is one of the things a scorekeeper chooses between, and it is
 * carried as its own `kind` so that no caller can mistake it for a ruling worth nothing and fabricate
 * an `IScorekeeperAnswerType` to hold it.
 *
 * # No format values are written down
 *
 * Nothing here knows what a power is worth or whether one exists. The values come from
 * `availableAnswerTypes`, and the names come either from the label the format chose or from the
 * structural role `tossupRulings` derives — which is the same role the keyboard's own action names
 * describe, reused rather than restated.
 */
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { keyboardActionNames } from './KeyboardScoring';
import { availableAnswerTypes, normalCorrect, powerCorrect, rulingLabel } from './tossupRulings';

export type TossupChoice =
  | {
      kind: 'answer';
      answerType: IScorekeeperAnswerType;
      /** "+15" / "−5", or whatever the format called it. From `rulingLabel`. */
      label: string;
      /** "Power" / "Correct" / "Neg", or the format's own name. Empty when there is nothing to add. */
      name: string;
    }
  | {
      kind: 'wrong';
      label: '0';
      name: string;
    };

/** What a wrong answer that costs nothing is called. The one ruling with no answer type behind it. */
export const wrongNoPenaltyName = 'No penalty';

/**
 * The word under the number.
 *
 * A format that gave the answer type a real label means it, and that label wins — an "Interrupt" is
 * an interrupt. Otherwise the name is the structural role: the cheapest positive answer is the base
 * tossup, the dearest is the power when there is a choice between them, and a negative one is the
 * penalty. A tier in between has no name in any format's vocabulary, so it gets none rather than a
 * borrowed one.
 */
function choiceName(format: IScorekeeperFormat, answerType: IScorekeeperAnswerType): string {
  if (answerType.label !== String(answerType.value)) return answerType.label;
  if (answerType.isNeg) return keyboardActionNames.neg;
  if (powerCorrect(format)?.index === answerType.index) return keyboardActionNames.power;
  if (normalCorrect(format)?.index === answerType.index) return keyboardActionNames.correct;
  return '';
}

/**
 * Every ruling a team may be given on this tossup, in the order the format lists them, with the
 * zero-point wrong answer last.
 *
 * Negs are absent once anybody has answered, exactly as they are on the scoresheet's buttons, because
 * both callers ask `availableAnswerTypes` rather than deciding for themselves.
 */
export default function tossupChoices(format: IScorekeeperFormat, negsAvailable: boolean): TossupChoice[] {
  const answers: TossupChoice[] = availableAnswerTypes(format, negsAvailable).map((answerType) => ({
    kind: 'answer',
    answerType,
    label: rulingLabel(answerType),
    name: choiceName(format, answerType),
  }));
  return [...answers, { kind: 'wrong', label: '0', name: wrongNoPenaltyName }];
}
