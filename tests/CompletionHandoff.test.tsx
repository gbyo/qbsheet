/**
 * @vitest-environment jsdom
 */

/**
 * The invariants of the post-game screen, rather than the presence of individual buttons.
 *
 * What this suite protects is the contract the redesign is built on: at every stage there is
 * exactly one primary action and it is the thing to do next; a successful connected result offers
 * no optional machinery at all; a locked gate shows the action that unlocks it instead of a
 * disabled continuation; and every optional tool lives in exactly one place. Those are the claims
 * that stop the screen drifting back into a toolbox one well-meaning addition at a time.
 *
 * The delivery rules themselves belong to `GameStore` and are asserted through it: this suite
 * drives the states `needsHandoff`, `isDelivered` and `gameRequiresHandoff` distinguish, so a
 * component that grew a second opinion about any of them fails here.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import CompletionScreen from '../src/app/CompletionScreen';
import { IStoredGameRecord } from '../src/game/GameStore';
import { validPackage } from './packages';
import { downloadFile } from '../src/integrations/file/QbjDownload';

vi.mock('../src/integrations/file/QbjDownload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/integrations/file/QbjDownload')>();
  return { ...actual, downloadFile: vi.fn(() => true) };
});

vi.mock('../src/integrations/file/ExcelDownload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/integrations/file/ExcelDownload')>();
  return { ...actual, downloadExcelScoresheet: vi.fn(() => true) };
});

const AT = '2026-08-12T12:30:00.000Z';

function record(overrides: Partial<IStoredGameRecord> = {}): IStoredGameRecord {
  return {
    version: 1,
    id: 'handoff-result',
    identity: 'handoff-result',
    attempt: 1,
    gameKey: 'handoff-session',
    package: validPackage(),
    setup: { left: { name: 'A', players: [] }, right: { name: 'B', players: [] } },
    events: [],
    connected: false,
    createdAt: '2026-08-12T12:00:00.000Z',
    updatedAt: AT,
    completedAt: AT,
    finalQbj: { tossups_read: 20 },
    finalScore: { left: 120, right: 90 },
    serverDelivery: 'none',
    ...overrides,
  };
}

function manualPackage(): IStoredGameRecord['package'] {
  return { ...validPackage(), origin: 'manual' } as unknown as IStoredGameRecord['package'];
}

type Overrides = {
  onUpdate?: (
    recordId: string,
    change: Partial<IStoredGameRecord>,
  ) => boolean | void | Promise<boolean | void>;
  onRematch?: () => void | Promise<void>;
  onBackToScorekeeper?: () => void | Promise<void>;
  continueLabel?: string;
};

function show(candidate: IStoredGameRecord, overrides: Overrides = {}) {
  const onUpdate = overrides.onUpdate ?? vi.fn();
  const onBackToScorekeeper = overrides.onBackToScorekeeper ?? vi.fn();
  const element = (next: IStoredGameRecord) => (
    <CompletionScreen
      record={next}
      onUpdate={onUpdate}
      onBackToScorekeeper={onBackToScorekeeper}
      onHome={vi.fn()}
      onRematch={overrides.onRematch}
      continueLabel={overrides.continueLabel}
    />
  );
  const view = render(element(candidate));
  return {
    onUpdate,
    onBackToScorekeeper,
    view,
    rerenderWith: (next: IStoredGameRecord) => view.rerender(element(next)),
  };
}

function primaryButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.shell-button.is-primary'));
}

/** The single quiet door to everything optional. */
function openDetails(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Game details' }));
  return screen.getByRole('dialog', { name: 'Game details' });
}

afterEach(cleanup);

/**
 * The invariant the whole screen is built on.
 *
 * One blue button at a time, and it is the thing to do next. A stage that grew a second would be a
 * stage where a scorekeeper has to decide which of two things finishing means.
 */
