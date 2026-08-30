import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import UpdateNotice, { updateNoticeDismissalKey } from './UpdateNotice';
import { useAppUpdate } from './useAppUpdate';

vi.mock('./useAppUpdate', () => ({
  useAppUpdate: vi.fn(),
}));

const updateState = vi.mocked(useAppUpdate);

describe('UpdateNotice', () => {
  beforeEach(() => {
    updateState.mockReturnValue({ available: true, applying: false });
  });

  test('offers a quiet dismiss action while keeping the update available', () => {
    render(<UpdateNotice />);

    expect(screen.getByRole('status')).toHaveTextContent('A new version of QBSheet is ready');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.getByRole('status')).toHaveTextContent('Update available');
    expect(screen.queryByText('A new version of QBSheet is ready')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show details' })).toBeInTheDocument();
    expect(window.localStorage.getItem(updateNoticeDismissalKey)).toBe('1');
  });

  test('does not render when there is no waiting update', () => {
    updateState.mockReturnValue({ available: false, applying: false });
    const { container } = render(<UpdateNotice />);

    expect(container).toBeEmptyDOMElement();
  });
});
