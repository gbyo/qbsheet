/**
 * The three screens, rendered.
 *
 * A smoke test rather than a design test: it checks that an operator with a loaded file can see
 * the tournament, pick teams for a room, and reach the results screen, and that nothing on screen
 * claims a state QBBridge cannot know.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetNativeHost } from '../model/native';
import { storageKey } from '../model/persistence';
import { yftFixtureText } from '../tests/fixture';
import BridgeApp from './BridgeApp';

let openedFixture = yftFixtureText();

function installFakeTauri(): void {
  globalThis.localStorage.clear();
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {
      invoke: async (command: string) => {
        if (command === 'open_yellowfruit_file') {
          return { path: '/tournaments/spring.yft', contents: openedFixture };
        }
        if (command === 'relay_request') return { status: 503, body: '{}' };
        throw new Error(command);
      },
    },
  });
  resetNativeHost();
}

/** Choose a team through the combo box, the way an operator does. */
async function pickTeam(user: UserEvent, label: string, name: string): Promise<void> {
  const input = screen.getByRole('combobox', { name: label });
  await user.clear(input);
  await user.type(input, name);
  const listbox = await screen.findByRole('listbox');
  // Pool context is rendered beside the team name, so the option's accessible name includes it.
  await user.click(within(listbox).getByRole('option', { name: new RegExp(`^${name}(?: |$)`) }));
}

beforeEach(installFakeTauri);
afterEach(() => {
  vi.restoreAllMocks();
  openedFixture = yftFixtureText();
  Reflect.deleteProperty(globalThis as Record<string, unknown>, '__TAURI_INTERNALS__');
  resetNativeHost();
});