describe('exactly one primary action, at every stage', () => {
  // `continueLabel` is what the application would pass for each of these: a connected room goes
  // back to its room, and everything else is simply done.
  const stages: {
    name: string;
    candidate: IStoredGameRecord;
    primary: string;
    continueLabel: string;
  }[] = [
    {
      name: 'a delivered connected result',
      candidate: record({ connected: true, serverDelivery: 'sent' }),
      primary: 'Back to Room 204',
      continueLabel: 'Back to Room 204',
    },
    {
      name: 'a manual game nobody is waiting for',
      candidate: record({ package: manualPackage() }),
      primary: 'Done',
      continueLabel: 'Done',
    },
    {
      name: 'a file game that owes its result',
      candidate: record(),
      primary: 'Download QBJ',
      continueLabel: 'Done',
    },
    {
      name: 'a pending submission',
      candidate: record({ connected: true, serverDelivery: 'pending' }),
      primary: 'Download QBJ',
      continueLabel: 'Back to Room 204',
    },
    {
      name: 'a refused submission',
      candidate: record({ connected: true, serverDelivery: 'rejected' }),
      primary: 'Download QBJ',
      continueLabel: 'Back to Room 204',
    },
    {
      name: 'a downloaded file awaiting its handoff',
      candidate: record({ connected: true, serverDelivery: 'pending', qbjDownloadedAt: AT }),
      primary: 'I handed off the result',
      continueLabel: 'Back to Room 204',
    },
    {
      name: 'a completed handoff',
      candidate: record({
        connected: true,
        serverDelivery: 'pending',
        qbjDownloadedAt: AT,
        handoffAcknowledgedAt: AT,
      }),
      primary: 'Back to Room 204',
      continueLabel: 'Back to Room 204',
    },
  ];

  test.each(stages)('$name has only $primary', ({ candidate, primary, continueLabel }) => {
    show(candidate, { continueLabel });

    const buttons = primaryButtons();
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(primary);
    expect(buttons[0]).toBeEnabled();
  });

  test('a locked gate draws no disabled continuation beside the action that unlocks it', () => {
    show(record(), { continueLabel: 'Back to Room 204' });

    expect(screen.queryByRole('button', { name: 'Back to Room 204' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Download QBJ' })).toHaveClass('is-primary');
  });
});

describe('a connected result tournament control accepted', () => {
  test('says so, offers the way back, and puts nothing optional on the screen', () => {
    show(record({ connected: true, serverDelivery: 'sent' }), { continueLabel: 'Back to Room 204' });

    expect(screen.getByText(/Result sent/)).toBeInTheDocument();
    expect(screen.getByText('Tournament control has this result.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to Room 204' })).toBeEnabled();

    // Nothing exportable, nothing corrective, nothing celebratory: one door, and it is closed.
    expect(screen.queryByRole('button', { name: /Download QBJ/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Excel/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Correct result/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /rematch/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy stats/ })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Game details' })).toBeEnabled();
  });

  test('an acceptance held for director review is still an acceptance', () => {
    show(
      record({
        connected: true,
        serverDelivery: 'sent',
        serverDeliveryLedger: {
          attemptCount: 1,
          retryable: false,
          outcome: 'accepted',
          reviewRequired: true,
        },
      }),
    );

    expect(screen.getByText(/Result received/)).toBeInTheDocument();
    expect(screen.getByText('Tournament control will review it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(primaryButtons()).toHaveLength(1);
  });

  test('a result already on record names that and still lets the room leave', () => {
    show(
      record({
        connected: true,
        serverDelivery: 'sent',
        serverDeliveryLedger: {
          attemptCount: 2,
          retryable: false,
          outcome: 'accepted',
          acceptedAsDuplicate: true,
        },
      }),
    );

    expect(screen.getByText(/Result already on record/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(primaryButtons()).toHaveLength(1);
  });
});

describe('a submission that has not arrived yet', () => {
  const pending = () =>
    record({
      connected: true,
      serverDelivery: 'pending',
      serverDeliveryLedger: { attemptCount: 2, retryable: true, outcome: 'pending' },
    });

  test('reads as still trying rather than as a failure, and offers the file as the fallback', () => {
    show(pending(), { continueLabel: 'Back to Room 204' });

    expect(screen.getByText('Sending result…')).toBeInTheDocument();
    expect(screen.getByText('QBSheet is still trying automatically.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download QBJ' })).toHaveClass('is-primary');
    expect(screen.queryByRole('button', { name: 'Back to Room 204' })).toBeNull();
  });

  test('acceptance while the room is still standing here updates in place and unlocks the way out', () => {
    const { rerenderWith } = show(pending(), { continueLabel: 'Back to Room 204' });

    // The status is a polite live region, so a delivery that lands does not steal focus from
    // whatever the scorekeeper was reaching for.
    expect(document.querySelector('.completion-status')).toHaveAttribute('role', 'status');

    rerenderWith(
      record({
        connected: true,
        serverDelivery: 'sent',
        serverDeliveryLedger: {
          attemptCount: 3,
          retryable: false,
          outcome: 'accepted',
          acceptedAt: '2026-08-12T12:31:00.000Z',
        },
      }),
    );

    expect(screen.getByText(/Result sent/)).toBeInTheDocument();
    expect(screen.queryByText('Sending result…')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download QBJ' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to Room 204' })).toBeEnabled();
    expect(primaryButtons()).toHaveLength(1);
  });
});

describe('a submission tournament control refused', () => {
  test('keeps the reason control gave, verbatim, and makes the file the way out', () => {
    show(
      record({
        connected: true,
        serverDelivery: 'rejected',
        serverDeliveryDetail: 'Round 7 has already been closed by tournament control.',
      }),
    );

    expect(screen.getByText('Result was not accepted')).toBeInTheDocument();
    // The specific reason, not a generic apology: this is the sentence a room reads to a director.
    expect(screen.getByText('Round 7 has already been closed by tournament control.')).toBeInTheDocument();
    expect(screen.getByText('Your game is still saved on this device.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download QBJ' })).toHaveClass('is-primary');
    expect(primaryButtons()).toHaveLength(1);
  });
});

describe('a file game, whose QBJ is the result', () => {
  test('demands the download before anything else and says why', () => {
    show(record());

    expect(screen.getByText('Result needs to be handed over')).toBeInTheDocument();
    expect(screen.getByText('Save the tournament result file before leaving.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download QBJ' })).toHaveClass('is-primary');
  });

  test('a mid-game backup stamp does not satisfy the final download gate', () => {
    // A lifeboat downloaded mid-game records a backup stamp, never the completion field:
    // the finished result still has to leave this device through Download QBJ.
    show(record({ qbjBackupDownloadedAt: '2026-08-12T12:15:00.000Z' }));

    expect(screen.getByText('Result needs to be handed over')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download QBJ' })).toHaveClass('is-primary');
    expect(primaryButtons()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });

  test('a good download records the backup and unlocks continuation without asking for more', () => {
    const onUpdate = vi.fn();
    const { rerenderWith } = show(record(), { onUpdate });

    fireEvent.click(screen.getByRole('button', { name: 'Download QBJ' }));
    expect(onUpdate).toHaveBeenCalledWith('handoff-result', { qbjDownloadedAt: expect.any(String) });

    rerenderWith(record({ qbjDownloadedAt: '2026-08-12T16:31:00.000Z' }));

    expect(screen.getByText(/QBJ downloaded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'I handed off the result' })).toBeNull();
    expect(primaryButtons()).toHaveLength(1);
  });

  test('a refused write explains itself beside the button that failed', () => {
    vi.mocked(downloadFile).mockReturnValueOnce(false);
    show(record());

    fireEvent.click(screen.getByRole('button', { name: 'Download QBJ' }));

    expect(screen.getByText(/would not save the file/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });

  test('a download the store would not record offers a retry that writes again', async () => {
    const onUpdate = vi.fn().mockResolvedValue(false);
    show(record(), { onUpdate });

    fireEvent.click(screen.getByRole('button', { name: 'Download QBJ' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry recording the download' }));

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenNthCalledWith(2, 'handoff-result', {
      qbjDownloadedAt: expect.any(String),
    });
  });
});

describe('a tournament that asked for the file by name', () => {
  const instructed = (overrides: Partial<IStoredGameRecord> = {}) =>
    record({
      connected: true,
      serverDelivery: 'sent',
      package: { ...validPackage(), handoffInstruction: 'Upload the QBJ to the tournament drive.' },
      ...overrides,
    });

  test('an explicit instruction still holds the gate after an acceptance', () => {
    show(instructed());

    expect(screen.getByText(/Result sent/)).toBeInTheDocument();
    expect(screen.getByText('Upload the QBJ to the tournament drive.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download QBJ' })).toHaveClass('is-primary');
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });

  test('the acknowledgement asks what the scorekeeper did, not what a service received', () => {
    show(instructed({ qbjDownloadedAt: AT }));

    const confirm = screen.getByRole('button', { name: 'I handed off the result' });
    expect(confirm).toHaveClass('is-primary');
    expect(screen.queryByRole('button', { name: /uploaded/i })).toBeNull();
    expect(screen.getByText(/QBJ downloaded/)).toBeInTheDocument();
    expect(primaryButtons()).toHaveLength(1);
  });

  test('an acknowledgement the store refused keeps continuation locked, with its recovery beside it', async () => {
    const onUpdate = vi.fn().mockResolvedValue(false);
    show(instructed({ qbjDownloadedAt: AT }), { onUpdate });

    fireEvent.click(screen.getByRole('button', { name: 'I handed off the result' }));
    expect(onUpdate).toHaveBeenCalledWith('handoff-result', {
      handoffAcknowledgedAt: expect.any(String),
    });

    expect(await screen.findByText(/could not save that confirmation/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.getByRole('button', { name: 'I handed off the result' })).toHaveClass('is-primary');
  });

  test('a recorded acknowledgement is the last thing asked for', () => {
    show(instructed({ qbjDownloadedAt: AT, handoffAcknowledgedAt: '2026-08-12T16:40:00.000Z' }));

    expect(screen.getByText(/Result handed off/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'I handed off the result' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(primaryButtons()).toHaveLength(1);
  });
});

describe('a game nobody is waiting for', () => {
  test('is saved, is quiet, and demands nothing', () => {
    show(record({ package: manualPackage() }));

    expect(screen.getByText(/Saved on this device/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toHaveClass('is-primary');
    expect(screen.queryByText(/needs to be handed over/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Download QBJ/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'I handed off the result' })).toBeNull();
    expect(primaryButtons()).toHaveLength(1);
  });
});

describe('Game details, the one place everything optional lives', () => {
  test('holds the statistics, the correction, both files, and an eligible rematch', () => {
    const onRematch = vi.fn();
    show(record({ package: manualPackage() }), { onRematch });

    const details = openDetails();

    // Result details: the identity and the facts, read rather than reconstructed.
    expect(within(details).getByText('Ninety Six A vs Greenwood')).toBeInTheDocument();
    expect(within(details).getByText('Round 7 · Room 204')).toBeInTheDocument();
    expect(within(details).getByText(/Ninety Six A 120/)).toBeInTheDocument();

    // Statistics: the canonical presentation, and the only one.
    expect(within(details).getByRole('button', { name: 'Copy stats' })).toBeInTheDocument();

    // Actions & files.
    expect(within(details).getByRole('button', { name: 'Correct result' })).toBeInTheDocument();
    expect(within(details).getByRole('button', { name: 'Download QBJ copy' })).toBeInTheDocument();
    expect(within(details).getByRole('button', { name: 'Download Excel scoresheet' })).toBeInTheDocument();
    expect(within(details).getByRole('button', { name: 'Start a rematch' })).toBeInTheDocument();

    // And none of it competes with Done.
    expect(primaryButtons()).toHaveLength(1);
    expect(primaryButtons()[0]).toHaveTextContent('Done');
  });

  test('the statistics are there for a connected game too, not only a standalone one', () => {
    show(record({ connected: true, serverDelivery: 'sent' }));

    expect(within(openDetails()).getByRole('button', { name: 'Copy stats' })).toBeInTheDocument();
  });

  test('a rematch is not offered for a game that was never manual', () => {
    show(record({ connected: true, serverDelivery: 'sent' }), { onRematch: vi.fn() });

    expect(within(openDetails()).queryByRole('button', { name: 'Start a rematch' })).toBeNull();
  });

  test('Correct result reopens the saved game rather than starting anything new', () => {
    const onBackToScorekeeper = vi.fn();
    show(record({ connected: true, serverDelivery: 'sent' }), { onBackToScorekeeper });

    fireEvent.click(within(openDetails()).getByRole('button', { name: 'Correct result' }));

    expect(onBackToScorekeeper).toHaveBeenCalledOnce();
  });

  test('the top-level Review score action is gone: correcting is an exception, not a step', () => {
    show(record({ connected: true, serverDelivery: 'sent' }));

    expect(screen.queryByRole('button', { name: 'Review score' })).toBeNull();
  });

  test('the QBJ the room still owes is the primary action and is not duplicated in here', () => {
    show(record());

    const details = openDetails();
    expect(within(details).queryByRole('button', { name: /Download QBJ/ })).toBeNull();
    expect(document.querySelectorAll('.shell-button.is-primary')).toHaveLength(1);
    // Excel is never required, so it stays where the optional files are.
    expect(within(details).getByRole('button', { name: 'Download Excel scoresheet' })).toBeInTheDocument();
  });

  test('a QBJ already written is offered again, and says it is a repeat', () => {
    show(record({ connected: true, serverDelivery: 'sent', qbjDownloadedAt: AT }));

    expect(within(openDetails()).getByRole('button', { name: 'Download QBJ again' })).toBeInTheDocument();
  });

  test('a rematch that could not be saved says so without losing the finished result', async () => {
    const onRematch = vi.fn().mockRejectedValue(new Error('no'));
    show(record({ package: manualPackage() }), { onRematch });

    fireEvent.click(within(openDetails()).getByRole('button', { name: 'Start a rematch' }));

    expect(await screen.findByText(/rematch could not be saved locally/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled());
  });
});

/**
 * The exports are optional tools, and an optional tool that also sits on the main screen is two
 * places to look for one thing. This is the rule that used to be broken in both directions.
 */
describe('nothing optional appears twice', () => {
  test.each([
    ['a delivered connected result', record({ connected: true, serverDelivery: 'sent' })],
    ['a manual game', record({ package: manualPackage() })],
    ['a completed file handoff', record({ qbjDownloadedAt: AT })],
  ])('%s keeps the optional files off the completion surface', (_name, candidate) => {
    show(candidate);

    expect(screen.queryByRole('button', { name: /Excel/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Download QBJ/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy stats/ })).toBeNull();
    expect(screen.queryByText(/Files & exports/)).toBeNull();
    expect(screen.queryByText('Final statistics')).toBeNull();
  });

  test('opening and closing details leaves exactly one of each control behind', () => {
    show(record({ connected: true, serverDelivery: 'sent' }));

    openDetails();
    expect(screen.getAllByRole('button', { name: 'Download QBJ backup' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Download Excel scoresheet' })).toHaveLength(1);
  });
});
