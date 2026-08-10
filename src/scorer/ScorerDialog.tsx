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
  wide?: boolean;
}

export default function ScorerDialog(props: IScorerDialogProps) {
  const { title, onClose, children, wide = false } = props;
  const panel = useRef<HTMLDialogElement>(null);

  /**
   * Escape closes it, said rather than assumed.
   *
   * A modal `<dialog>` gets this from the platform, and where showModal exists this handler simply
   * agrees with it. Where it does not — the non-modal fallback below, and the jsdom the tests run in
   * — Escape did nothing at all, so a dialog documented as escapable was not one. Closing through the
   * element keeps every exit on the same path: `close()` fires `close`, which is what calls `onClose`.
   */
  useEffect(() => {
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape' || keyEvent.defaultPrevented) return;
      const dialog = panel.current;
      if (!dialog?.open) return;
      keyEvent.preventDefault();
      if (typeof dialog.close === 'function') dialog.close();
      else onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
      aria-label={title}
      ref={panel}
      onClose={onClose}
    >
      <div className="scorer-dialog-head">
        <h2 className="scorer-dialog-title">{title}</h2>
        {/*
          The way out, and it says so twice. A dialog tall enough to scroll — the question editor is —
          used to carry its only close control at the top of a scrolling box, so a scorekeeper who had
          scrolled down to the bonus had no exit anywhere on screen. The head is now pinned, and the
          control carries the ✕ that people look for as well as the word.
        */}
        <button
          type="button"
          className="scorer-action scorer-dialog-close"
          // close() fires the native close event, which is what calls onClose. Where the element is
          // only a styled box rather than a real dialog, call it directly instead.
          onClick={() => (typeof panel.current?.close === 'function' ? panel.current.close() : onClose())}
        >
          <span className="scorer-dialog-close-glyph" aria-hidden="true">
            ✕
          </span>
          <span>Close</span>
        </button>
      </div>
      <div className="scorer-dialog-body">{children}</div>
    </dialog>
  );
}
