/**
 * Choosing between the two scoring layouts, in the two places it is offered.
 *
 * The chooser a new game opens and the switcher above the scoring surface are the same question, and
 * a scorekeeper who learns one should not have to learn the other. So they are one control in two
 * shapes — see `SegmentedChoice`, which the table's own orientation strip shares.
 *
 * This file is the copy: which layouts exist, what they are called, and what each one gets you.
 */
import SegmentedChoice, { ChoiceCause, ISegmentedOption } from './SegmentedChoice';
import {
  ScoringView,
  scoringLayoutDescriptions,
  scoringLayoutLabels,
  scoringLayoutTaglines,
  scoringLayouts,
} from './scoringViewPreference';

export type { ChoiceCause as LayoutChangeCause } from './SegmentedChoice';

const layoutOptions: ReadonlyArray<ISegmentedOption<ScoringView>> = scoringLayouts.map((layout) => ({
  value: layout,
  label: scoringLayoutLabels[layout],
  tagline: scoringLayoutTaglines[layout],
  description: scoringLayoutDescriptions[layout],
}));

export interface IScoringLayoutSwitcherProps {
  value: ScoringView;
  onChange: (layout: ScoringView, cause: ChoiceCause) => void;
  /** `segmented` is the strip above the surface; `cards` is the chooser a new game opens. */
  variant?: 'segmented' | 'cards';
  /** Named when the surrounding copy does not already name it. */
  label?: string;
  /** Focus the current choice on mount, which is what the chooser wants and the strip does not. */
  focusOnMount?: boolean;
}

export default function ScoringLayoutSwitcher(props: IScoringLayoutSwitcherProps) {
  const { value, onChange, variant = 'segmented', label = 'Scoring layout', focusOnMount = false } = props;
  return (
    <SegmentedChoice
      options={layoutOptions}
      value={value}
      onChange={onChange}
      label={label}
      variant={variant}
      focusOnMount={focusOnMount}
    />
  );
}
