/**
 * The hazards that are actually about the screens.
 *
 * `TournamentDaySoak.test.ts` runs a day through the store, which is where the accumulation lives. Three
 * hazards are not about the store at all and cannot be tested there:
 *
 *   - a **reload** that happens over and over, because the failure is cumulative and a single reload is
 *     already covered in `FileWorkflow`;
 *   - a **lid closed** for forty minutes with the scoresheet up, then opened, then scored into;
 *   - a **browser that stops saving mid-game**, where the whole question is whether the room finds out.
 *
 * Each is asserted through the real screens, because in each case the thing that must survive is what
 * the scorekeeper can see and press.
 */
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { bonus, openApp, openGameFile, press, score, startLineups } from './appHarness';

/** What a reload is: a fresh application against the same storage. */
async function reload(): Promise<void> {
  cleanup();
  await openApp();
}

/** Get back into the unfinished game from the front door. */
async function resume(): Promise<void> {
  expect(await screen.findByText('Unfinished game')).toBeInTheDocument();
  await press('Resume');
  await waitFor(() => expect(screen.getByText('Spring Invitational')).toBeInTheDocument());
}

/** A game with one converted tossup in it, worth 35. */
async function scoreOneCycle(): Promise<void> {
  await score('Sarah Mitchell', '+15');
  await bonus('20');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a Chromebook that keeps being reloaded', () => {
  test('ten reloads mid-round, and the score is the score', async () => {
    await openApp();
    await openGameFile();
    await startLineups();
    await scoreOneCycle();
    await waitFor(() => expect(screen.getByText('35')).toBeInTheDocument());

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await reload();
      await resume();
      // Every single time, not just the last one: a reload that loses a question on the seventh
      // attempt is a reload that loses a question.
      await waitFor(() => expect(screen.getByText('35')).toBeInTheDocument());
    }
  });

  test('scoring continues after a reload and the new question lands on the old total', async () => {
    await openApp();
    await openGameFile();
    await startLineups();
    await scoreOneCycle();

    await reload();
    await resume();
    await scoreOneCycle();

    // 35 twice. A resume that silently started a second game would show 35.
    await waitFor(() => expect(screen.getByText('70')).toBeInTheDocument());
  });

  test('a reload before anything is scored still comes back to the game', async () => {
    await openApp();
    await openGameFile();
    await startLineups();

    await reload();

    expect(await screen.findByText('Unfinished game')).toBeInTheDocument();
    expect(screen.getByText('Not started')).toBeInTheDocument();
  });
});

describe('a lid closed and opened again', () => {
  test('forty minutes of nothing, then the game carries on', async () => {
    await openApp();
    await openGameFile();
    await startLineups();
    await scoreOneCycle();

    // Every interval in the application fires at once when a suspended tab resumes: the room clock, the
    // wake lock, the connection poll. None of them may disturb the scoresheet.
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40 * 60 * 1000);
    });
    vi.useRealTimers();

    expect(screen.getByText('35')).toBeInTheDocument();
    await scoreOneCycle();
    await waitFor(() => expect(screen.getByText('70')).toBeInTheDocument());
  });

  test('a very long idle period does not take the game off the screen', async () => {
    await openApp();
    await openGameFile();
    await startLineups();
    await scoreOneCycle();

    vi.useFakeTimers();
    await act(async () => {
      // Longer than the journal's own maximum age, which is the boundary worth landing past: the game
      // on screen is authoritative and must not be discarded because a stored copy went stale.
      await vi.advanceTimersByTimeAsync(40 * 60 * 60 * 1000);
    });
    vi.useRealTimers();

    expect(screen.getByText('35')).toBeInTheDocument();
  });
});

describe('a browser that stops saving mid-game', () => {
  test('the room is told, loudly, and can still score', async () => {
    await openApp();
    await openGameFile();
    await startLineups();
    await scoreOneCycle();

    // The quota fills, or the profile locks storage down. This is the one failure that can cost a room
    // questions it has already scored, so the test is that it is impossible to miss.
    const setItem = vi
      .spyOn(Object.getPrototypeOf(window.localStorage), 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    try {
      await scoreOneCycle();

      const banner = await screen.findByText(/Event journal save failed/);
      expect(banner).toBeInTheDocument();
      // And a way out that does not need the network or the failed storage.
      expect(screen.getAllByRole('button', { name: /Download QBJ backup/ }).length).toBeGreaterThan(0);
      // Scoring did not stop. The game on screen is still the authority.
      await waitFor(() => expect(screen.getByText('70')).toBeInTheDocument());
    } finally {
      setItem.mockRestore();
    }
  });

  test('storage coming back does not leave the warning up forever', async () => {
    await openApp();
    await openGameFile();
    await startLineups();

    const setItem = vi.spyOn(Object.getPrototypeOf(window.localStorage), 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    await scoreOneCycle();
    await screen.findByText(/Event journal save failed/);
    setItem.mockRestore();

    await scoreOneCycle();

    // A permanent warning is a warning nobody reads by round four.
    await waitFor(() => expect(screen.queryByText(/Event journal save failed/)).toBeNull());
  });
});
