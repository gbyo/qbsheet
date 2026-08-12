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
}

export default function ScorerDialog(props: IScorerDialogProps) {
  const { title, onClose, children, wide = false } = props;
  return (
    <NativeDialog title={title} onClose={onClose} className={wide ? 'is-wide' : ''}>
      {children}
    </NativeDialog>
  );
}