describe('the shell', () => {
  test('opens on the tournament panel and says what is missing', () => {
    render(<BridgeApp />);
    // The wordmark reads "QBSheet Bridge" on its own, so nothing repeats it in text and the
    // heading still has exactly one accessible name.
    const heading = screen.getByRole('heading', { name: 'QBSheet Bridge' });
    expect(within(heading).getByAltText('QBSheet Bridge')).toHaveClass('wordmark');
    expect(heading.textContent).toBe('');
    expect(screen.getByText('No YellowFruit file loaded')).toBeInTheDocument();
    expect(screen.getByText('Relay not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open YellowFruit File' })).toBeInTheDocument();
  });

  test('a loaded file fills in the tournament and the format', async () => {
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('button', { name: 'Open YellowFruit File' }));

    expect(await screen.findByText('12 teams · 48 players')).toBeInTheDocument();
    // One line, structural throughout: the rule-set name is on it as a label, next to the
    // values that actually decide the scoring.
    expect(
      screen.getByText('NaqtUntimed · Untimed · 20 max tossups · 15 / 10 / -5 · 30-point bonuses, 3 parts'),
    ).toBeInTheDocument();
    // Reloading is offered, and it is the only way roster edits arrive.
    expect(screen.getByRole('button', { name: 'Reload YellowFruit File' })).toBeInTheDocument();
  });

  test('a loaded success notice can be dismissed and does not return when changing tabs', async () => {
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('button', { name: 'Open YellowFruit File' }));

    const loadedNotice = await screen.findByText(/Loaded 2025 MEQBA Season Opener/);
    expect(loadedNotice).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss notice' }));
    expect(screen.queryByText(/Loaded 2025 MEQBA Season Opener/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Help' }));
    await user.click(screen.getByRole('tab', { name: 'Tournament' }));
    expect(screen.queryByText(/Loaded 2025 MEQBA Season Opener/)).not.toBeInTheDocument();
  });

  test('a room takes two teams and shows its pairing code', async () => {
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('button', { name: 'Open YellowFruit File' }));
    await screen.findByText('12 teams · 48 players');

    await user.click(screen.getByRole('tab', { name: 'Rooms' }));
    await user.click(screen.getByRole('button', { name: '+ Room' }));

    await pickTeam(user, 'Left team in Room 1', 'Cony');
    await pickTeam(user, 'Right team in Room 1', 'Deering');

    const row = screen.getByRole('row', { name: /Room 1/ });
    expect(within(row).getByText(/^[0-9]{8}$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish Room Setup' })).toBeDisabled();
    expect(within(row).getAllByText('Not published')).toHaveLength(2);
    await user.click(within(row).getByRole('button', { name: 'New code' }));
    expect(within(row).getByText(/Pending — publish to activate:/)).toBeInTheDocument();
    expect(within(row).getAllByText(/^[0-9]{8}$/)).toHaveLength(2);
    // Publishing needs a relay; without one the button does not pretend otherwise.
    expect(screen.getByRole('button', { name: /Publish Round 1/ })).toBeDisabled();
  });

  test('groups rounds and exposes the selected phase pools as read-only context', async () => {
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('button', { name: 'Open YellowFruit File' }));
    await screen.findByText('12 teams · 48 players');
    await user.click(screen.getByRole('tab', { name: 'Rooms' }));

    const roundSelect = screen.getByLabelText('Round');
    expect(roundSelect.querySelector('optgroup[label="Prelims"]')?.querySelectorAll('option')).toHaveLength(
      5,
    );
    expect(roundSelect.querySelector('optgroup[label="Playoffs"]')?.querySelectorAll('option')).toHaveLength(
      3,
    );
    expect(screen.getByLabelText('Team pool')).toHaveValue('');
    expect(screen.getByText(/Teams in this file:.*Cony/)).toBeInTheDocument();
    await user.selectOptions(roundSelect, 'Phase_Playoffs__round_7');
    expect(screen.getAllByText(/carryover/)).toHaveLength(2);
    expect(screen.getByText(/does not calculate standings or advancement/)).toBeInTheDocument();
  });

  test('warns about a cross-pool override without disabling manual pairing', async () => {
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('button', { name: 'Open YellowFruit File' }));
    await screen.findByText('12 teams · 48 players');
    await user.click(screen.getByRole('tab', { name: 'Rooms' }));
    await user.click(screen.getByRole('button', { name: '+ Room' }));

    await pickTeam(user, 'Left team in Room 1', 'Cony');
    await pickTeam(user, 'Right team in Room 1', 'Deering');

    expect(screen.getByText(/crosses pools/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Publish Round 1/ })).toBeDisabled();
  });

  test('warns about the things a person mistypes', async () => {
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('button', { name: 'Open YellowFruit File' }));
    await screen.findByText('12 teams · 48 players');
    await user.click(screen.getByRole('tab', { name: 'Rooms' }));
    await user.click(screen.getByRole('button', { name: '+ Room' }));

    expect(screen.getByText('This room has no matchup yet.')).toBeInTheDocument();
    await pickTeam(user, 'Left team in Room 1', 'Cony');
    await pickTeam(user, 'Right team in Room 1', 'Cony');
    expect(screen.getByText('Both sides are the same team.')).toBeInTheDocument();
  });

  test('switching rounds keeps each round\u2019s own pairings, with no dialog in the way', async () => {
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('button', { name: 'Open YellowFruit File' }));
    await screen.findByText('12 teams \u00b7 48 players');
    await user.click(screen.getByRole('tab', { name: 'Rooms' }));
    await user.click(screen.getByRole('button', { name: '+ Room' }));
    await pickTeam(user, 'Left team in Room 1', 'Cony');

    const rounds = screen.getByLabelText('Round');
    await user.selectOptions(rounds, 'Phase_Prelims__round_5');

    // No confirmation, because nothing is being discarded. Round 5 is simply empty.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Left team in Room 1' })).toHaveValue(''),
    );

    // Enter a different matchup for round 5, then go back. Round 1's entry is still there.
    await pickTeam(user, 'Left team in Room 1', 'Wells');
    await user.selectOptions(rounds, 'Phase_Prelims__round_1');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Left team in Room 1' })).toHaveValue('Cony'),
    );
    await user.selectOptions(rounds, 'Phase_Prelims__round_5');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Left team in Room 1' })).toHaveValue('Wells'),
    );

    // The room and its pairing code survive all of it.
    expect(screen.getByRole('row', { name: /Room 1/ })).toBeInTheDocument();
  });

  test('the round control reports how many games the selected round has planned', async () => {
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('button', { name: 'Open YellowFruit File' }));
    await screen.findByText('12 teams \u00b7 48 players');
    await user.click(screen.getByRole('tab', { name: 'Rooms' }));
    await user.click(screen.getByRole('button', { name: '+ Room' }));
    await user.click(screen.getByRole('button', { name: '+ Room' }));

    expect(screen.getByTestId('round-progress')).toHaveTextContent('Round 1 \u00b7 0 games planned');
    await pickTeam(user, 'Left team in Room 1', 'Cony');
    // One side is not a game.
    expect(screen.getByTestId('round-progress')).toHaveTextContent('Round 1 \u00b7 0 games planned');
    await pickTeam(user, 'Right team in Room 1', 'Deering');
    await waitFor(() =>
      expect(screen.getByTestId('round-progress')).toHaveTextContent('Round 1 \u00b7 1 game planned'),
    );
    // Clearing a side removes the game again.
    await user.click(screen.getByRole('button', { name: 'Clear Left team in Room 1' }));
    await waitFor(() =>
      expect(screen.getByTestId('round-progress')).toHaveTextContent('Round 1 \u00b7 0 games planned'),
    );
  });

  test('an unused room never makes a planned round look incomplete', async () => {
    // Three configured rooms, one planned game: a bye-like round with idle rooms. The count is
    // descriptive — there is no denominator to fall short of.
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('button', { name: 'Open YellowFruit File' }));
    await screen.findByText('12 teams \u00b7 48 players');
    await user.click(screen.getByRole('tab', { name: 'Rooms' }));
    await user.click(screen.getByRole('button', { name: '+ Room' }));
    await user.click(screen.getByRole('button', { name: '+ Room' }));
    await user.click(screen.getByRole('button', { name: '+ Room' }));

    await pickTeam(user, 'Left team in Room 1', 'Cony');
    await pickTeam(user, 'Right team in Room 1', 'Deering');
    await waitFor(() =>
      expect(screen.getByTestId('round-progress')).toHaveTextContent('Round 1 \u00b7 1 game planned'),
    );
    // No fraction anywhere: neither the selector count nor the per-round chips name a denominator.
    expect(screen.getByTestId('round-progress').textContent).not.toContain('/');
    expect(screen.getByTestId('phase-progress')).toHaveTextContent('R1 1 game');
    expect(screen.getByTestId('phase-progress').textContent).not.toContain('/');

    // Adding another idle room changes nothing about the planned game.
    await user.click(screen.getByRole('button', { name: '+ Room' }));
    await waitFor(() =>
      expect(screen.getByTestId('round-progress')).toHaveTextContent('Round 1 \u00b7 1 game planned'),
    );

    // A playoff phase with fewer rooms in use shows the same descriptive count.
    await user.selectOptions(screen.getByLabelText('Round'), 'Phase_Playoffs__round_7');
    await waitFor(() =>
      expect(screen.getByTestId('round-progress')).toHaveTextContent('Round 7 \u00b7 0 games planned'),
    );
    expect(screen.getByTestId('round-progress').textContent).not.toContain('/');
  });

  test('the results screen names the YellowFruit step and claims nothing about it', async () => {
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('tab', { name: 'Results' }));

    expect(screen.getByText(/Import Games Only/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose Result Folder' })).toBeInTheDocument();
    // QBBridge never learns what YellowFruit did with a file, so it never says.
    for (const claim of ['Imported', 'Accepted', 'Official', 'standings', 'Reviewed']) {
      expect(document.body.textContent).not.toContain(claim);
    }
  });

  test('keeps local edits usable but warns until a retry saves the latest state', async () => {
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('button', { name: 'Open YellowFruit File' }));
    await screen.findByText('12 teams · 48 players');
    await user.click(screen.getByRole('tab', { name: 'Rooms' }));

    const realSetItem = globalThis.localStorage.setItem.bind(globalThis.localStorage);
    let storageBlocked = true;
    vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation((key, value) => {
      if (storageBlocked && key === storageKey) {
        throw new DOMException('storage blocked', 'QuotaExceededError');
      }
      realSetItem(key, value);
    });

    await user.click(screen.getByRole('button', { name: '+ Room' }));
    expect(
      screen.getByText(/cannot save the current tournament state on this machine/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry saving local state' })).toBeInTheDocument();

    const name = screen.getByRole('textbox', { name: 'Name of Room 1' });
    await user.clear(name);
    await user.type(name, 'Auditorium');
    expect(screen.getByRole('textbox', { name: 'Name of Auditorium' })).toHaveValue('Auditorium');

    storageBlocked = false;
    await user.click(screen.getByRole('button', { name: 'Retry saving local state' }));
    await waitFor(() =>
      expect(
        screen.queryByText(/cannot save the current tournament state on this machine/i),
      ).not.toBeInTheDocument(),
    );

    const saved = JSON.parse(globalThis.localStorage.getItem(storageKey) ?? '{}') as {
      rooms?: Array<{ name?: string }>;
    };
    expect(saved.rooms).toHaveLength(1);
    expect(saved.rooms?.[0]?.name).toBe('Auditorium');
  });

  test('the help screen is reachable and carries the setup sections', async () => {
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('tab', { name: 'Help' }));
    // The page's own contents and claims are checked in `HelpView.test.tsx`; this is the route.
    expect(
      screen.getByRole('heading', { level: 3, name: 'Setting up the Cloudflare relay' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Getting results into YellowFruit' }),
    ).toBeInTheDocument();
  });
});
