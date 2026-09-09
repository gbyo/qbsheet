import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Badge } from './Status';

/**
 * Boolean and single-choice controls.
 *
 * # The native element is still there
 *
 * Every one of these renders a real `<input type="checkbox">` or
 * `<input type="radio">`, visually hidden, with the Director box drawn beside
 * it via `:checked` and `:focus-visible`. That keeps the label association, the
 * roving-tabindex behaviour of a radio group, `indeterminate`, form
 * participation, and the screen-reader role — none of which is worth
 * reimplementing — while removing the platform's own rendering, which was the
 * one piece of Director that changed appearance between macOS, Windows, and
 * Linux.
 *
 * # Checkbox or switch?
 *
 * The distinction carries the save semantics, so it is not cosmetic:
 *
 *   `Checkbox` is a **form value**. It changes what will be saved when the
 *   operator presses Save. Used in dialogs and forms.
 *
 *   `Switch` is an **operation**. Flipping it takes effect now, and the
 *   application reports that it did. Used for live/operational settings where
 *   an explicit Save would be wrong — publishing, watching a folder, privacy.
 *
 * A surface that mixes them is telling the operator which of its controls are
 * pending and which have already happened.
 */

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  indeterminate = false,
  name,
  value,
  ariaDescribedBy,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  indeterminate?: boolean;
  name?: string;
  value?: string;
  ariaDescribedBy?: string;
  /**
   * The spoken name, when the visible label is only unambiguous in context —
   * a "Captain" box repeated once per roster row tells a screen-reader user
   * nothing about which player it belongs to.
   */
  ariaLabel?: string;
}) {
  // `indeterminate` is a property, not an attribute, so React cannot set it
  // declaratively. A ref callback keeps it in step with the prop.
  const setRef = (node: HTMLInputElement | null) => {
    if (node) node.indeterminate = indeterminate && !checked;
  };
  return (
    <label className="director-choice" data-disabled={disabled || undefined}>
      <input
        ref={setRef}
        type="checkbox"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="director-choice-box" aria-hidden="true">
        <Icon name={indeterminate && !checked ? 'minus' : 'check'} size={13} />
      </span>
      <span className="director-choice-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

/** A vertical list of checkboxes with a legend. */
export function CheckboxGroup({
  legend,
  hint,
  children,
  columns = false,
}: {
  legend: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  columns?: boolean;
}) {
  return (
    <fieldset className="director-fieldset">
      <legend>{legend}</legend>
      {hint && <p className="director-field-hint">{hint}</p>}
      <div className={columns ? 'director-choice-list-columns' : 'director-choice-list'}>{children}</div>
    </fieldset>
  );
}

/**
 * Choices that only apply while their parent is on — live scores needing live
 * game status, player statistics needing player names.
 *
 * Indented under the parent with a rule, so the dependency is *visible* rather
 * than described in a sentence of helper copy the operator has to connect back
 * to the right checkbox.
 */
export function DependentChoices({ children }: { children: ReactNode }) {
  return <div className="director-choice-dependents">{children}</div>;
}

export function RadioGroup<T extends string>({
  value,
  options,
  onChange,
  legend,
  hint,
  name,
  disabled = false,
  columns = false,
}: {
  value: T | '' | null | undefined;
  options: { value: T; label: ReactNode; hint?: ReactNode; disabled?: boolean }[];
  onChange: (value: T) => void;
  legend: ReactNode;
  hint?: ReactNode;
  name?: string;
  disabled?: boolean;
  columns?: boolean;
}) {
  const generated = useId();
  const groupName = name ?? generated;
  return (
    <fieldset className="director-fieldset" disabled={disabled}>
      <legend>{legend}</legend>
      {hint && <p className="director-field-hint">{hint}</p>}
      <div className={columns ? 'director-choice-list-columns' : 'director-choice-list'}>
        {options.map((option) => (
          <label
            key={option.value}
            className="director-choice director-choice-radio"
            data-disabled={option.disabled || disabled || undefined}
          >
            <input
              type="radio"
              name={groupName}
              value={option.value}
              checked={value === option.value}
              disabled={option.disabled || disabled}
              onChange={() => onChange(option.value)}
            />
            <span className="director-choice-box" aria-hidden="true" />
            <span className="director-choice-text">
              <span>{option.label}</span>
              {option.hint && <small>{option.hint}</small>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * A control that applies immediately.
 *
 * `pending` disables it while the operation is in flight, which is the honest
 * thing to do for anything that touches a backend or the filesystem: the switch
 * should not read as "on" before the operation says it is.
 */
export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  pending = false,
  ariaDescribedBy,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  pending?: boolean;
  ariaDescribedBy?: string;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="director-switch">
      <span className="director-switch-label" id={labelId}>
        <span>{label}</span>
        {hint && <small id={hintId}>{hint}</small>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={ariaDescribedBy ?? (hint ? hintId : undefined)}
        className="director-switch-control"
        disabled={disabled || pending}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

/**
 * Mutually exclusive options that each need a sentence.
 *
 * QBSheet Live's backend picker was already shaped like this, but as a one-off
 * dialect with its own class names and its own `aria-checked` handling. This is
 * that idea, made shared and made a real radio group, so it can also carry the
 * tournament-shape choice and anything else that genuinely needs explanation
 * per option. Two to four options; more than that is a `Select`.
 */
export function ChoiceCards<T extends string>({
  value,
  options,
  onChange,
  legend,
  hint,
  name,
}: {
  value: T | '' | null | undefined;
  options: { value: T; title: ReactNode; description?: ReactNode; badge?: ReactNode; disabled?: boolean }[];
  onChange: (value: T) => void;
  legend: ReactNode;
  hint?: ReactNode;
  name?: string;
}) {
  const generated = useId();
  const groupName = name ?? generated;
  return (
    <fieldset className="director-fieldset">
      <legend>{legend}</legend>
      {hint && <p className="director-field-hint">{hint}</p>}
      <div className="director-choice-cards">
        {options.map((option) => (
          <label
            key={option.value}
            className="director-choice-card director-choice-radio"
            data-selected={value === option.value || undefined}
            data-disabled={option.disabled || undefined}
          >
            <input
              type="radio"
              name={groupName}
              value={option.value}
              checked={value === option.value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
            />
            <span className="director-choice-box" aria-hidden="true" />
            <span className="director-choice-card-text">
              <strong>
                <span className="director-choice-card-title">{option.title}</span>
                {option.badge && <Badge tone="neutral" label={option.badge} />}
              </strong>
              {option.description && <small>{option.description}</small>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Two to four peer views of the same data — Teams | Players, Rooms | Staff |
 * Equipment. A pressed-button group, not a tab list, because it switches a
 * *view* rather than revealing a panel.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    const updateIndicator = () => {
      const selected = group.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      if (!selected) {
        setIndicator(null);
        return;
      }
      const next = { left: selected.offsetLeft, width: selected.offsetWidth };
      setIndicator((current) =>
        current?.left === next.left && current.width === next.width ? current : next,
      );
    };

    updateIndicator();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateIndicator);
    observer.observe(group);
    group.querySelectorAll('button').forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [value]);

  return (
    <div ref={groupRef} className="director-segmented" role="group" aria-label={ariaLabel}>
      <span
        className="director-segmented-indicator"
        aria-hidden="true"
        style={indicator ? { left: indicator.left, width: indicator.width } : undefined}
      />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
