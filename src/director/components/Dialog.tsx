import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Button } from './Controls';
import { Icon, type IconName } from './Icon';

/**
 * The one Director modal.
 *
 * Every focused editing surface in the application is this component: New
 * tournament, tournament and operator settings, team and roster editing, room
 * and staff editing, manual result entry, day-event editing, packet editing,
 * announcements, and the advanced recovery surfaces. There is no
 * `director-operator-dialog` serving as generic modal infrastructure any more,
 * and no page hand-rolls `<dialog>` markup.
 *
 * # The action convention
 *
 * Header: title, optional description, and a single icon-only close. The header
 * never carries Cancel — a dialog with Cancel in the header *and* the footer
 * asks the operator to pick between two identical outcomes.
 *
 * Footer: `Cancel` then the primary action, right-aligned, always in that
 * order. A destructive action belongs in `dangerAction`, which sits at the far
 * left so it cannot be reached by muscle memory aimed at Save.
 *
 * # Behaviour
 *
 * Native `<dialog>` with `showModal()`, so the focus trap, the top layer, the
 * backdrop, `aria-modal`, and Escape are the platform's rather than ours.
 * Escape and the close button both run `onClose`, which is the same thing
 * Cancel does. Focus starts on the first field (or the element given
 * `data-autofocus`) and is restored to the opener on close.
 */

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | 'sheet';

export function Dialog({
  open = true,
  title,
  description,
  size = 'md',
  children,
  onClose,
  onSubmit,
  submitLabel,
  submitDisabled,
  submitVariant = 'primary',
  cancelLabel = 'Cancel',
  dangerAction,
  footer,
  closeLabel,
  errors,
  className = '',
}: {
  open?: boolean;
  title: string;
  description?: ReactNode;
  size?: DialogSize;
  children: ReactNode;
  onClose: () => void;
  /** Provided when the dialog is a form. Enter submits, exactly as it would in a page form. */
  onSubmit?: () => void;
  submitLabel?: string;
  submitDisabled?: boolean;
  /** `danger` is normalized to the design-system's destructive submit treatment. */
  submitVariant?: 'primary' | 'danger-solid' | 'danger';
  cancelLabel?: string;
  /** A destructive action for the entity being edited. Rendered apart from Cancel/Save. */
  dangerAction?: ReactNode;
  /** Replaces the whole footer. Use only when the standard pair genuinely does not fit. */
  footer?: ReactNode;
  closeLabel?: string;
  /** Validation problems, announced and shown above the fields. */
  errors?: string[];
  className?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const openerRef = useRef<Element | null>(null);
  // The `cancel` listener is registered once per open, so it needs the current
  // `onClose` without re-registering. A layout effect keeps the ref in step;
  // assigning during render would be a render-phase side effect.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    openerRef.current = document.activeElement;
    if (!dialog.open) dialog.showModal();
    // The first field, or whatever the caller marked. Never "nothing", which is
    // where a keyboard operator used to land in some of these dialogs.
    const target =
      dialog.querySelector<HTMLElement>('[data-autofocus]') ??
      dialog.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), [role="combobox"], button.director-select-trigger',
      ) ??
      dialog.querySelector<HTMLElement>('.director-dialog-footer button:not([disabled])');
    target?.focus({ preventScroll: true });
    const cancel = (event: Event) => {
      event.preventDefault();
      onCloseRef.current();
    };
    dialog.addEventListener('cancel', cancel);
    return () => {
      dialog.removeEventListener('cancel', cancel);
      if (dialog.open) dialog.close();
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [open]);

  if (!open) return null;

  const sizeClass =
    size === 'sheet' ? 'director-dialog-sheet' : size === 'md' ? '' : `director-dialog-${size}`;
  const resolvedSubmitVariant = submitVariant === 'danger' ? 'danger-solid' : submitVariant;

  const body = (
    <>
      <div className="director-dialog-header">
        <div className="director-dialog-heading">
          <h2 id={titleId}>{title}</h2>
          {description && <p id={descriptionId}>{description}</p>}
        </div>
        <button
          type="button"
          className="director-icon-button"
          aria-label={closeLabel ?? `Close ${title}`}
          onClick={onClose}
        >
          <Icon name="x" size={17} />
        </button>
      </div>
      <div className="director-dialog-body">
        {errors && errors.length > 0 && (
          <div className="director-form-errors" role="alert" tabIndex={-1}>
            <strong>{errors.length === 1 ? 'Fix this before saving' : 'Fix these before saving'}</strong>
            <ul>
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        )}
        {children}
      </div>
      {footer ?? (
        <div className="director-dialog-footer">
          {dangerAction && <div className="director-dialog-footer-danger">{dangerAction}</div>}
          <Button variant="secondary" onClick={onClose}>
            {cancelLabel}
          </Button>
          {submitLabel &&
            (onSubmit ? (
              <Button variant={resolvedSubmitVariant} type="submit" disabled={submitDisabled}>
                {submitLabel}
              </Button>
            ) : (
              <Button variant={resolvedSubmitVariant} disabled={submitDisabled} onClick={onClose}>
                {submitLabel}
              </Button>
            ))}
        </div>
      )}
    </>
  );

  return (
    <dialog
      ref={dialogRef}
      className={['director-dialog', sizeClass, className].filter(Boolean).join(' ')}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
    >
      {onSubmit ? (
        <form
          className="director-dialog-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {body}
        </form>
      ) : (
        <div className="director-dialog-form">{body}</div>
      )}
    </dialog>
  );
}

