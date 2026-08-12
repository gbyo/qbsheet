/**
 * The shared native modal shell.
 *
 * Native `<dialog>` supplies the page inertness and focus trap that a positioned div cannot. This
 * wrapper also handles the jsdom/non-modal fallback used by the tests and restores the control that
 * opened it when the dialog closes.
 */
import { ReactNode, useEffect, useRef } from 'react';

export default function NativeDialog(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const { title, onClose, children, className = '', bodyClassName = '' } = props;
  const panel = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = panel.current;
    if (!dialog) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !dialog.open) return;
      event.preventDefault();
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
      if (dialog.open) dialog.close?.();
      opener?.focus();
    };
  }, []);

  return (
    <dialog
      ref={panel}
      className={`scorer-dialog ${className}`.trim()}
      aria-label={title}
      onClose={() => onCloseRef.current()}
    >
      <div className="scorer-dialog-head">
        <h2 className="scorer-dialog-title">{title}</h2>
        <button
          type="button"
          className="scorer-action scorer-dialog-close"
          aria-label="Close dialog"
          onClick={() => (typeof panel.current?.close === 'function' ? panel.current.close() : onCloseRef.current())}
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
