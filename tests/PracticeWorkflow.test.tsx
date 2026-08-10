/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import PracticeScreen, { practiceGameKey } from '../src/practice/PracticeScreen';
import { clearGame } from '../src/scorer/GameSession';

function installLocalStorage() {
  let store: Record<string, string> = {};
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = String(value);
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    },
  });
}

beforeEach(() => {
  installLocalStorage();
  clearGame(practiceGameKey);
});

afterEach(() => {
  clearGame(practiceGameKey);
  cleanup();
});

test('practice requires its named starters, keeps mistakes editable, and advances after a correction', async () => {
  render(<PracticeScreen onHome={vi.fn()} />);
  const prompt = screen.getByLabelText('Starting lineups');
  const left = within(prompt).getByLabelText('Ninety Six starters');
  const right = within(prompt).getByLabelText('Riverton Prep starters');
  const start = within(prompt).getByText('Start game');

  fireEvent.click(within(left).getByLabelText('Gibson'));
  fireEvent.click(within(right).getByLabelText('Tucker'));
  expect(start.hasAttribute('disabled')).toBe(true);

  for (const name of ['Jeremy', 'Owen', 'Olivia']) fireEvent.click(within(left).getByLabelText(name));
  for (const name of ['Sam', 'Efren', 'Bella']) fireEvent.click(within(right).getByLabelText(name));
  expect(start.hasAttribute('disabled')).toBe(false);
  fireEvent.click(start);

  expect(screen.getByLabelText('Starting lineups')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('four starters named in the practice instruction');

  fireEvent.click(within(left).getByLabelText('Olivia'));
  fireEvent.click(within(left).getByLabelText('Lachlan'));
  fireEvent.click(within(right).getByLabelText('Bella'));
  fireEvent.click(within(right).getByLabelText('Valerie'));
  fireEvent.click(start);

  await vi.waitFor(() => expect(screen.getByText('Record Gibson’s power.')).toBeTruthy());
  expect(screen.queryByLabelText('Starting lineups')).toBeNull();
});
