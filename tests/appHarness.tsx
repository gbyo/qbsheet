/**
 * Driving the whole application the way a scorekeeper does.
 *
 * The application tests go through the real screens rather than through the store, because most of
 * what they check is a claim about the *screen*: that a server failure did not take the scoresheet
 * off it, that the backup step is still there after a successful submission, that a reload comes
 * back to the same question. A test that called the store directly would pass while the room was
 * looking at a pairing form.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from '../src/app/App';
import { IGamePackage } from '../src/game/GamePackage';
import { packageText } from './packages';
import { claimResponseTimeoutMs } from '../src/persistence/TabClaim';

/** Render the application and wait for it to have read this device's storage. */
export async function openApp(): Promise<void> {
  render(<App />);
  await waitFor(() => expect(screen.queryByText('Opening the scoresheet…')).toBeNull());
}

/**
 * A game file for the picker.
 *
 * `File.text()` is what `FileGameSource` calls and jsdom does not implement it, so this is built
 * with the three members that matter rather than as a real `File`.
 */
export function gameFile(overrides: Partial<IGamePackage> = {}, name = 'game.qbg'): File {
  const text = packageText(overrides);
  return { name, size: text.length, text: () => Promise.resolve(text) } as unknown as File;
}

/**
 * Hand the picker a file and let the application settle.
 *
 * Opening a game is not synchronous: the package is validated, the record is written to IndexedDB,
 * and the tab claim waits briefly for another tab to answer. A test that asserted immediately would
 * be asserting on the welcome screen.
 */
export async function openGameFile(file: File = gameFile()): Promise<void> {
  const input = document.querySelector('.file-open-input') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    fireEvent.change(input);
  });
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, claimResponseTimeoutMs + 50);
    });
  });
}

/**
 * Get past the starting-lineup prompt, which a real game always begins with.
 *
 * The prompt is not skippable and is not meant to be: nothing can be scored against a lineup nobody
 * chose. Tests that are about something else confirm whoever the prompt already has selected.
 */
export async function startLineups(): Promise<void> {
  const start = screen.queryByRole('button', { name: 'Start game' });
  if (!start) return;
  await act(async () => {
    const prompt = screen.queryByLabelText('Starting lineups');
    if (prompt) {
      const chosen = new Set<string>();
      let changed = true;
      while (changed) {
        const currentStart = screen.queryByRole('button', { name: 'Start game' });
        if (!currentStart || !currentStart.hasAttribute('disabled')) break;
        changed = false;
        for (const team of Array.from(prompt.querySelectorAll('section[aria-label$=" starters"]'))) {
          const button = Array.from(team.querySelectorAll('button[aria-label^="Start "]')).find((candidate) => {
            const key = `${team.getAttribute('aria-label')}\u0000${candidate.getAttribute('aria-label')}`;
            return !candidate.hasAttribute('disabled') && !chosen.has(key);
          });
          if (!button) continue;
          const key = `${team.getAttribute('aria-label')}\u0000${button.getAttribute('aria-label')}`;
          chosen.add(key);
          fireEvent.click(button);
          changed = true;
        }
      }
    }
    const ready = screen.queryByRole('button', { name: 'Start game' });
    if (ready && !ready.hasAttribute('disabled')) fireEvent.click(ready);
  });
}

export async function press(name: string | RegExp): Promise<void> {
  const button = await screen.findByRole('button', { name });
  await act(async () => {
    fireEvent.click(button);
  });
}

/**
 * The scoring buttons on one player's row.
 *
 * Matched against the roster row specifically: a player's name also appears in the activity rail
 * once they have buzzed, and a bare text query would find both.
 */
export function buttonsFor(playerName: string): HTMLElement[] {
  const row = Array.from(document.querySelectorAll('.scorer-player')).find(
    (candidate) => candidate.querySelector('.scorer-player-name')?.textContent === playerName,
  );
  if (!row) throw new Error(`No roster row for ${playerName}`);
  return within(row as HTMLElement).getAllByRole('button');
}

/** Award a bonus by its total, from the prompt that follows a converted tossup. */
export async function bonus(total: string): Promise<void> {
  const button = within(await screen.findByLabelText('Bonus')).getByText(total);
  await act(async () => {
    fireEvent.click(button);
  });
}

/** Press a scoring button by its label on a given player's row. */
export async function score(playerName: string, label: string): Promise<void> {
  const button = buttonsFor(playerName).find((candidate) => candidate.textContent === label);
  if (!button) {
    throw new Error(
      `No "${label}" button for ${playerName}; has ${buttonsFor(playerName)
        .map((candidate) => candidate.textContent)
        .join(', ')}`,
    );
  }
  await act(async () => {
    fireEvent.click(button);
  });
}

/**
 * Press a control wherever it currently lives.
 *
 * The footer and the Game menu trade controls between them as the layout settles, and a test that
 * hard-coded which one holds a given button would be asserting on a layout decision.
 */
export async function pressControl(name: string | RegExp): Promise<void> {
  const onFooter = screen.queryByRole('button', { name });
  if (onFooter) {
    await act(async () => {
      fireEvent.click(onFooter);
    });
    return;
  }
  await act(async () => {
    fireEvent.click(screen.getByText('Game'));
  });
  await act(async () => {
    const menuItem = screen.queryByRole('menuitem', { name });
    fireEvent.click(menuItem ?? screen.getByRole('button', { name }));
  });
}
