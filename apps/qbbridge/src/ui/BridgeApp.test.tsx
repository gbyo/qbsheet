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
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { resetNativeHost } from '../model/native';
import { yftFixtureText } from '../tests/fixture';
import BridgeApp from './BridgeApp';

function installFakeTauri(): void {
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {
      invoke: async (command: string) => {
        if (command === 'open_yellowfruit_file') {
          return { path: '/tournaments/spring.yft', contents: yftFixtureText() };
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
  await user.click(within(listbox).getByRole('option', { name }));
}

beforeEach(installFakeTauri);
afterEach(() => {
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
    expect(within(row).getByText('Not published')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish Room Setup' })).toBeDisabled();
    expect(within(row).getByText('Ready')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'New code' }));
    expect(within(row).getByText(/Pending — publish to activate:/)).toBeInTheDocument();
    expect(within(row).getAllByText(/^[0-9]{8}$/)).toHaveLength(2);
    // Publishing needs a relay; without one the button does not pretend otherwise.
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

  test('switching rounds asks before it clears the pairings', async () => {
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('button', { name: 'Open YellowFruit File' }));
    await screen.findByText('12 teams · 48 players');
    await user.click(screen.getByRole('tab', { name: 'Rooms' }));
    await user.click(screen.getByRole('button', { name: '+ Room' }));
    await pickTeam(user, 'Left team in Room 1', 'Cony');

    const rounds = screen.getByLabelText('Round');
    await user.selectOptions(rounds, 'Phase_Prelims__round_5');

    // Nothing has changed yet: the dialog is the gate.
    const dialog = await screen.findByRole('alertdialog', { name: 'Switch to Round 5?' });
    expect(within(dialog).getByText(/selections in every room will be cleared/)).toBeInTheDocument();
    // The page behind a modal is inert and hidden from assistive technology, so the only thing
    // reachable is the question. That is the property `window.confirm` fakes and a hand-rolled
    // overlay usually misses.
    expect(screen.queryByRole('combobox', { name: 'Left team in Room 1' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Left team in Room 1', hidden: true })).toHaveValue('Cony');

    await user.click(within(dialog).getByRole('button', { name: 'Switch Round' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Left team in Room 1' })).toHaveValue(''),
    );
    // The room and its pairing code survive the switch.
    expect(screen.getByRole('row', { name: /Room 1/ })).toBeInTheDocument();
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
