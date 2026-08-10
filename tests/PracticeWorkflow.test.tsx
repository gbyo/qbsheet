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
  expect(screen.getByRole('alert').textContent).toContain('open Show me where');

  fireEvent.click(within(left).getByLabelText('Olivia'));
  fireEvent.click(within(left).getByLabelText('Lachlan'));
  fireEvent.click(within(right).getByLabelText('Bella'));
  fireEvent.click(within(right).getByLabelText('Valerie'));
  fireEvent.click(start);

  await vi.waitFor(() => expect(screen.getByText('Reader: “Power, Gibson on Ninety Six.”')).toBeTruthy());
  // The situation is what the room did; the instruction is what to record. Both are on screen — a
  // guided step whose action has to be guessed at was the whole complaint about the old overlay.
  expect(screen.getByText('Press P on Gibson’s row, on the Ninety Six side.')).toBeTruthy();
  // The hint is the extra — which control, and what the neighbouring ones would have meant instead —
  // and it stays folded away until somebody asks for it.
  const hint = screen.getByText('Show me where').closest('details') as HTMLDetailsElement;
  expect(hint.open).toBe(false);
  expect(within(hint).getByText(/P is the power/)).toBeTruthy();
  expect(screen.queryByLabelText('Starting lineups')).toBeNull();
});

test('practice restores the guide checkpoint after the screen is remounted', async () => {
  const first = render(<PracticeScreen onHome={vi.fn()} />);
  const prompt = screen.getByLabelText('Starting lineups');
  const left = within(prompt).getByLabelText('Ninety Six starters');
  const right = within(prompt).getByLabelText('Riverton Prep starters');
  for (const name of ['Gibson', 'Jeremy', 'Owen', 'Lachlan']) fireEvent.click(within(left).getByLabelText(name));
  for (const name of ['Tucker', 'Sam', 'Efren', 'Valerie']) fireEvent.click(within(right).getByLabelText(name));
  fireEvent.click(within(prompt).getByText('Start game'));

  await vi.waitFor(() => expect(screen.getByText('Reader: “Power, Gibson on Ninety Six.”')).toBeTruthy());
  first.unmount();
  render(<PracticeScreen onHome={vi.fn()} />);

  expect(screen.queryByLabelText('Starting lineups')).toBeNull();
  expect(screen.getByText('Reader: “Power, Gibson on Ninety Six.”')).toBeTruthy();
  expect(screen.getByText('Press P on Gibson’s row, on the Ninety Six side.')).toBeTruthy();
  expect(screen.getByText('Show me where')).toBeTruthy();
});

test('restart and leave are protected from an accidental single click', () => {
  const onHome = vi.fn();
  render(<PracticeScreen onHome={onHome} />);

  fireEvent.click(screen.getByText('Restart'));
  expect(screen.getByText('Restart from the lineup? This practice run will be cleared.')).toBeTruthy();
  expect(screen.getByText('Keep practicing')).toBeTruthy();
  expect(screen.getByLabelText('Starting lineups')).toBeTruthy();

  fireEvent.click(screen.getByText('Keep practicing'));
  fireEvent.click(screen.getByText('Leave practice'));
  expect(onHome).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Leave now'));
  expect(onHome).toHaveBeenCalledOnce();
});
