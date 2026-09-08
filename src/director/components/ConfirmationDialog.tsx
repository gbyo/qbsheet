import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button } from './Controls';

export function ConfirmationDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);

  useLayoutEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) previousFocusRef.current = document.activeElement as HTMLElement | null;
      if (!dialog.open) dialog.showModal();
      cancelButtonRef.current?.focus();

      const handleCancel = (event: Event) => {
        event.preventDefault();
        if (!busy) onCancelRef.current();
      };
      dialog.addEventListener('cancel', handleCancel);
      return () => dialog.removeEventListener('cancel', handleCancel);
    }

    if (dialog.open) dialog.close();
    const previous = previousFocusRef.current;
    previousFocusRef.current = null;
    if (previous && document.contains(previous)) previous.focus();
  }, [busy, open]);

  return (
    <dialog ref={dialogRef} aria-labelledby={titleId} className="director-help-dialog" aria-modal="true">
      <div className="director-help-dialog-header">
        <h2 id={titleId}>{title}</h2>
      </div>
      <div className="director-help-dialog-body">
        {children}
        <div className="director-form-actions">
          <button
            ref={cancelButtonRef}
            type="button"
            className="director-button director-button-secondary"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
