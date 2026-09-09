import { useId, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * Progressive disclosure, as a labelled control rather than a `<details>`.
 *
 * # Why not `<details>`
 *
 * `<details>`/`<summary>` gives a marker triangle drawn by the browser, a
 * summary that is not a button in the accessibility tree in every engine, and
 * no way to distinguish "advanced settings" from "diagnostics" from "show more
 * rows". Director had one dropped raw under the Overview page carrying recovery
 * diagnostics, which is exactly the content that should look deliberate.
 *
 * # What the label has to say
 *
 * The trigger names what is inside and, for anything below the ordinary
 * workflow, what kind of thing it is: *Advanced*, *Diagnostics*, *Recovery*.
 * The product principle is that internal state machines are not user workflows;
 * this is the component that keeps them one layer down and still reachable.
 */
export function Disclosure({
  label,
  children,
  icon,
  hint,
  defaultOpen = false,
  standalone = false,
  actions,
}: {
  label: ReactNode;
  children: ReactNode;
  icon?: IconName;
  /** A short note about what is inside, shown next to the label. */
  hint?: ReactNode;
  defaultOpen?: boolean;
  /** Draws its own border, for a disclosure that is not already inside a panel. */
  standalone?: boolean;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const labelId = useId();
  const hintId = useId();
  return (
    <div
      className={['director-disclosure', standalone ? 'director-disclosure-standalone' : '']
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        className="director-disclosure-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        // The label alone names the trigger; the hint is a description so it
        // does not become part of the accessible name.
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="chevron" size={14} />
        {icon && <Icon name={icon} size={15} />}
        <span id={labelId}>{label}</span>
        {hint && (
          <small id={hintId} className="director-text-meta">
            {hint}
          </small>
        )}
      </button>
      {actions}
      <div id={panelId} className="director-disclosure-panel" hidden={!open}>
        {open && children}
      </div>
    </div>
  );
}
