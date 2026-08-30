/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import ScorerNoticeCenter, { IScorerNotice } from '../src/scorer/ScorerNoticeCenter';

afterEach(() => {
  vi.useRealTimers();
});

function renderCenter(notices: IScorerNotice[]) {
  return render(<ScorerNoticeCenter notices={notices} />);
}

describe('ScorerNoticeCenter', () => {
  test('shows only the highest-priority expanded notice and keeps the rest discoverable', () => {
    renderCenter([
      { id: 'offline', tone: 'warning', message: 'Offline — keep scoring.', persistent: true, priority: 40 },
      { id: 'save', tone: 'error', title: 'Save failed', body: 'Download a backup.', persistent: true, priority: 1 },
    ]);

    expect(screen.getByText('Save failed')).toBeTruthy();
    expect(screen.queryByText('Offline — keep scoring.')).toBeNull();
    expect(screen.getByRole('button', { name: '1 more' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '1 more' }));
    expect(screen.getByText('Offline — keep scoring.')).toBeTruthy();
  });

  test('dismissal hides a persistent surface but keeps its issue available', () => {
    const notice: IScorerNotice = {
      id: 'offline',
      tone: 'warning',
      message: 'Offline — keep scoring.',
      persistent: true,
    };
    renderCenter([notice]);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }));
    expect(screen.queryByText('Offline — keep scoring.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Issues 1' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Issues 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show notice' }));
    expect(screen.getByText('Offline — keep scoring.')).toBeTruthy();
  });

  test('transient receipts expire without changing focus', () => {
    vi.useFakeTimers();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    renderCenter([{ id: 'receipt', tone: 'info', message: 'Saved', transient: true, autoDismissMs: 3000 }]);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText('Saved')).toBeNull();
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  test('does not restart a transient receipt timer when the same notice rerenders', () => {
    vi.useFakeTimers();
    const { rerender } = renderCenter([{ id: 'receipt', tone: 'info', message: 'Saved', transient: true, autoDismissMs: 3000 }]);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    rerender(<ScorerNoticeCenter notices={[{ id: 'receipt', tone: 'info', message: 'Saved', transient: true, autoDismissMs: 3000 }]} />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText('Saved')).toBeNull();
  });
});
