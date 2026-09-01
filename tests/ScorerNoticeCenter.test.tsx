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
      {
        id: 'save',
        tone: 'error',
        title: 'Save failed',
        body: 'Download a backup.',
        persistent: true,
        priority: 1,
      },
    ]);

    expect(screen.getByText('Save failed')).toBeTruthy();
    expect(screen.queryByText('Offline — keep scoring.')).toBeNull();
    expect(screen.getByRole('button', { name: '1 more' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '1 more' }));
    expect(screen.getByText('Offline — keep scoring.')).toBeTruthy();
  });

  test('renders the dismiss glyph only through CSS', () => {
    renderCenter([
      {
        id: 'recovery',
        tone: 'info',
        message: 'Recovered the in-progress game.',
        dismissGlyph: true,
        dismissLabel: 'Dismiss recovery notice',
      },
    ]);

    const dismiss = screen.getByRole('button', { name: 'Dismiss recovery notice' });
    expect(dismiss.textContent).toBe('');
    expect(dismiss.querySelector('span')).toBeNull();
  });

  test('dismissal removes the notice region when nothing remains', () => {
    const { container } = renderCenter([{ id: 'note', tone: 'info', message: 'Heads up.' }]);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }));

    expect(screen.queryByText('Heads up.')).toBeNull();
    expect(container.querySelector('.scorer-notice-region')).toBeNull();
  });

  test('dismissal hides a persistent surface but keeps its issue available in a compact row', () => {
    const notice: IScorerNotice = {
      id: 'offline',
      tone: 'warning',
      message: 'Offline — keep scoring.',
      persistent: true,
    };
    const { container } = renderCenter([notice]);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }));
    expect(screen.queryByText('Offline — keep scoring.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Issues 1' })).toBeTruthy();
    expect(container.querySelector('.scorer-notice-slot')).toBeNull();

    const region = container.querySelector('.scorer-notice-region');
    expect(region?.classList.contains('is-compact')).toBe(true);
    expect((region as HTMLElement).style.minHeight).toBe('auto');

    fireEvent.click(screen.getByRole('button', { name: 'Issues 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show notice' }));
    expect(screen.getByText('Offline — keep scoring.')).toBeTruthy();
  });

  test('transient receipts expire without changing focus or leaving a notice region', () => {
    vi.useFakeTimers();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const { container } = renderCenter([
      { id: 'receipt', tone: 'info', message: 'Saved', transient: true, autoDismissMs: 3000 },
    ]);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText('Saved')).toBeNull();
    expect(container.querySelector('.scorer-notice-region')).toBeNull();
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  test('does not restart a transient receipt timer when the same notice rerenders', () => {
    vi.useFakeTimers();
    const { rerender } = renderCenter([
      { id: 'receipt', tone: 'info', message: 'Saved', transient: true, autoDismissMs: 3000 },
    ]);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    rerender(
      <ScorerNoticeCenter
        notices={[{ id: 'receipt', tone: 'info', message: 'Saved', transient: true, autoDismissMs: 3000 }]}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText('Saved')).toBeNull();
  });
});
