/**
 * The question a new game opens with: which layout are you scoring this in?
 *
 * # Why it is asked rather than assumed
 *
 * See `scoringLayoutPrompt`. The short version is that the Chromebook remembers and the person does
 * not: whoever sat down for this round may not be whoever chose last round's layout, and finding
 * somebody else's choice already in force is worse than one press.
 *
 * # Why choosing closes it
 *
 * There is no Continue. The two cards *are* the decision, and a confirmation step after a
 * two-option choice is a second press that can only ever agree with the first. Pressing a card sets
 * the layout, remembers it for the next game on this device, records that this game has been asked,
 * and gets out of the way.
 *
 * # Why dismissing chooses too
 *
 * Escape and the close button are the same answer with the *selected* card, and that has to mean
 * the card the group is actually showing as selected. Arrow keys move a radio group's selection, so
 * a scorekeeper who arrowed to Table and pressed Escape had a dialog on screen reading "Table
 * selected" and a scoresheet behind it: the marked option and the layout in force disagreed, and
 * the one the room could see lost. Committing what is selected removes the disagreement rather than
 * describing it, and there is nothing to lose by it — every one of these answers is a preference
 * about a screen, changeable from the strip above the surface at any point in the game.
 */
import { useRef, useState } from 'react';
import ScorerDialog from './ScorerDialog';
import ScoringLayoutSwitcher from './ScoringLayoutSwitcher';
import { ScoringView } from './scoringViewPreference';

export interface IScoringLayoutDialogProps {
  /** The layout to preselect: this device's last used one. */
  value: ScoringView;
  /**
   * Answered. The caller sets the layout, remembers it, and marks this game as asked.
   *
   * Every way out of this dialog calls it, dismissal included, so there is no route that leaves the
   * selected card and the layout in force saying different things.
   */
  onChoose: (layout: ScoringView) => void;
}

export default function ScoringLayoutDialog(props: IScoringLayoutDialogProps) {
  const { value, onChoose } = props;
  /*
   * What the cards show, and what dismissing the dialog will commit.
   *
   * Arrow keys move the selection, which is what `role="radio"` promises; a press is the same move
   * followed immediately by the answer. Dismissal answers with whatever this holds.
   */
  const [selected, setSelected] = useState<ScoringView>(value);
  /*
   * Answered once, whichever way it was answered.
   *
   * A press answers and closes, and closing is itself an answer, so the two routes can both fire for
   * one decision — the native dialog's own `close` event arrives after the press has already been
   * acted on. Nothing here is destructive, but a second answer would carry the selection as it stood
   * before the press, which is the opposite of what was pressed.
   */
  const answered = useRef(false);
  const answer = (layout: ScoringView) => {
    if (answered.current) return;
    answered.current = true;
    onChoose(layout);
  };

  return (
    <ScorerDialog title="Choose a scoring layout" onClose={() => answer(selected)}>
      <p className="scorer-dialog-note">
        You can switch at any time. This doesn&rsquo;t change the game or recorded scores.
      </p>
      <ScoringLayoutSwitcher
        variant="cards"
        value={selected}
        focusOnMount
        label="Scoring layout"
        onChange={(layout, cause) => {
          setSelected(layout);
          // Arrows read the cards; a press answers. See `LayoutChangeCause`.
          if (cause === 'press') answer(layout);
        }}
      />
    </ScorerDialog>
  );
}
