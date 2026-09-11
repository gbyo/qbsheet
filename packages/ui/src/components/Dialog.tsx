/**
 * A confirmation the operator has to answer.
 *
 * React Aria's Modal and Dialog handle what `window.confirm` handles badly and a hand-rolled
 * overlay handles not at all: focus moves into the dialog and is trapped there, Escape closes
 * it, focus returns to whatever opened it, the page behind is inert and hidden from assistive
 * technology, and the title is wired to the dialog as its accessible name.
 *
 * `window.confirm` also blocks the whole webview and cannot be styled or tested; it has no place
 * in an application an operator uses under time pressure.
 */

import type { ReactNode } from 'react';
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { Button, type ButtonVariant } from './Button';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  /** What will happen. Plain, specific, and about consequences rather than mechanics. */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` for anything that destroys something the operator cannot get back. */
  confirmVariant?: ButtonVariant;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      // Fires for a dismissal — Escape or a press outside — and not when the caller flips
      // `isOpen` itself, so this is only ever the cancel path.
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      isDismissable
      className="qbs-modal-overlay"
    >
      <Modal className="qbs-modal">
        <AriaDialog className="qbs-dialog" role="alertdialog">
          <Heading slot="title" className="qbs-dialog__title">
            {title}
          </Heading>
          {children ? <div className="qbs-dialog__body">{children}</div> : null}
          <div className="qbs-dialog__actions">
            {/*
             * Cancel first in the DOM so it is the first thing keyboard focus reaches, and so a
             * destructive confirmation is never one stray Return away.
             *
             * Neither button calls the render-prop `close()`. Closing from inside also fires
             * `onOpenChange(false)`, which is the dismissal path — so confirming would have
             * reported a cancellation as well. The caller owns `isOpen` and closes it.
             */}
            <Button variant="secondary" onPress={onCancel}>
              {cancelLabel}
            </Button>
            <Button variant={confirmVariant} onPress={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
