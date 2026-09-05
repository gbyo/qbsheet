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
    window.localStorage.removeItem(updateNoticeDismissalKey);
    updateState.mockReturnValue({ available: true, applying: false });
  });

  test('offers a quiet dismiss action while keeping the update available', () => {
    render(<UpdateNotice />);

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('A new version of QBSheet is ready');
    expect(notice).toHaveAttribute('data-update-presentation', 'compact');
    expect(notice).not.toHaveClass('update-notice-hero');
    expect(screen.getByRole('button', { name: 'Update now' })).not.toHaveClass('is-primary');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.getByRole('status')).toHaveTextContent('Update available');
    expect(screen.queryByText('A new version of QBSheet is ready')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show details' })).toBeInTheDocument();
    expect(window.localStorage.getItem(updateNoticeDismissalKey)).toBe('1');
  });

  test('uses the explicit homepage hero presentation until it is dismissed', () => {
    render(<UpdateNotice presentation="hero" />);

    let notice = screen.getByRole('status');
    expect(notice).toHaveAttribute('data-update-presentation', 'hero');
    expect(notice).toHaveClass('update-notice-hero');
    expect(screen.getByRole('button', { name: 'Update now' })).toHaveClass('is-primary');

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    notice = screen.getByRole('status');
    expect(notice).toHaveAttribute('data-update-presentation', 'quiet');
    expect(notice).not.toHaveClass('update-notice-hero');
    expect(window.localStorage.getItem(updateNoticeDismissalKey)).toBe('1');

    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));

    notice = screen.getByRole('status');
    expect(notice).toHaveAttribute('data-update-presentation', 'hero');
    expect(notice).toHaveClass('update-notice-hero');
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect(window.localStorage.getItem(updateNoticeDismissalKey)).toBeNull();
  });

  test('does not render when there is no waiting update', () => {
    updateState.mockReturnValue({ available: false, applying: false });
    const { container } = render(<UpdateNotice />);

    expect(container).toBeEmptyDOMElement();
  });
});
