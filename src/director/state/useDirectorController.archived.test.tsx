import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ArchivedTournamentReadOnlyNotice } from '../app/DirectorApp';
import { defaultRules, emptyDirectorState, type DirectorState } from '../domain';
import { MemoryDirectorRepository } from '../persistence';
import { useDirectorController } from './useDirectorController';

class FailingCatalogRepository extends MemoryDirectorRepository {
  failDocumentSave = false;

  override async saveDocument(...args: Parameters<MemoryDirectorRepository['saveDocument']>): Promise<void> {
    if (this.failDocumentSave) throw new Error('catalog disk full');
    await super.saveDocument(...args);
  }
}

function archivedState(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'archived-tournament',
    name: 'Historical invitational',
    date: '2026-09-05',
    venue: 'Archive hall',
    organizer: 'QBSheet',
    status: 'archived',
    timeZone: 'UTC',
    rules: structuredClone(defaultRules),
    formatId: null,
    currentPhaseId: null,
    currentPacketId: null,
    currentRoundId: null,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
  };
  return state;
}

describe('archived tournament read-only guard', () => {
  test('applies the same archive validation to an inactive catalog document', async () => {
    const repository = new MemoryDirectorRepository();
    const incomplete = archivedState();
    incomplete.tournament!.id = 'inactive-running';
    incomplete.tournament!.status = 'running';
    const current = archivedState();
    current.tournament!.id = 'current-complete';
    current.tournament!.status = 'complete';
    await repository.saveDocument(incomplete, false);
    await repository.saveDocument(current, true);

    const hook = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    const before = await repository.readTournament('inactive-running');
    await act(async () =>
      expect(await hook.result.current.archiveTournament('inactive-running')).toBe(false),
    );
    expect(hook.result.current.error).toMatch(/cannot change a running tournament to archived/i);
    expect(await repository.readTournament('inactive-running')).toEqual(before);
    hook.unmount();
  });

  test('reopens an inactive archived document with canonical audit semantics', async () => {
    const repository = new MemoryDirectorRepository();
    const inactive = archivedState();
    inactive.tournament!.id = 'inactive-archived';
    const current = archivedState();
    current.tournament!.id = 'current-complete';
    current.tournament!.status = 'complete';
    await repository.saveDocument(inactive, false);
    await repository.saveDocument(current, true);

    const hook = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await act(async () => expect(await hook.result.current.reopenTournament('inactive-archived')).toBe(true));
    expect((await repository.readTournament('inactive-archived')).tournament?.status).toBe('draft');
    expect((await repository.readTournament('inactive-archived')).audit.at(-1)).toMatchObject({
      summary: 'Reopened tournament as a draft.',
      details: { from: 'archived', to: 'draft', reason: 'explicit-reopen' },
    });
    hook.unmount();
  });

  test('preserves the inactive document when its validated save fails', async () => {
    const repository = new FailingCatalogRepository();
    const inactive = archivedState();
    inactive.tournament!.id = 'inactive-save-failure';
    inactive.tournament!.status = 'complete';
    const current = archivedState();
    current.tournament!.id = 'current-complete';
    current.tournament!.status = 'complete';
    await repository.saveDocument(inactive, false);
    await repository.saveDocument(current, true);
    const before = await repository.readTournament('inactive-save-failure');
    repository.failDocumentSave = true;

    const hook = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await act(async () =>
      expect(await hook.result.current.archiveTournament('inactive-save-failure')).toBe(false),
    );
    expect(hook.result.current.error).toMatch(/catalog disk full/i);
    expect(await repository.readTournament('inactive-save-failure')).toEqual(before);
    hook.unmount();
  });

  test('blocks controller mutation and persistence escape hatches while preserving reads', async () => {
    const repository = new MemoryDirectorRepository();
    const before = archivedState();
    await repository.save(before);
    await repository.checkpoint(before, 'Historical recovery point');

    const hook = renderHook(() => useDirectorController(repository));
    await waitFor(() => {
      expect(hook.result.current.loading).toBe(false);
      expect(hook.result.current.writerStatus).toBe('held');
    });
    const [checkpoint] = hook.result.current.checkpoints;

    act(() => {
      expect(hook.result.current.updateTournament({ name: 'Should not save' })).toBe(false);
      expect(hook.result.current.addTeam({ displayName: 'Should not save' })).toBe(false);
      expect(hook.result.current.addRoom({ name: 'Should not save' })).toBe(false);
      expect(hook.result.current.addPacket('Should not save')).toBe(false);
      expect(
        hook.result.current.addTimelineEvent({
          type: 'custom',
          title: 'Should not save',
          visibility: 'hidden',
        }),
      ).toBe(false);
      expect(hook.result.current.setTournamentStatus('draft')).toBe(false);
      hook.result.current.syncTransferVolumes([
        {
          mountPoint: '/Volumes/archived-stick',
          name: 'Archived stick',
          removable: true,
          readOnly: false,
        },
      ]);
    });
    expect(hook.result.current.state).toEqual(before);
    expect(JSON.parse(hook.result.current.exportSnapshot())).toEqual(before);

    await act(async () => {
      await expect(hook.result.current.checkpoint('Must not save')).rejects.toThrow(/archived/i);
      expect(await hook.result.current.restoreCheckpoint(checkpoint.id)).toBe(false);
      expect(
        await hook.result.current.editTournamentSnapshot(
          { ...before, metadata: { ...before.metadata, lastSavedAt: 'never' } },
          'Must not save',
        ),
      ).toBe(false);
    });
    expect(await repository.load()).toEqual(before);
    hook.unmount();
  });

  test('reopen is the audited archived write exception and restores ordinary editing', async () => {
    const repository = new MemoryDirectorRepository();
    await repository.save(archivedState());
    const hook = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    await act(async () => expect(await hook.result.current.reopenTournament()).toBe(true));
    expect(hook.result.current.state.tournament?.status).toBe('draft');
    expect(hook.result.current.state.audit.at(-1)).toMatchObject({
      type: 'tournament-updated',
      details: { from: 'archived', to: 'draft', reason: 'explicit-reopen' },
    });

    act(() => expect(hook.result.current.updateTournament({ name: 'Recovered draft' })).toBe(true));
    await waitFor(async () => expect((await repository.load()).tournament?.name).toBe('Recovered draft'));
    hook.unmount();
  });

  test('the archived chrome explains the state and offers the explicit reopen action', () => {
    const onReopen = vi.fn();
    render(<ArchivedTournamentReadOnlyNotice tournamentName="Historical invitational" onReopen={onReopen} />);

    expect(screen.getByRole('status')).toHaveTextContent(/archived tournament.*read-only/i);
    expect(screen.getByRole('status')).toHaveTextContent(/historical inspection/i);
    act(() => screen.getByRole('button', { name: 'Reopen as draft' }).click());
    expect(onReopen).toHaveBeenCalledTimes(1);
  });
});
