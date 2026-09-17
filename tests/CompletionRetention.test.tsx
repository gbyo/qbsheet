/**
 * @vitest-environment jsdom
 */

/**
 * The two things the completion screen must never cost a room, driven through the real application.
 *
 * A correction has to land on the *same* saved game, because the whole reason the completion screen
 * may be left is that the result is on this device: a "Correct result" that opened a fresh
 * scoresheet would quietly discard the game it claimed to be correcting. And the record has to
 * survive everything that looks like an ending — a download, a handoff, walking out of the screen —
 * because those are three independent claims about three independent copies, and the room that
 * discovers on Monday that one of them was wrong needs this one to still be here.
 *
 * Both are asserted through the screens rather than through the store, because both are claims
 * about what a scorekeeper can get back to.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  bonus,
  openApp,
  openGameDetails,
  openGameFile,
  press,
  pressControl,
  score,
  startLineups,
} from './appHarness';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** Score one cycle so the finished game has a number worth recognizing again. */
async function scoreOneCycle(): Promise<void> {
  await score('Sarah Mitchell', '+15');
  await bonus('20');
}

async function finishGame(): Promise<void> {
  await pressControl('End game early…');
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Why is the game ending early?'), {
      target: { value: 'Round called' },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByText('End the game now'));
  });
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Final score confirmed with both teams'));
  });
  await act(async () => {
    fireEvent.click(screen.getByText('Submit result'));
  });
  await screen.findByText('Final');
}

/** Take the file game through the download its handoff requires, which is what unlocks the screen. */
async function handOverTheFile(): Promise<void> {
  await press('Download QBJ');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled());
}

describe('correcting a finished result', () => {
  test('reopens the game that was just scored, at the score it was scored at', async () => {
    await openApp();
    await openGameFile();
    await startLineups();
    await scoreOneCycle();
    await finishGame();

    // 15 for the power, 20 for the bonus. This number is the game's fingerprint.
    expect(screen.getByText('35')).toBeInTheDocument();

    await openGameDetails();
    await press('Correct result');

    // The scorer, holding the same events rather than a new game at zero.
    expect(await screen.findByRole('heading', { name: 'Confirm the result' })).toBeInTheDocument();
    const reopened = screen.getByLabelText('Final score');
    await waitFor(() => expect(within(reopened).getByText('Ninety Six A')).toBeInTheDocument());
    expect(
      Array.from(reopened.querySelectorAll('.scorer-review-score-number')).map(
        (number) => number.textContent,
      ),
    ).toEqual(['35', '0']);
    expect(screen.queryByText('This game is already saved on this device.')).toBeNull();
  });
});

describe('what a finished game survives', () => {
  test('the record is still on the device after the handoff and after leaving the screen', async () => {
    await openApp();
    await openGameFile();
    await startLineups();
    await scoreOneCycle();
    await finishGame();
    await handOverTheFile();

    // The download did not consume the record, and the QBJ is still offered for the downloads
    // folder somebody is about to clear.
    const details = await openGameDetails();
    expect(within(details).getByRole('button', { name: 'Download QBJ again' })).toBeInTheDocument();
    await press('Close dialog');

    await press('Done');

    const recent = await screen.findByText('Recent');
    expect(recent).toBeInTheDocument();
    expect(screen.getByText(/Round 7/)).toBeInTheDocument();
    expect(screen.getByText(/Ninety Six A/)).toBeInTheDocument();
  });

  test('a reload finds the finished game rather than an empty device', async () => {
    await openApp();
    await openGameFile();
    await startLineups();
    await scoreOneCycle();
    await finishGame();
    await handOverTheFile();
    await press('Done');
    await screen.findByText('Recent');

    cleanup();
    await openApp();

    expect(await screen.findByText('Recent')).toBeInTheDocument();
    expect(screen.getByText(/Ninety Six A/)).toBeInTheDocument();
  });
});
