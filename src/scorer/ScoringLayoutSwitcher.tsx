/**
 * Choosing between the two scoring layouts, in the two places it is offered.
 *
 * # One control, two sizes
 *
 * The chooser a new game opens and the switcher above the scoring surface are the same question, and
 * a scorekeeper who learns one should not have to learn the other. So they are one component with
 * two shapes: `cards`, which has room to say what each layout is, and `segmented`, which does not
 * and does not need to — by then the scorekeeper has seen both.
 *
 * # Why it is a radiogroup and not a toggle
 *
 * The Game menu used to carry an entry reading "Scoring view: Scoresheet" whose action was to switch
 * to the table. That is a label naming the current state on a control that changes it, which is the
 * one shape of toggle nobody can read under time pressure: it is equally consistent with "you are on
 * the scoresheet" and "press for the scoresheet". Two options, one of them marked as current, cannot
 * be misread.
 *
 * The full radio keyboard pattern comes with that role, so it is implemented rather than borrowed:
 * one tab stop for the group, arrows to move between the options, Home and End to the ends. A
 * `role="radio"` without those is a promise to assistive technology that the control then breaks.
 */
import { useId, useRef } from 'react';
import {
  ScoringView,
  scoringLayoutDescriptions,
  scoringLayoutLabels,
  scoringLayoutTaglines,
  scoringLayouts,
} from './scoringViewPreference';

/**
 * How the selection moved.
 *
 * `press` is a deliberate choice — a click, Enter, Space. `move` is an arrow key walking the group.
 * The strip above the surface treats both as the decision, because switching *is* what it does. The
 * chooser treats only a press as the decision, so that a scorekeeper can read the second card
 * without the dialog closing under them.
 */
export type LayoutChangeCause = 'press' | 'move';

export interface IScoringLayoutSwitcherProps {
  value: ScoringView;
  onChange: (layout: ScoringView, cause: LayoutChangeCause) => void;
  /** `segmented` is the strip above the surface; `cards` is the chooser a new game opens. */
  variant?: 'segmented' | 'cards';
  /** Named when the surrounding copy does not already name it. */
  label?: string;
  /** Focus the current choice on mount, which is what the chooser wants and the strip does not. */
  focusOnMount?: boolean;
}

export default function ScoringLayoutSwitcher(props: IScoringLayoutSwitcherProps) {
  const { value, onChange, variant = 'segmented', label = 'Scoring layout', focusOnMount = false } = props;
  const options = useRef<Array<HTMLButtonElement | null>>([]);
  const detailId = useId();

  /*
   * Arrows move the selection, which is what a radiogroup does and what a scorekeeper expects.
   *
   * On the options rather than on the group, because the group is not focusable and a keyboard
   * handler on something nothing can focus is a handler that only fires by accident.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const current = scoringLayouts.indexOf(value);
    let next = current;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % scoringLayouts.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (current - 1 + scoringLayouts.length) % scoringLayouts.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = scoringLayouts.length - 1;
    else return;
    event.preventDefault();
    options.current[next]?.focus();
    onChange(scoringLayouts[next], 'move');
  };

  return (
    <div
      className={variant === 'cards' ? 'scorer-layout-cards' : 'scorer-layout-segmented'}
      role="radiogroup"
      aria-label={label}
    >
      {scoringLayouts.map((layout, index) => {
        const selected = layout === value;
        return (
          <button
            key={layout}
            type="button"
            ref={(element) => {
              options.current[index] = element;
            }}
            role="radio"
            aria-checked={selected}
            /*
             * The name is the layout, and only the layout.
             *
             * A card's own text is three lines, and without this the option would be announced as
             * all three run together — which is a paragraph where a choice should be a word. What
             * the layout actually does is a description instead, which is where a screen reader
             * expects to find it.
             */
            aria-label={scoringLayoutLabels[layout]}
            aria-describedby={variant === 'cards' ? `${detailId}-${layout}` : undefined}
            // One tab stop for the group: Tab reaches the current choice, arrows change it.
            tabIndex={selected ? 0 : -1}
            {...(focusOnMount && selected ? { 'data-dialog-autofocus': true } : {})}
            className={
              variant === 'cards'
                ? `scorer-layout-card${selected ? ' is-selected' : ''}`
                : `scorer-layout-option${selected ? ' is-selected' : ''}`
            }
            onClick={() => onChange(layout, 'press')}
            onKeyDown={onKeyDown}
          >
            <span className="scorer-layout-option-name">{scoringLayoutLabels[layout]}</span>
            {variant === 'cards' && (
              <>
                <span className="scorer-layout-card-tagline">{scoringLayoutTaglines[layout]}</span>
                <span id={`${detailId}-${layout}`} className="scorer-layout-card-detail">
                  {scoringLayoutDescriptions[layout]}
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
