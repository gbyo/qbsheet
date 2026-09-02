/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { IStoredGameRecord, memoryGameStore } from '../src/game/GameStore';
import { gameSessionVersion } from '../src/scorer/GameSession';
import { createQbsheetBackup, serializeQbsheetBackup } from '../src/scorer/QBSheetBackup';
import RecoveryMode from '../src/app/RecoveryMode';
import { inspectJournals } from '../src/app/RecoveryJournal';
import { IRecoverySnapshot, buildRecoveryGames } from '../src/app/RecoveryModeSupport';
import { validPackage } from './packages';

const now = new Date('2026-08-20T14:00:00.000Z');
const gamePackage = validPackage();
const setup = {
  left: { name: gamePackage.left.name, players: gamePackage.left.players.map((player) => player.name) },
  right: { name: gamePackage.right.name, players: gamePackage.right.players.map((player) => player.name) },
};
const events = [{ id: 'dead-14', type: 'tossup-dead' as const, questionNumber: 14 }];

function savedRecord(): IStoredGameRecord {
  return {
    version: 1,
    id: 'record-1',
    identity: 'match:sched-101',
    attempt: 1,
    gameKey: 'session-a',
    package: gamePackage,
    setup,
    events,
    connected: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    serverDelivery: 'none',
  };
}

function snapshot(): IRecoverySnapshot {
  const journals = {
    'session-a': JSON.stringify({
      version: gameSessionVersion,
      gameKey: 'session-a',
      setup,
      events,
      updatedAt: now.toISOString(),
    }),
  };
  const journalEntries = inspectJournals(journals, now);
  const record = savedRecord();
  return {
    journals,
    journalEntries,
    games: buildRecoveryGames(journalEntries, [record]),
    unreadableCount: 0,
    durable: true,
    storageDegraded: false,
    journalUnavailable: false,
    store: memoryGameStore(),
    inspectedAt: now,
  };
}

describe('standalone Recovery Mode', () => {
  test('shows source status and offers the safest local copy without mounting the scorer', async () => {
    const onResume = vi.fn();
    const loaded = snapshot();
    render(<RecoveryMode loadSources={() => Promise.resolve(loaded)} onResume={onResume} now={() => now} />);

    // The title and the shell chrome are painted before the sources are read, so waiting on them
    // would let every assertion below race the asynchronous inspection. Anchor on a source row,
    // which only exists once `loadSources` has resolved.
    expect(await screen.findByText('Instant scoring journal')).toBeInTheDocument();
    const recoveryMain = screen.getByRole('main', { name: 'Recovery Mode' });
    expect(recoveryMain).toHaveClass('shell', 'recovery-screen');
    expect(recoveryMain.querySelector('.shell-brand-logo')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Recovery Mode' })).toHaveClass('shell-title');
    expect(screen.getAllByText(/Valid · saved just now · 1 event · through TU 14/)).toHaveLength(2);
    expect(screen.getByText(/does not open the scorer/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Resume safest copy' }));
    expect(onResume).toHaveBeenCalledWith(savedRecord());
  });

  test('offers the raw journal without judging or rewriting it', async () => {
    const write = vi.fn().mockReturnValue(true);
    render(<RecoveryMode loadSources={() => Promise.resolve(snapshot())} write={write} now={() => now} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Save raw recovery file' }));

    expect(write).toHaveBeenCalledOnce();
    const [contents, fileName] = write.mock.calls[0];
    expect(fileName).toMatch(/^qbsheet-recovery-.*\.json$/);
    expect(JSON.parse(contents as string).games['session-a']).toContain('session-a');
    expect(screen.getByText(/raw journal file was offered/i)).toBeInTheDocument();
  });

  test('uses the existing QBSheet parser and restores only after an explicit action', async () => {
    const loaded = snapshot();
    const backup = createQbsheetBackup({ gamePackage, setup, events: [] });
    const restore = vi.fn().mockResolvedValue({
      ok: true,
      record: savedRecord(),
      journalSaved: true,
      restoringAlongsideActive: false,
      skippedOccupiedSlot: false,
    });
    render(
      <RecoveryMode loadSources={() => Promise.resolve(loaded)} onRestoreBackup={restore} now={() => now} />,
    );

    // The file control is intentionally hidden. Query by its accessible label so this test follows
    // the product contract rather than CSS visibility.
    await screen.findByRole('button', { name: 'Open QBSheet backup…' });
    const fileInput = screen.getByLabelText('Open QBSheet backup file') as HTMLInputElement;
    const file = {
      name: 'recovery.qbsheet',
      size: serializeQbsheetBackup(backup).length,
      text: () => Promise.resolve(serializeQbsheetBackup(backup)),
    } as unknown as File;
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput);

    expect(await screen.findByText(/recovery\.qbsheet/)).toBeInTheDocument();
    expect(restore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore as separate local attempt' }));

    await waitFor(() => expect(restore).toHaveBeenCalledOnce());
    expect(restore.mock.calls[0][0]).toMatchObject({ kind: 'qbsheet-backup', events: [] });
    expect(screen.getByText(/restored as a separate local attempt/i)).toBeInTheDocument();
  });
});
