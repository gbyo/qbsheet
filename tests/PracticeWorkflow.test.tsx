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
  const right = within(prompt).getByLabelText('Greenwood starters');
  const start = within(prompt).getByText('Start game');

  expect(screen.getByText(/Start Gibson, Jeremy, Owen and Lachlan for Ninety Six/)).toBeTruthy();
  expect(screen.queryByText(/Tick|untick|Reorder starters/i)).toBeNull();

  fireEvent.click(within(left).getByRole('button', { name: 'Start Gibson' }));
  fireEvent.click(within(right).getByRole('button', { name: 'Start Tucker' }));
  expect(start.hasAttribute('disabled')).toBe(true);

  for (const name of ['Jeremy', 'Owen', 'Olivia'])
    fireEvent.click(within(left).getByRole('button', { name: `Start ${name}` }));
  for (const name of ['Phillip', 'Efren', 'Bella'])
    fireEvent.click(within(right).getByRole('button', { name: `Start ${name}` }));
  expect(start.hasAttribute('disabled')).toBe(false);
  fireEvent.click(start);

  expect(screen.getByLabelText('Starting lineups')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Bench Olivia and start Lachlan.');

  fireEvent.click(within(left).getByRole('button', { name: 'Bench Olivia' }));
  fireEvent.click(within(left).getByRole('button', { name: 'Start Lachlan' }));
  fireEvent.click(within(right).getByRole('button', { name: 'Bench Bella' }));
  fireEvent.click(within(right).getByRole('button', { name: 'Start Valerie' }));
  fireEvent.click(start);

  await vi.waitFor(() => expect(screen.getByText('Reader: “Power, Gibson on Ninety Six.”')).toBeTruthy());
  // The situation is what the room did; the instruction is what to record. Both are on screen — a
  // guided step whose action has to be guessed at was the whole complaint about the old overlay.
  expect(screen.getByText('Press 1, then P, for Gibson on the Ninety Six side.')).toBeTruthy();
  // The hint is the extra — which control, and what the neighbouring ones would have meant instead —
  // and it stays folded away until somebody asks for it.
  const hint = screen.getByText('Show me where').closest('details') as HTMLDetailsElement;
  expect(hint.open).toBe(false);
  expect(within(hint).getByText(/P is power/)).toBeTruthy();
  expect(screen.queryByLabelText('Starting lineups')).toBeNull();
});

test('the right four in the wrong seats names the seat, the player in it, and who belongs there', async () => {
  render(<PracticeScreen onHome={vi.fn()} />);
  const prompt = screen.getByLabelText('Starting lineups');
  const left = within(prompt).getByLabelText('Ninety Six starters');
  const right = within(prompt).getByLabelText('Greenwood starters');
  const start = within(prompt).getByText('Start game');

  // Start the right names in the wrong order so practice can teach the real seat-order controls.
  for (const name of ['Lachlan', 'Owen', 'Jeremy', 'Gibson'])
    fireEvent.click(within(left).getByRole('button', { name: `Start ${name}` }));
  for (const name of ['Tucker', 'Phillip', 'Efren', 'Valerie'])
    fireEvent.click(within(right).getByRole('button', { name: `Start ${name}` }));
  fireEvent.click(start);

  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('Use the ↑/↓ controls to put Gibson, Jeremy, Owen and Lachlan in that order.');
  expect(screen.getByLabelText('Starting lineups')).toBeTruthy();

  // Bench the wrong order, then start the names in the order the guide lists.
  for (const name of ['Lachlan', 'Owen', 'Jeremy', 'Gibson'])
    fireEvent.click(within(left).getByRole('button', { name: `Bench ${name}` }));
  for (const name of ['Gibson', 'Jeremy', 'Owen', 'Lachlan'])
    fireEvent.click(within(left).getByRole('button', { name: `Start ${name}` }));
  fireEvent.click(start);

  await vi.waitFor(() => expect(screen.getByText('Reader: “Power, Gibson on Ninety Six.”')).toBeTruthy());
  const names = (team: string) =>
    [...screen.getByLabelText(team).querySelectorAll('.scorer-player-name')].map((node) => node.textContent);
  expect(names('Ninety Six')).toEqual(['Gibson', 'Jeremy', 'Owen', 'Lachlan']);
});

test('practice restores the guide checkpoint after the screen is remounted', async () => {
  const first = render(<PracticeScreen onHome={vi.fn()} />);
  const prompt = screen.getByLabelText('Starting lineups');
  const left = within(prompt).getByLabelText('Ninety Six starters');
  const right = within(prompt).getByLabelText('Greenwood starters');
  for (const name of ['Gibson', 'Jeremy', 'Owen', 'Lachlan'])
    fireEvent.click(within(left).getByRole('button', { name: `Start ${name}` }));
  for (const name of ['Tucker', 'Phillip', 'Efren', 'Valerie'])
    fireEvent.click(within(right).getByRole('button', { name: `Start ${name}` }));
  fireEvent.click(within(prompt).getByText('Start game'));

  await vi.waitFor(() => expect(screen.getByText('Reader: “Power, Gibson on Ninety Six.”')).toBeTruthy());
  first.unmount();
  render(<PracticeScreen onHome={vi.fn()} />);

  expect(screen.queryByLabelText('Starting lineups')).toBeNull();
  expect(screen.getByText('Reader: “Power, Gibson on Ninety Six.”')).toBeTruthy();
  expect(screen.getByText('Press 1, then P, for Gibson on the Ninety Six side.')).toBeTruthy();
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

test('the one word of status says Practice, and no banner repeats what the title says', () => {
  render(<PracticeScreen onHome={vi.fn()} />);

  // "Connected" would be a claim about a server nobody asked — practice has no tournament control.
  const status = screen.getByLabelText('Practice. Show connection detail');
  expect(status.textContent).toBe('Practice');
  expect(screen.queryByText('Connected')).toBeNull();
  // The header already reads QBSheet Practice, so the strip that used to say it again is gone.
  expect(screen.queryByText(/Local only — not sent or added to Recent Games/)).toBeNull();
});