/** A titled group of fields inside a dialog: a heading and a rule, not a card. */
export function DialogSection({
  title,
  description,
  children,
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="director-dialog-section">
      {title && <h3>{title}</h3>}
      {description && <p className="director-panel-footnote">{description}</p>}
      {children}
    </section>
  );
}

/* ============================================================== Confirmation */

export type ConfirmTone = 'danger' | 'warning' | 'neutral';

export interface ConfirmRequest {
  /** What the operator is about to do, as a question or a statement. */
  title: string;
  /** Why it matters. One or two sentences of plain consequence. */
  body?: ReactNode;
  /**
   * The specific, factual result of confirming — how many results are
   * discarded, which rooms lose an assignment. Required in spirit for anything
   * destructive: "Are you sure?" is not a consequence.
   */
  consequence?: ReactNode;
  /** Names the action. Never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

const ConfirmContext = createContext<((request: ConfirmRequest) => Promise<boolean>) | null>(null);

interface ConfirmEntry {
  request: ConfirmRequest;
  resolve: (value: boolean) => void;
}

/**
 * One confirmation pattern for the whole application, replacing the mixture of
 * browser `confirm()`, inline red buttons, and expand-to-confirm rows.
 *
 * `confirm()` was the worst of these: it is unstyled, unlabelled, cannot say
 * what will happen in more than a line, and in a Tauri window looks like a
 * different application entirely.
 *
 * Reversible maintenance ("Rescan this location") does not use this at all —
 * it just happens, and reports. Destructive or tournament-altering actions do,
 * with `tone="danger"`, which is the only place a solid red button appears.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  // React state is intentionally only the visible request. The ref is the authoritative queue so
  // same-tick calls cannot both observe an empty queue and overwrite one another before a render.
  const queueRef = useRef<ConfirmEntry[]>([]);

  const confirm = useCallback((next: ConfirmRequest) => {
    return new Promise<boolean>((resolve) => {
      const wasEmpty = queueRef.current.length === 0;
      queueRef.current.push({ request: next, resolve });
      if (wasEmpty) setRequest(next);
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    const current = queueRef.current.shift();
    if (!current) return;
    current.resolve(value);
    setRequest(queueRef.current[0]?.request ?? null);
  }, []);

  useEffect(
    () => () => {
      // A provider can disappear while an async Director action is awaiting confirmation. Treat
      // teardown as cancellation so neither the visible nor queued callers can remain pending.
      const pending = queueRef.current.splice(0);
      pending.forEach(({ resolve }) => resolve(false));
    },
    [],
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && (
        <ConfirmDialog request={request} onConfirm={() => settle(true)} onCancel={() => settle(false)} />
      )}
    </ConfirmContext.Provider>
  );
}

/**
 * Ask for confirmation. Resolves `true` only if the operator confirmed.
 *
 * Outside a provider it resolves `true`: a unit test that mounts one view in
 * isolation should exercise that view's behaviour, not fail on missing shell
 * context. Every real mount is inside the provider.
 */
export function useConfirm(): (request: ConfirmRequest) => Promise<boolean> {
  const confirm = useContext(ConfirmContext);
  return useMemo(() => confirm ?? (() => Promise.resolve(true)), [confirm]);
}

const confirmIcons: Record<ConfirmTone, IconName> = {
  danger: 'warning',
  warning: 'alert',
  neutral: 'info',
};

function ConfirmDialog({
  request,
  onConfirm,
  onCancel,
}: {
  request: ConfirmRequest;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const tone = request.tone ?? 'danger';
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    openerRef.current = document.activeElement;
    if (!dialog.open) dialog.showModal();
    // Focus lands on Cancel, not the destructive action: Enter should not
    // destroy anything, and the operator has to travel to confirm.
    dialog.querySelector<HTMLElement>('[data-confirm-cancel]')?.focus({ preventScroll: true });
    const cancel = (event: Event) => {
      event.preventDefault();
      onCancel();
    };
    dialog.addEventListener('cancel', cancel);
    return () => {
      dialog.removeEventListener('cancel', cancel);
      if (dialog.open) dialog.close();
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
    // The dialog stays mounted while queued requests advance, so this runs once for the queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    // A queued request replaces the copy in the existing modal. Return focus to Cancel for the
    // new request without closing the modal or restoring focus to the original opener in between.
    if (dialogRef.current?.open) {
      dialogRef.current.querySelector<HTMLElement>('[data-confirm-cancel]')?.focus({ preventScroll: true });
    }
  }, [request]);

  return (
    <dialog
      ref={dialogRef}
      className="director-dialog director-confirm"
      data-tone={tone}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={request.body || request.consequence ? bodyId : undefined}
    >
      <div className="director-confirm-body">
        <span className="director-confirm-icon" aria-hidden="true">
          <Icon name={confirmIcons[tone]} size={20} />
        </span>
        <div className="director-confirm-text">
          <h2 id={titleId}>{request.title}</h2>
          <div id={bodyId}>
            {request.body && <p>{request.body}</p>}
            {request.consequence && <p className="director-confirm-consequence">{request.consequence}</p>}
          </div>
        </div>
      </div>
      <div className="director-dialog-footer">
        <Button variant="secondary" onClick={onCancel} data-confirm-cancel>
          {request.cancelLabel ?? 'Cancel'}
        </Button>
        <Button ref={confirmRef} variant={tone === 'danger' ? 'danger-solid' : 'primary'} onClick={onConfirm}>
          {request.confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
