/**
 * The shell every infrequent action opens in.
 *
 * Substitutions, lightning totals, forfeits and notes all interrupt scoring, which is exactly why
 * they belong behind a deliberate action rather than on the main screen. A permanent panel for each
 * would crowd out the thing the scorekeeper is actually doing, and a row of eight icon buttons is
 * eight chances to press the wrong one during a tossup.
 */
import { ReactNode, useEffect, useRef } from 'react';

export interface IScorerDialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export default function ScorerDialog(props: IScorerDialogProps) {
  const { title, onClose, children } = props;
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Escape closes. A scorekeeper who opened this by accident mid-round needs one keystroke out.
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    // Move focus in, so the keyboard lands somewhere useful rather than back at the page top.
    panel.current?.querySelector<HTMLElement>('button, input, select, textarea')?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="scorer-backdrop"
      role="presentation"
      onClick={(clickEvent) => {
        if (clickEvent.target === clickEvent.currentTarget) onClose();
      }}
    >
      <div className="scorer-dialog" role="dialog" aria-modal="true" aria-label={title} ref={panel}>
        <div className="scorer-dialog-head">
          <h2 className="scorer-dialog-title">{title}</h2>
          <button type="button" className="scorer-action" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="scorer-dialog-body">{children}</div>
      </div>
    </div>
  );
}
