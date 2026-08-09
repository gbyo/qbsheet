/**
 * Opening QBJ through the real screens.
 *
 * The parser is tested directly elsewhere. What is tested here is that a scorekeeper can actually
 * reach it: that a QBJ assignment opens the same way a game file always has, that a document with
 * several games asks which one rather than choosing, and that the notices a migration needs — a
 * legacy file, a game that already has a result — are shown rather than swallowed.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { openApp } from './appHarness';
import { claimResponseTimeoutMs } from '../src/persistence/TabClaim';
import { assignmentDocument, tournamentDocument } from './qbjDocuments';
import { packageText } from './packages';

afterEach(cleanup);

/**
 * `File.text()` is what the source calls and jsdom does not implement it, so this is built with the
 * three members that matter rather than as a real `File`. Same approach as `appHarness.gameFile`.
 */
function fileOf(contents: object | string, name: string): File {
  const text = typeof contents === 'string' ? contents : JSON.stringify(contents);
  return { name, size: text.length, text: () => Promise.resolve(text) } as unknown as File;
}

/** Drive the real file input, the way `appHarness` does, without its lineup handling. */
async function choose(file: File): Promise<void> {
  const input = document.querySelector('.file-open-input') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    fireEvent.change(input);
  });
  // Opening is not synchronous: the document is validated, a record is written, and the tab claim
  // waits briefly for another tab to answer.
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, claimResponseTimeoutMs + 50);
    });
  });
}

describe('opening QBJ from the welcome screen', () => {
  test('a one-game QBJ assignment opens the game it describes', async () => {
    await openApp();

    await choose(fileOf(assignmentDocument(), 'R04.assignment.qbj'));

    await waitFor(() => {
      expect(screen.getByText(/Ninety Six/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Greenwood/)).toBeInTheDocument();
  });

  test('a whole-tournament QBJ asks which game rather than choosing one', async () => {
    await openApp();

    await choose(fileOf(tournamentDocument(), 'tournament.qbj'));

    await waitFor(() => {
      expect(screen.getByText('Choose a game')).toBeInTheDocument();
    });
    // Both unplayed games are offered, grouped under their round.
    expect(screen.getByText('Ninety Six vs Clinton')).toBeInTheDocument();
    expect(screen.getByText('Emerald vs Greenwood')).toBeInTheDocument();
  });

  test('a game that already has a result is labelled in the picker', async () => {
    await openApp();

    await choose(fileOf(tournamentDocument(), 'tournament.qbj'));

    await waitFor(() => {
      expect(screen.getByText('Choose a game')).toBeInTheDocument();
    });
    expect(screen.getByText('Has a result')).toBeInTheDocument();
  });

  test('choosing a game from the picker starts that game', async () => {
    await openApp();
    await choose(fileOf(tournamentDocument(), 'tournament.qbj'));
    await waitFor(() => expect(screen.getByText('Choose a game')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByText('Emerald vs Greenwood'));
    });
    // Starting the chosen game persists it and waits on the tab claim, exactly as opening a file does.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, claimResponseTimeoutMs + 50);
      });
    });

    await waitFor(() => {
      expect(screen.queryByText('Choose a game')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText(/Emerald/)).toBeInTheDocument();
    });
  });

  test('a legacy .qbg still opens, and says so without blocking', async () => {
    await openApp();

    await choose(fileOf(packageText(), 'round7.qbg'));

    // The notice travels with the game, not the picker: opening replaces the welcome screen.
    await waitFor(() => {
      expect(screen.getByText(/Legacy QBSheet game file/)).toBeInTheDocument();
    });
    expect(screen.getByText(/new assignments use QBJ/)).toBeInTheDocument();
  });

  test('a QBJ with no scoring rules asks instead of guessing a rule set', async () => {
    await openApp();

    await choose(fileOf(assignmentDocument({ scoringRules: null }), 'no-rules.qbj'));

    await waitFor(() => {
      expect(screen.getByText(/does not specify enough scoring information/)).toBeInTheDocument();
    });
    // Nothing was invented on the way past.
    expect(screen.queryByText(/NAQT/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ACF/)).not.toBeInTheDocument();
  });
});
