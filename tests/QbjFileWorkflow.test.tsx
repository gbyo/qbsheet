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
import { openApp, pressControl, score, startLineups } from './appHarness';
import { claimResponseTimeoutMs } from '../src/persistence/TabClaim';
import { assignmentDocument, greenwood, matchObject, ninetySix, tournamentDocument } from './qbjDocuments';
import { packageText } from './packages';
import { createQbsheetBackup, serializeQbsheetBackup } from '../src/scorer/QBSheetBackup';
import { validPackage } from './packages';
import { roomProcedureVersion } from '../src/scoring/RoomProcedure';

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

  test('a QBSheet backup restores through the same Open game file path as a QBJ', async () => {
    const packageValue = validPackage({ producer: 'QBSheet' });
    const setup = {
      left: {
        name: packageValue.left.name,
        players: packageValue.left.players.map((player) => player.name),
        startingLineup: packageValue.left.players.slice(0, 2).map((player) => player.name),
      },
      right: {
        name: packageValue.right.name,
        players: packageValue.right.players.map((player) => player.name),
        startingLineup: packageValue.right.players.slice(0, 2).map((player) => player.name),
      },
    };
    const backup = createQbsheetBackup({
      gamePackage: packageValue,
      setup,
      events: [{ id: 'backup-dead', type: 'tossup-dead', questionNumber: 1 }],
      history: { undo: [1], redo: [] },
    });

    await openApp();
    await choose(fileOf(serializeQbsheetBackup(backup), 'recovery.qbsheet'));

    await waitFor(() => expect(screen.getByText('On this device')).toBeInTheDocument());
    expect(screen.getByText('Ninety Six A')).toBeInTheDocument();
    expect(screen.getByText('Greenwood')).toBeInTheDocument();
  });

  test('a backup beside an active local copy is restored as a separate attempt', async () => {
    const packageValue = validPackage({ producer: 'QBSheet' });
    const setup = {
      left: {
        name: packageValue.left.name,
        players: packageValue.left.players.map((player) => player.name),
        startingLineup: packageValue.left.players.slice(0, 2).map((player) => player.name),
      },
      right: {
        name: packageValue.right.name,
        players: packageValue.right.players.map((player) => player.name),
        startingLineup: packageValue.right.players.slice(0, 2).map((player) => player.name),
      },
    };
    const backup = createQbsheetBackup({
      gamePackage: packageValue,
      setup,
      events: [{ id: 'backup-dead', type: 'tossup-dead', questionNumber: 1 }],
    });
    const file = fileOf(serializeQbsheetBackup(backup), 'recovery.qbsheet');

    await openApp();
    await choose(file);
    await waitFor(() => expect(screen.getByText('On this device')).toBeInTheDocument());

    // A reload leaves an unfinished file game at Home, where the same familiar file action is
    // available again. The second import must never silently resume the older local copy instead.
    cleanup();
    await openApp();
    await choose(file);

    await waitFor(() => {
      expect(
        screen.getByText(/already in progress\. This QBSheet backup was restored as a separate copy/i),
      ).toBeInTheDocument();
    });
  });

  test('a roster-only backup from the starting-lineup prompt restores to that prompt', async () => {
    const ordinaryPackage = validPackage({ producer: 'QBSheet' });
    const packageValue = {
      ...ordinaryPackage,
      scorekeeperFormat: {
        ...ordinaryPackage.scorekeeperFormat,
        players: { ...ordinaryPackage.scorekeeperFormat.players, maximumActive: 2 },
      },
    };
    const backup = createQbsheetBackup({
      gamePackage: packageValue,
      setup: {
        left: {
          name: packageValue.left.name,
          players: packageValue.left.players.map((player) => player.name),
        },
        right: {
          name: packageValue.right.name,
          players: packageValue.right.players.map((player) => player.name),
        },
      },
      events: [
        {
          id: 'late-arrival',
          type: 'roster-add',
          questionNumber: 1,
          team: 'left',
          playerName: 'Taylor Morgan',
        },
      ],
    });

    await openApp();
    await choose(fileOf(serializeQbsheetBackup(backup), 'before-lineup.qbsheet'));

    await waitFor(() => expect(screen.getByLabelText('Starting lineups')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Start Taylor Morgan' })).toBeInTheDocument();
  });
});

/**
 * The portable copies a room can take mid-game.
 *
 * These prove the menu entries write what they claim: the default is an official serialized
 * document, the compatibility entry is still a bare Match, and neither carries anything private.
 */
