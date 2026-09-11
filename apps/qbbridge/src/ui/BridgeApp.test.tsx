/**
 * The three screens, rendered.
 *
 * A smoke test rather than a design test: it checks that an operator with a loaded file can see
 * the tournament, pick teams for a room, and reach the results screen, and that nothing on screen
 * claims a state QBBridge cannot know.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

beforeEach(installFakeTauri);
afterEach(() => {
  Reflect.deleteProperty(globalThis as Record<string, unknown>, '__TAURI_INTERNALS__');
  resetNativeHost();
});

describe('the shell', () => {
  test('opens on the tournament panel and says what is missing', () => {
    render(<BridgeApp />);
    expect(screen.getByRole('heading', { name: 'QBSheet Bridge' })).toBeInTheDocument();
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

    await user.click(screen.getByRole('button', { name: 'Rooms' }));
    await user.click(screen.getByRole('button', { name: '+ Room' }));

    const row = screen.getByRole('row', { name: /Room 1/ });
    await user.selectOptions(within(row).getByLabelText('Left team in Room 1'), 'Team_Cony');
    await user.selectOptions(within(row).getByLabelText('Right team in Room 1'), 'Team_Deering');

    expect(within(row).getByText(/^[0-9]{8}$/)).toBeInTheDocument();
    expect(within(row).getByText('Ready')).toBeInTheDocument();
    // Publishing needs a relay; without one the button does not pretend otherwise.
    expect(screen.getByRole('button', { name: /Publish Round 1/ })).toBeDisabled();
  });

  test('warns about the three things a person mistypes', async () => {
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('button', { name: 'Open YellowFruit File' }));
    await screen.findByText('12 teams · 48 players');
    await user.click(screen.getByRole('button', { name: 'Rooms' }));
    await user.click(screen.getByRole('button', { name: '+ Room' }));

    expect(screen.getByText('This room has no matchup yet.')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /Room 1/ });
    await user.selectOptions(within(row).getByLabelText('Left team in Room 1'), 'Team_Cony');
    await user.selectOptions(within(row).getByLabelText('Right team in Room 1'), 'Team_Cony');
    expect(screen.getByText('Both sides are the same team.')).toBeInTheDocument();
  });

  test('the results screen names the YellowFruit step and claims nothing about it', async () => {
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('button', { name: 'Results' }));

    expect(screen.getByText(/Import Games Only/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose Result Folder' })).toBeInTheDocument();
    // QBBridge never learns what YellowFruit did with a file, so it never says.
    for (const claim of ['Imported', 'Accepted', 'Official', 'standings', 'Reviewed']) {
      expect(document.body.textContent).not.toContain(claim);
    }
  });

  test('the help screen is the tournament-day workflow', async () => {
    const user = userEvent.setup();
    render(<BridgeApp />);
    await user.click(screen.getByRole('button', { name: 'Help' }));
    expect(screen.getByText(/Before the tournament/)).toBeInTheDocument();
    expect(screen.getByText(/Import Games Only/)).toBeInTheDocument();
  });
});
