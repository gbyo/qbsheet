import { KeyboardEvent, useId } from 'react';

/**
 * A compact explanation for a term that is useful to some scorekeepers but noise to everyone else.
 *
 * The explanation is always in the accessibility tree through `aria-describedby`. CSS reveals the
 * same text on hover or focus, which also makes a tap on the button useful on touch devices.
 */
export default function HelpTooltip(props: { label: string; children: string }) {
  const { label, children } = props;
  const tooltipId = useId();

  const dismiss = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') event.currentTarget.blur();
  };

  return (
    <span className="help-tooltip">
      <button
        type="button"
        className="help-tooltip-trigger"
        aria-label={label}
        aria-describedby={tooltipId}
        onKeyDown={dismiss}
      >
        <span aria-hidden="true">?</span>
      </button>
      <span id={tooltipId} className="help-tooltip-popover" role="tooltip">
        {children}
      </span>
    </span>
  );
}
