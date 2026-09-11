/**
 * The explicit incident/recovery confirmation for high-impact actions while live (#1016).
 *
 * Rendered wherever a guarded action can originate. The hook owns the pending action;
 * this dialog only shows its consequences and routes the operator's decision back.
 */

import { ConfirmDialog } from '@qbsheet/ui';
import type { GuardedAction } from '../model/lifecycle';

export function LiveOverrideDialog({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: { action: GuardedAction; proceed: () => void } | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      isOpen={pending !== null}
      title={pending ? `Override live guard: ${pending.action.label}?` : 'Override live guard?'}
      confirmLabel="Override and proceed"
      confirmVariant="danger"
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {pending ? (
        <>
          <p>{pending.action.consequences}</p>
          <p className="faint">This override is written to the audit history.</p>
        </>
      ) : null}
    </ConfirmDialog>
  );
}
