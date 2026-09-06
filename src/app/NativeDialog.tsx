/**
 * The shared native modal shell.
 *
 * Native `<dialog>` supplies the page inertness and focus trap that a positioned div cannot. This
 * wrapper also handles the jsdom/non-modal fallback used by the tests and restores the control that
 * opened it when the dialog closes.
 */
import { ReactNode, useEffect, useLayoutEffect, useRef } from 'react';

export default function NativeDialog(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /**
   * Whether the three ways out — Escape, the close button, the platform's own close request — are
   * available right now. Defaults to true, which is every dialog in the application except one that
   * is mid-write.
   *
   * A dialog holding an operation that can still fail has nowhere to put the failure once it has
   * gone; see the rename editors in `GameDetailsDialog`. Refusing to close is not a modal trap
   * because the operation it is waiting on always settles: the same press works a moment later.
   * It is expressed here rather than in each caller so that "cannot be dismissed" means one thing
   * and covers every route out, including the ones no component-level handler ever sees.
   */
  dismissible?: boolean;
}) {
  const { title, onClose, children, className = '', bodyClassName = '', dismissible = true } = props;
  const panel = useRef<HTMLDialogElement>(null);
  // The document-level Escape listener outlives any one render. Refresh its callback before the
  // browser can dispatch input to the newly committed dialog rather than one passive effect later.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  // This guard can flip false while a write is starting. The Escape listener must see that new
  // answer in the same commit that disables the visible close controls, not after passive effects.
  const dismissibleRef = useRef(dismissible);
  useLayoutEffect(() => {
    dismissibleRef.current = dismissible;
  }, [dismissible]);

  useEffect(() => {
    const dialog = panel.current;
    if (!dialog) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !dialog.open) return;
      // Swallowed either way: preventing the default is what stops the platform closing the dialog
      // out from under a write, and it is also what stops a second handler acting on the same key.
      event.preventDefault();
      if (!dismissibleRef.current) return;
      if (typeof dialog.close === 'function') dialog.close();
      else onCloseRef.current();
    };

    document.addEventListener('keydown', onKeyDown);
    try {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.open = true;
    } catch {
      // A browser that exposes the method but cannot modal-open this node still gets a visible,
      // closable dialog rather than an exception that unmounts the scoresheet.
      dialog.open = true;
    }

    const autofocus = dialog.querySelector<HTMLElement>('[data-dialog-autofocus]');
    (autofocus ?? dialog.querySelector<HTMLElement>('button, input, textarea, select, [tabindex]'))?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Unmounting is already the parent's decision to remove this dialog. Calling `close()` here can
      // emit a native `close` event and turn that teardown into a second `onClose` request.
      opener?.focus();
    };
  }, []);

  return (
    <dialog
      ref={panel}
      className={`scorer-dialog ${className}`.trim()}
      aria-label={title}
      /*
       * The platform's own close request — Escape where the browser handles it itself, and the
       * things that are not a key press at all. Cancelling it is the only way to refuse those.
       */
      onCancel={(cancelEvent) => {
        if (!dismissible) cancelEvent.preventDefault();
      }}
      onClose={() => onCloseRef.current()}
    >
      <div className="scorer-dialog-head">
        <h2 className="scorer-dialog-title">{title}</h2>
        <button
          type="button"
          className="scorer-action scorer-dialog-close"
          aria-label="Close dialog"
          disabled={!dismissible}
          onClick={() =>
            typeof panel.current?.close === 'function' ? panel.current.close() : onCloseRef.current()
          }
        >
          <span className="scorer-dialog-close-glyph" aria-hidden="true">
            ×
          </span>
        </button>
      </div>
      <div className={`scorer-dialog-body ${bodyClassName}`.trim()}>{children}</div>
    </dialog>
  );
}
