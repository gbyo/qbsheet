/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { TabGroup, TabPanel, Tabs } from '../src/director/components/Filters';

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

function PairedTabs({ id, label = 'History' }: { id?: string; label?: string }) {
  return (
    <TabGroup id={id}>
      <Tabs
        value="history"
        onChange={() => undefined}
        ariaLabel={`${label} views`}
        tabs={[{ value: 'history', label }]}
      />
      <TabPanel value="history">{label} panel</TabPanel>
    </TabGroup>
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

  test('scopes IDs and ARIA relationships to each tab group', () => {
    render(
      <>
        <PairedTabs />
        <PairedTabs />
      </>,
    );

    const ids = [...document.querySelectorAll<HTMLElement>('[id]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const tablist of screen.getAllByRole('tablist')) {
      const tab = within(tablist).getByRole('tab');
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      expect(panel).not.toBeNull();
      expect(panel).toHaveAttribute('aria-labelledby', tab.id);
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
    }
  });

  test('keeps a generated namespace stable when labels and counts change', () => {
    const view = render(<PairedTabs label="History" />);
    const initialIds = [...document.querySelectorAll<HTMLElement>('[id]')].map((node) => node.id);

    view.rerender(<PairedTabs label="History (2)" />);

    expect([...document.querySelectorAll<HTMLElement>('[id]')].map((node) => node.id)).toEqual(initialIds);
  });
});
