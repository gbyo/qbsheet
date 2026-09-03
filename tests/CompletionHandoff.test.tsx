/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function show(
  candidate: IStoredGameRecord,
  overrides: {
    onUpdate?: (
      recordId: string,
      change: Partial<IStoredGameRecord>,
    ) => boolean | void | Promise<boolean | void>;
    onRematch?: () => void | Promise<void>;
  } = {},
) {
  const onUpdate = overrides.onUpdate ?? vi.fn();
  return {
    onUpdate,
    view: render(
      <CompletionScreen
        record={candidate}
        onUpdate={onUpdate}
        onBackToScorekeeper={vi.fn()}
        onHome={vi.fn()}
        onRematch={overrides.onRematch}
      />,
    ),
  };
}

function primaryButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.shell-button.is-primary'));
}

afterEach(cleanup);

describe('a file game that owes its result', () => {
  test('the download is the only primary action while the gate is locked', () => {
    show(record());

    expect(screen.getByText('This result needs to be handed over.')).toBeInTheDocument();
    const download = screen.getByRole('button', { name: 'Download QBJ' });
    expect(download).toHaveClass('is-primary');
    expect(primaryButtons()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.getByText(/before finishing\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review score' })).toBeEnabled();
  });

  test('downloading records qbjDownloadedAt and unlocks continuation', () => {
    const onUpdate = vi.fn();
    const { view } = show(record(), { onUpdate });

    fireEvent.click(screen.getByRole('button', { name: 'Download QBJ' }));
    expect(onUpdate).toHaveBeenCalledWith('handoff-result', {
      qbjDownloadedAt: expect.any(String),
    });

    view.rerender(
      <CompletionScreen
        record={record({ qbjDownloadedAt: '2026-08-12T16:31:00.000Z' })}
        onUpdate={onUpdate}
        onBackToScorekeeper={vi.fn()}
        onHome={vi.fn()}
      />,
    );

    expect(screen.getByText(/QBJ downloaded/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download QBJ' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(primaryButtons()).toHaveLength(1);
  });
});

describe('handoff acknowledgement', () => {
  function pendingDownloaded() {
    return record({
      connected: true,
      serverDelivery: 'pending',
      qbjDownloadedAt: '2026-08-12T16:31:00.000Z',
    });
  }

  test('the upload confirmation is the only primary action while it is pending', () => {
    show(pendingDownloaded());

    expect(screen.getByText('Waiting for handoff')).toBeInTheDocument();
    expect(screen.getByText(/QBJ downloaded/)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'I uploaded the result' });
    expect(confirm).toHaveClass('is-primary');
    expect(primaryButtons()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.getByText(/before finishing\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review score' })).toBeEnabled();
  });

  test('a refused acknowledgement keeps continuation locked with its recovery beside it', async () => {
    const onUpdate = vi.fn().mockResolvedValue(false);
    show(pendingDownloaded(), { onUpdate });

    fireEvent.click(screen.getByRole('button', { name: 'I uploaded the result' }));
    expect(onUpdate).toHaveBeenCalledWith('handoff-result', {
      handoffAcknowledgedAt: expect.any(String),
    });

    expect(await screen.findByText(/could not save that confirmation/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.getByText(/before finishing\./)).toBeInTheDocument();
  });

  test('a recorded acknowledgement advances to continuation', () => {
    const { view } = show(pendingDownloaded(), { onUpdate: vi.fn() });

    view.rerender(
      <CompletionScreen
        record={record({
          connected: true,
          serverDelivery: 'pending',
          qbjDownloadedAt: '2026-08-12T16:31:00.000Z',
          handoffAcknowledgedAt: '2026-08-12T16:40:00.000Z',
        })}
        onUpdate={vi.fn()}
        onBackToScorekeeper={vi.fn()}
        onHome={vi.fn()}
      />,
    );

    expect(screen.getByText(/Result handoff confirmed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'I uploaded the result' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(primaryButtons()).toHaveLength(1);
  });
});

describe('delivery failures and explicit instructions', () => {
  test('a rejected result keeps its detail and its handoff gate', () => {
    show(
      record({
        connected: true,
        serverDelivery: 'rejected',
        serverDeliveryDetail: 'Round already closed by the director.',
      }),
    );

    expect(screen.getByText('Tournament control did not accept this result.')).toBeInTheDocument();
    expect(screen.getByText('Round already closed by the director.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download QBJ' })).toHaveClass('is-primary');
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.getByText(/before finishing\./)).toBeInTheDocument();
  });

  test('an explicit handoff instruction is honored even after acceptance', () => {
    show(
      record({
        connected: true,
        serverDelivery: 'sent',
        package: { ...validPackage(), handoffInstruction: 'Upload the QBJ to the tournament drive.' },
      }),
    );

    expect(screen.getByText('Result sent')).toBeInTheDocument();
    expect(screen.getByText('Upload the QBJ to the tournament drive.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download QBJ' })).toHaveClass('is-primary');
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.getByText(/before finishing\./)).toBeInTheDocument();
  });

  test('a refused download write explains itself beside the handoff', () => {
    vi.mocked(downloadFile).mockReturnValueOnce(false);
    show(record());

    fireEvent.click(screen.getByRole('button', { name: 'Download QBJ' }));

    expect(screen.getByText(/would not save the file/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.getByText(/before finishing\./)).toBeInTheDocument();
  });

  test('an unrecorded download offers a retry that writes again', async () => {
    const onUpdate = vi.fn().mockResolvedValue(false);
    show(record(), { onUpdate });

    fireEvent.click(screen.getByRole('button', { name: 'Download QBJ' }));
    const retry = await screen.findByRole('button', { name: 'Retry recording the download' });
    fireEvent.click(retry);

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenNthCalledWith(2, 'handoff-result', {
      qbjDownloadedAt: expect.any(String),
    });
  });
});

describe('accepted variants and manual games', () => {
  test('a duplicate acceptance says so and still lets the room continue', () => {
    show(
      record({
        connected: true,
        serverDelivery: 'sent',
        serverDeliveryLedger: { attemptCount: 2, retryable: false, outcome: 'accepted' },
      }),
    );

    expect(screen.getByText('Result sent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(primaryButtons()).toHaveLength(1);
  });

  test('an acceptance already on record names it', () => {
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

    expect(screen.getByText('Result already on record')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  });

  test('an acceptance held for director review names that instead of failing', () => {
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

    expect(screen.getByText('Result received for director review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(primaryButtons()).toHaveLength(1);
  });

  test('a manual game is saved, quiet, and offers a rematch without competing', async () => {
    const onRematch = vi.fn();
    show(record({ package: manualPackage(), serverDelivery: 'none' }), { onRematch });

    expect(screen.getByText('Saved on this device')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toHaveClass('is-primary');
    expect(primaryButtons()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'I uploaded the result' })).toBeNull();
    expect(screen.queryByText('This result needs to be handed over')).toBeNull();

    const exports = screen.getByText('Files & exports').closest('details');
    expect(exports).not.toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Download QBJ copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Excel scoresheet' })).toBeInTheDocument();

    const rematch = screen.getByRole('button', { name: 'Rematch' });
    expect(rematch).not.toHaveClass('is-primary');
    fireEvent.click(rematch);
    expect(onRematch).toHaveBeenCalledOnce();
  });

  test('a downloaded excel scoresheet says so compactly inside the exports', () => {
    show(record({ package: manualPackage(), serverDelivery: 'none' }));

    fireEvent.click(screen.getByRole('button', { name: 'Download Excel scoresheet' }));

    expect(screen.getByText('✓ Excel downloaded')).toBeInTheDocument();
    expect(screen.queryByText(/would not save the file/)).toBeNull();
  });
});
