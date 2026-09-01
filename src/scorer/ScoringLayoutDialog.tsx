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
 * Escape and the close button are the same answer with the preselected card: a scorekeeper who
 * dismisses this has said the highlighted one is fine, and asking again would be nagging.
 */
import { useState } from 'react';
import ScorerDialog from './ScorerDialog';
import ScoringLayoutSwitcher from './ScoringLayoutSwitcher';
import { ScoringView } from './scoringViewPreference';

export interface IScoringLayoutDialogProps {
  /** The layout to preselect: this device's last used one. */
  value: ScoringView;
  /** Chosen. The caller sets the layout, remembers it, and marks this game as asked. */
  onChoose: (layout: ScoringView) => void;
  /** Dismissed without choosing, which means the preselected layout stands. */
  onClose: () => void;
}

export default function ScoringLayoutDialog(props: IScoringLayoutDialogProps) {
  const { value, onChoose, onClose } = props;
  /*
   * What the cards show before the dialog goes away.
   *
   * Arrow keys move the selection, so the group needs somewhere to put a choice that has not been
   * committed by a press yet. A click sets this and then chooses in the same turn, which is what
   * makes the highlight land on the pressed card for the frame before it closes.
   */
  const [highlighted, setHighlighted] = useState<ScoringView>(value);

  return (
    <ScorerDialog title="Choose a scoring layout" onClose={onClose}>
      <p className="scorer-dialog-note">
        You can switch at any time. This doesn&rsquo;t change the game or recorded scores.
      </p>
      <ScoringLayoutSwitcher
        variant="cards"
        value={highlighted}
        focusOnMount
        label="Scoring layout"
        onChange={(layout, cause) => {
          setHighlighted(layout);
          // Arrows read the cards; a press chooses one. See `LayoutChangeCause`.
          if (cause === 'press') onChoose(layout);
        }}
      />
    </ScorerDialog>
  );
}
