/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import ScoringScreen from '../src/app/ScoringScreen';
import type { ResultDeliveryService } from '../src/app/ResultDelivery';
import { memoryGameStore, type IStoredGameRecord } from '../src/game/GameStore';
import { validPackage } from './packages';
import { downloadQbj } from '../src/integrations/file/QbjDownload';

vi.mock('../src/integrations/file/QbjDownload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/integrations/file/QbjDownload')>();
  return { ...actual, downloadQbj: vi.fn(() => true) };
});

afterEach(cleanup);

async function activeRecord(): Promise<{
  store: ReturnType<typeof memoryGameStore>;
  record: IStoredGameRecord;
}> {
  const store = memoryGameStore();
  const created = await store.create({
    package: validPackage(),
    setup: { left: { name: 'A', players: [] }, right: { name: 'B', players: [] } },
    connected: false,
    now: new Date('2026-08-12T12:00:00.000Z'),
  });
  const record = await store.get(created.id);
  if (!record) throw new Error('test record did not persist');
  return { store, record };
}

describe('the in-game QBJ backup', () => {
  test('records a backup stamp that never satisfies the final download gate', async () => {
    const { store, record } = await activeRecord();
    expect(downloadQbj).not.toHaveBeenCalled();

    const updateSpy = vi.spyOn(store, 'update');
    render(
      <ScoringScreen
        record={record}
        store={store}
        resultDelivery={{} as unknown as ResultDeliveryService}
        connection={null}
        durable
        onComplete={() => undefined}
        onRecordChanged={() => undefined}
        onConnectionRepaired={() => undefined}
        onConnectionLost={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Game' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export / backup…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download QBJ backup' }));

    expect(downloadQbj).toHaveBeenCalledTimes(1);
    // The lifeboat records a backup stamp — never the completion gate field.
    const backupCall = updateSpy.mock.calls.findIndex(
      (call) => (call[1] as Record<string, unknown>).qbjBackupDownloadedAt !== undefined,
    );
    expect(backupCall).toBeGreaterThanOrEqual(0);
    expect(
      updateSpy.mock.calls.every(
        (call) => (call[1] as Record<string, unknown>).qbjDownloadedAt === undefined,
      ),
    ).toBe(true);
    await updateSpy.mock.results[backupCall]?.value;

    const stored = await store.get(record.id);
    expect(stored?.qbjBackupDownloadedAt).toEqual(expect.any(String));
    // The completion gate reads qbjDownloadedAt only (CompletionScreen: `downloaded =
    // record.qbjDownloadedAt !== undefined`), so leaving it unset keeps Download QBJ primary
    // when this game finishes. needsHandoff is the wrong oracle here: an unfinished game
    // owes nobody anything yet.
    expect(stored?.qbjDownloadedAt).toBeUndefined();
  });
});
