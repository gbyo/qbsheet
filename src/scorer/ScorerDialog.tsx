/**
 * The shell every infrequent action opens in.
 *
 * The actual native dialog behaviour is shared with the app shell. Keeping this adapter preserves the
 * scorer-specific sizing and body markup without giving the scoresheet a second modal implementation.
 */
import { ReactNode } from 'react';
import NativeDialog from '../app/NativeDialog';

export interface IScorerDialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /**
   * False while this dialog is holding an operation that can still fail, which closes every route
   * out — Escape, the close button, the platform's own close request. See `NativeDialog`.
   */
  dismissible?: boolean;
}

export default function ScorerDialog(props: IScorerDialogProps) {
  const { title, onClose, children, wide = false, dismissible = true } = props;
  return (
    <NativeDialog title={title} onClose={onClose} className={wide ? 'is-wide' : ''} dismissible={dismissible}>
      {children}
    </NativeDialog>
  );
}