describe('downloading QBJ during a game', () => {
  /** Capture what a download would have written, instead of writing it. */
  function captureDownloads(): { files: { name: string; contents: string }[] } {
    const files: { name: string; contents: string }[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const OriginalBlob = globalThis.Blob;
    const originalClick = HTMLAnchorElement.prototype.click;
    let pending = '';

    class RecordingBlob extends OriginalBlob {
      readonly recordedText: string;

      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        this.recordedText = parts.map((part) => String(part)).join('');
      }
    }
    globalThis.Blob = RecordingBlob as unknown as typeof Blob;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => {
        pending = (blob as RecordingBlob).recordedText ?? '';
        return 'blob:captured';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      files.push({ name: this.download, contents: pending });
    };

    afterEach(() => {
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreate });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevoke });
      globalThis.Blob = OriginalBlob;
      HTMLAnchorElement.prototype.click = originalClick;
    });

    return { files };
  }

  async function openAssignmentAndStart(assignment = assignmentDocument()): Promise<void> {
    await openApp();
    await choose(fileOf(assignment, 'R04.assignment.qbj'));
    await startLineups();
  }

  test('"Download current QBJ" writes an official serialized document', async () => {
    const downloads = captureDownloads();
    await openAssignmentAndStart();

    await pressControl('Export / backup…');
    await pressControl('Download current QBJ');

    expect(downloads.files).toHaveLength(1);
    const written = JSON.parse(downloads.files[0].contents);
    expect(written.version).toBe('2.1.1');
    expect(Array.isArray(written.objects)).toBe(true);
    expect(written.objects.some((entry: { type?: string }) => entry.type === 'Tournament')).toBe(true);
    // The identity from the assignment is preserved, so this reconciles like any other result.
    expect(written.objects.some((entry: { id?: string }) => entry.id === 'Match_sm-4471')).toBe(true);
  });

  test('the partial filename says what it is, without being identity', async () => {
    const downloads = captureDownloads();
    await openAssignmentAndStart();

    await pressControl('Export / backup…');
    await pressControl('Download current QBJ');

    expect(downloads.files[0].name).toBe('R04_Room-204_Ninety-Six_vs_Greenwood.partial.qbj');
  });

  test('the QBSheet backup action writes the exact transfer envelope', async () => {
    const downloads = captureDownloads();
    await openAssignmentAndStart(
      assignmentDocument({
        matches: [
          matchObject({
            id: 'Match_clock-export',
            left: ninetySix,
            right: greenwood,
            location: 'Room 204',
            qbtcp: {
              round_revision: 3,
              room_id: 'room-204',
              procedure: {
                version: roomProcedureVersion,
                halves: true,
                halfLengthMinutes: 10,
                timeoutsPerTeam: 0,
              },
              scorekeeper: { timed: false },
            },
          }),
        ],
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    });

    await pressControl('Export / backup…');
    await pressControl('Download QBSheet backup');

    expect(downloads.files).toHaveLength(1);
    expect(downloads.files[0].name).toBe('R04_Room-204_Ninety-Six_vs_Greenwood.qbsheet');
    const written = JSON.parse(downloads.files[0].contents);
    expect(written.kind).toBe('qbsheet-backup');
    expect(written.version).toBe(1);
    expect(written.package.left.name).toBe('Ninety Six');
    expect(Array.isArray(written.events)).toBe(true);
    expect(written.clocks['half-1']).toMatchObject({ status: 'paused' });
    expect(downloads.files[0].contents).not.toContain('runningSince');
  });

  test('the compatibility entry still writes a bare match', async () => {
    const downloads = captureDownloads();
    await openAssignmentAndStart();

    await pressControl('Export / backup…');
    await pressControl('Download legacy match-only QBJ');

    const written = JSON.parse(downloads.files[0].contents);
    expect(written.objects).toBeUndefined();
    expect(Array.isArray(written.match_teams)).toBe(true);
  });

  test('neither download carries credentials or the private recovery journal', async () => {
    const downloads = captureDownloads();
    await openAssignmentAndStart();

    await pressControl('Export / backup…');
    await pressControl('Download current QBJ');

    const contents = downloads.files[0].contents.toLowerCase();
    for (const forbidden of ['token', 'pairing', 'deviceid', 'authorization', '_yf_scorekeeper_recovery']) {
      expect(contents).not.toContain(forbidden);
    }
  });
});

/**
 * Supplying rules a document did not carry.
 *
 * The point of these is the negative assertion as much as the positive one: the scoresheet must not
 * name a rule set it was never told about, and must not score anything until somebody answers.
 */
describe('a QBJ with no scoring rules', () => {
  test('offers a form rather than an error', async () => {
    await openApp();

    await choose(fileOf(assignmentDocument({ scoringRules: null }), 'no-rules.qbj'));

    await waitFor(() => {
      expect(screen.getByText('Scoring rules needed')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Correct tossup')).toBeInTheDocument();
    expect(screen.getByLabelText('Tossups in regulation')).toBeInTheDocument();
  });

  test('scores the game once rules are given', async () => {
    await openApp();
    await choose(fileOf(assignmentDocument({ scoringRules: null }), 'no-rules.qbj'));
    await waitFor(() => expect(screen.getByText('Scoring rules needed')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use these rules' }));
    });
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, claimResponseTimeoutMs + 50);
      });
    });

    await waitFor(() => {
      expect(screen.queryByText('Scoring rules needed')).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Ninety Six/)).toBeInTheDocument();
  });

  test('rules entered in the room are read by the same mapper a file goes through', async () => {
    await openApp();
    await choose(fileOf(assignmentDocument({ scoringRules: null }), 'no-rules.qbj'));
    await waitFor(() => expect(screen.getByText('Scoring rules needed')).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Correct tossup'), { target: { value: '12' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use these rules' }));
    });
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, claimResponseTimeoutMs + 50);
      });
    });

    await waitFor(() => {
      expect(screen.queryByText('Scoring rules needed')).not.toBeInTheDocument();
    });
    // A real game begins at the starting-lineup prompt; the scoring buttons are behind it.
    await startLineups();
    await score('Sarah', 'C');

    // A converted tossup is worth what was typed in, which means the entered rules went through the
    // same mapping an imported ScoringRules object does.
    await waitFor(() => {
      expect(screen.getByLabelText('Ninety Six score')).toHaveTextContent('12');
    });
  });

  test('no rule set is named anywhere on the way past', async () => {
    await openApp();

    await choose(fileOf(assignmentDocument({ scoringRules: null }), 'no-rules.qbj'));

    await waitFor(() => expect(screen.getByText('Scoring rules needed')).toBeInTheDocument());
    expect(document.body.textContent).not.toContain('NAQT');
    expect(document.body.textContent).not.toContain('ACF');
  });
});
