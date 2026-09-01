/**
 * One of two or three named things, with the current one marked.
 *
 * # Why it is a radiogroup and not a toggle
 *
 * The Game menu used to carry an entry reading "Scoring view: Scoresheet" whose action was to switch
 * to the table. That is a label naming the current state on a control that changes it, which is the
 * one shape of toggle nobody can read under time pressure: it is equally consistent with "you are on
 * the scoresheet" and "press for the scoresheet". Every option named, one of them marked as current,
 * cannot be misread.
 *
 * The full radio keyboard pattern comes with that role, so it is implemented rather than borrowed:
 * one tab stop for the group, arrows to move between the options, Home and End to the ends. A
 * `role="radio"` without those is a promise to assistive technology that the control then breaks.
 *
 * # Two shapes
 *
 * `segmented` is the strip: a word each, for a choice the scorekeeper has already understood.
 * `cards` has room to say what each option is, which is what a new game's chooser needs. One
 * component either way, so somebody who learns the chooser has already learned the strip.
 */
import { useId, useRef } from 'react';

/**
 * How the selection moved.
 *
 * `press` is a deliberate choice — a click, Enter, Space. `move` is an arrow key walking the group.
 * A live control treats both as the decision, because switching *is* what it does. A chooser in a
 * dialog treats only a press as the decision, so that a scorekeeper can read the second option
 * without the dialog closing under them.
 */
export type ChoiceCause = 'press' | 'move';

export interface ISegmentedOption<T extends string> {
  value: T;
  /** The accessible name, and the word on the control. One word where possible. */
  label: string;
  /** `cards` only: the half-line under the name. */
  tagline?: string;
  /** What choosing it actually gets you. The accessible description, and `cards` draws it. */
  description?: string;
}

export interface ISegmentedChoiceProps<T extends string> {
  options: ReadonlyArray<ISegmentedOption<T>>;
  value: T;
  onChange: (value: T, cause: ChoiceCause) => void;
  /** Names the group for assistive technology, and is not drawn. */
  label: string;
  variant?: 'segmented' | 'cards';
  /** Focus the current choice on mount, which is what a dialog wants and a strip does not. */
  focusOnMount?: boolean;
  /** Added to the group, for the surfaces that size themselves differently. */
  className?: string;
}

export default function SegmentedChoice<T extends string>(props: ISegmentedChoiceProps<T>) {
  const {
    options,
    value,
    onChange,
    label,
    variant = 'segmented',
    focusOnMount = false,
    className = '',
  } = props;
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const detailId = useId();
  const cards = variant === 'cards';

  /*
   * Arrows move the selection, which is what a radiogroup does and what a scorekeeper expects.
   *
   * On the options rather than on the group, because the group is not focusable and a keyboard
   * handler on something nothing can focus is a handler that only fires by accident.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const current = options.findIndex((option) => option.value === value);
    let next = current;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % options.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (current - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else return;
    event.preventDefault();
    buttons.current[next]?.focus();
    onChange(options[next].value, 'move');
  };

  const groupClass = [cards ? 'scorer-layout-cards' : 'scorer-layout-segmented', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={groupClass} role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const selected = option.value === value;
        const describedBy = option.description ? `${detailId}-${option.value}` : undefined;
        return (
          <button
            key={option.value}
            type="button"
            ref={(element) => {
              buttons.current[index] = element;
            }}
            role="radio"
            aria-checked={selected}
            /*
             * The name is the option, and only the option.
             *
             * A card's own text is three lines, and without this it would be announced as all three
             * run together — a paragraph where a choice should be a word. What the option does is a
             * description instead, which is where a screen reader expects to find it.
             */
            aria-label={option.label}
            aria-describedby={describedBy}
            // One tab stop for the group: Tab reaches the current choice, arrows change it.
            tabIndex={selected ? 0 : -1}
            {...(focusOnMount && selected ? { 'data-dialog-autofocus': true } : {})}
            className={
              cards
                ? `scorer-layout-card${selected ? ' is-selected' : ''}`
                : `scorer-layout-option${selected ? ' is-selected' : ''}`
            }
            onClick={() => onChange(option.value, 'press')}
            onKeyDown={onKeyDown}
          >
            <span className="scorer-layout-option-name">{option.label}</span>
            {cards && option.tagline && <span className="scorer-layout-card-tagline">{option.tagline}</span>}
            {option.description &&
              (cards ? (
                <span id={describedBy} className="scorer-layout-card-detail">
                  {option.description}
                </span>
              ) : (
                // Read by assistive technology, and by nobody else: the strip has room for a word.
                <span id={describedBy} className="visually-hidden">
                  {option.description}
                </span>
              ))}
          </button>
        );
      })}
    </div>
  );
}
