import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { MemoryDirectorRepository } from '../src/director/persistence';
import { useDirectorController } from '../src/director/state/useDirectorController';
import { directorFixture } from '../src/director/transfers/testFixtures';

async function archivedDirector() {
  const repository = new MemoryDirectorRepository();
  const state = directorFixture();
  state.tournament!.status = 'archived';
  await repository.save(state);
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return { hook, repository };
}

describe('archived Director documents', () => {
  test('ordinary commit-backed edits are centrally rejected', async () => {
    const { hook } = await archivedDirector();
    const beforeVenue = hook.result.current.state.tournament!.venue;
    const roomCount = hook.result.current.state.rooms.length;

    act(() => {
      expect(hook.result.current.updateTournament({ venue: 'Changed history' })).toBe(false);
      expect(hook.result.current.addRoom({ name: 'Historical mutation' })).toBe(false);
    });

    expect(hook.result.current.state.tournament!.status).toBe('archived');
    expect(hook.result.current.state.tournament!.venue).toBe(beforeVenue);
    expect(hook.result.current.state.rooms).toHaveLength(roomCount);
    expect(hook.result.current.error).toMatch(/archived and read-only/i);
  });

  test('explicit reopen is audited and restores ordinary editability', async () => {
    const { hook } = await archivedDirector();
    let reopened = false;
    await act(async () => {
      reopened = await hook.result.current.reopenTournament();
    });
    expect(reopened).toBe(true);
    expect(hook.result.current.state.tournament!.status).toBe('draft');
    expect(
      hook.result.current.state.audit.some(
        (entry) =>
          entry.type === 'tournament-updated' &&
          entry.details?.from === 'archived' &&
          entry.details?.to === 'draft',
      ),
    ).toBe(true);

    act(() => {
      expect(hook.result.current.updateTournament({ venue: 'Editable again' })).toBe(true);
    });
    expect(hook.result.current.state.tournament!.venue).toBe('Editable again');
  });
});
