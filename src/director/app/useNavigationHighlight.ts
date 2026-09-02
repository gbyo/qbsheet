import { useEffect, useState } from 'react';
import type { DirectorNavigationTarget } from './navigationTarget';

/**
 * Gives a search destination a consistent, short-lived focus/highlight treatment.
 * The owning view still controls its filters and disclosure state; this hook only
 * operates on the destination element once it is rendered.
 */
export function useNavigationHighlight(
  target: DirectorNavigationTarget | undefined | null,
  section: DirectorNavigationTarget['section'],
  entityType: DirectorNavigationTarget['entityType'],
  entityId: string,
  onClear?: () => void,
): boolean {
  const [highlighted, setHighlighted] = useState(false);

  useEffect(() => {
    if (
      !target ||
      target.section !== section ||
      target.entityType !== entityType ||
      target.entityId !== entityId
    ) {
      return;
    }
    const element = Array.from(document.querySelectorAll<HTMLElement>('[data-director-navigation-id]')).find(
      (candidate) => candidate.dataset.directorNavigationId === entityId,
    );
    if (!element) return;
    const frame = window.requestAnimationFrame(() => {
      setHighlighted(true);
      element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      // Chromium does not make a table row the active element even when it has tabindex=-1. The
      // first cell is the row's focus proxy; other target elements (list items, round cards) remain
      // focusable themselves. This gives keyboard users a stable landing point without changing
      // the table's native semantics.
      const focusTarget = element.querySelector<HTMLElement>('[data-director-navigation-focus]') ?? element;
      focusTarget.focus({ preventScroll: true });
      onClear?.();
      window.setTimeout(() => setHighlighted(false), 1600);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      // Clearing the one-shot target causes the parent to render once more. Keep the timer alive
      // across that render so the destination remains visibly highlighted for the full treatment.
      // A later target may start its own timer; its render will still remove the old class before
      // the new destination is focused.
    };
  }, [entityId, entityType, onClear, section, target]);

  return highlighted;
}
