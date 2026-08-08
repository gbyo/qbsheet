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
  // eslint-disable-next-line react/require-default-props
  wide?: boolean;
}

export default function ScorerDialog(props: IScorerDialogProps) {
  const { title, onClose, children, wide = false } = props;
  const panel = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = panel.current;
    if (!dialog) return undefined;

    /*
     * A native <dialog> is worth using: focus trapping, Escape, inertness of the page behind it and
     * a ::backdrop all come free and correct, where a hand-rolled modal gets each of them slightly
     * wrong. But showModal is not universal — it is absent in the jsdom this repo resolves, and
     * calling it there throws out of an effect and takes the whole screen down rather than the
     * dialog. So ask before calling, and fall back to opening it non-modally: the panel still shows
     * and still closes, it just does not make the page behind it inert.
     */
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.open = true;

    return () => {
      if (dialog.open) dialog.close?.();
    };
  }, []);

  return (
    <dialog
      className={wide ? 'scorer-dialog is-wide' : 'scorer-dialog'}
      role="dialog"
      aria-label={title}
      ref={panel}
      onClose={onClose}
    >
      <div className="scorer-dialog-head">
        <h2 className="scorer-dialog-title">{title}</h2>
        <button
          type="button"
          className="scorer-action"
          // close() fires the native close event, which is what calls onClose. Where the element is
          // only a styled box rather than a real dialog, call it directly instead.
          onClick={() => (typeof panel.current?.close === 'function' ? panel.current.close() : onClose())}
        >
          Close
        </button>
      </div>
      <div className="scorer-dialog-body">{children}</div>
    </dialog>
  );
}
