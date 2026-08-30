import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ExportDialog } from './OperationsDialogs';

describe('ExportDialog', () => {
  test('keeps the backup available and omits forms the host cannot produce', () => {
    render(<ExportDialog onDownloadQbjBackup={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'Export / backup' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download QBJ backup' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download current QBJ' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download legacy match-only QBJ' })).not.toBeInTheDocument();
  });

  test('runs the selected export and closes the ordinary dialog', () => {
    const backup = vi.fn();
    const partial = vi.fn();
    const onClose = vi.fn();
    render(
      <ExportDialog
        onDownloadQbjBackup={backup}
        onDownloadPartialQbj={partial}
        onDownloadLegacyQbj={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download current QBJ' }));
    expect(partial).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
