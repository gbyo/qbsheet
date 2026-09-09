/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { Tabs } from '../src/director/components/Filters';

afterEach(cleanup);

type View = 'review' | 'games' | 'history';

function TabsHarness() {
  const [value, setValue] = useState<View>('review');
  return (
    <Tabs
      value={value}
      onChange={setValue}
      ariaLabel="Results views"
      tabs={[
        { value: 'review', label: 'Review' },
        { value: 'games', label: 'Games' },
        { value: 'history', label: 'History' },
      ]}
    />
  );
}

describe('Director Tabs keyboard navigation', () => {
  test('moves focus together with selection for arrow, Home, and End keys', () => {
    render(<TabsHarness />);
    const review = screen.getByRole('tab', { name: 'Review' });
    const games = screen.getByRole('tab', { name: 'Games' });
    const history = screen.getByRole('tab', { name: 'History' });

    review.focus();
    fireEvent.keyDown(review, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(games);
    expect(games.getAttribute('aria-selected')).toBe('true');
    expect(review.tabIndex).toBe(-1);

    fireEvent.keyDown(games, { key: 'End' });
    expect(document.activeElement).toBe(history);
    expect(history.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(history, { key: 'Home' });
    expect(document.activeElement).toBe(review);
    expect(review.getAttribute('aria-selected')).toBe('true');
  });

  test('wraps focus when moving left from the first tab', () => {
    render(<TabsHarness />);
    const review = screen.getByRole('tab', { name: 'Review' });
    const history = screen.getByRole('tab', { name: 'History' });

    review.focus();
    fireEvent.keyDown(review, { key: 'ArrowLeft' });

    expect(document.activeElement).toBe(history);
    expect(history.getAttribute('aria-selected')).toBe('true');
  });
});
