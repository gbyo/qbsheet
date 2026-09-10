/**
 * Collapse integrity for #620: the Director has one canonical controller,
 * validation, and flexible-editing implementation — no copied `*Base` modules
 * with a wrapper seam. These tests drive every former wrapper check through
 * the canonical import paths and prove the seams are gone.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { deferredEmptyRoundIsExpected, runPreflight, type DirectorState } from '../domain';
import { dropTeamFlexibly, removeRoundFlexibly, roundRemovalBlocker } from './flexibleEditing';
import {
  canonicalAcceptedGame,
  useDirectorController,
  validateResultForScheduledGame,
} from './useDirectorController';
import { MemoryDirectorRepository } from '../persistence';
import { scheduledGame, score, team, tournamentState } from '../../../tests/directorFixtures';

async function controllerFor(state: DirectorState) {
  const repository = new MemoryDirectorRepository();
  await repository.save(state);
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

function twoRoundState(): DirectorState {
  const state = tournamentState();
  state.teams.push(team('team-a', 'Alpha'), team('team-b', 'Beta'));
  state.rounds.push({
    ...state.rounds[0]!,
    id: 'round-2',
    name: 'Round 2',
    number: 2,
    status: 'prepared',
    packetId: null,
    scheduledGameIds: [],
    scheduledStart: null,
    releasedAt: null,
  });
  state.scheduledGames.push(scheduledGame('scheduled-1', 'team-a', 'team-b', { status: 'released' }));
  return state;
}

describe('canonical controller collapse (#620)', () => {
  test('the stack base-file seams are gone', async () => {
    const controllerBase = './useDirectorControllerBase';
    const editingBase = './flexibleEditingBase';
    const validationBase = '../domain/validationBase';
    await expect(import(controllerBase)).rejects.toThrow();
    await expect(import(editingBase)).rejects.toThrow();
    await expect(import(validationBase)).rejects.toThrow();
  });

  test('canonical paths export the former base helpers', () => {
    expect(typeof useDirectorController).toBe('function');
    expect(typeof canonicalAcceptedGame).toBe('function');
    expect(typeof validateResultForScheduledGame).toBe('function');
    expect(typeof runPreflight).toBe('function');
    expect(typeof deferredEmptyRoundIsExpected).toBe('function');
    expect(typeof dropTeamFlexibly).toBe('function');
    expect(typeof removeRoundFlexibly).toBe('function');
    expect(typeof roundRemovalBlocker).toBe('function');
  });

  test('result entry still respects the released-round boundary', async () => {
    const state = tournamentState();
    state.teams.push(team('team-a', 'Alpha'), team('team-b', 'Beta'));
    state.rounds[0]!.status = 'planned';
    state.scheduledGames.push(scheduledGame('scheduled-1', 'team-a', 'team-b', { status: 'scheduled' }));
    const hook = await controllerFor(state);

    act(() => {
      expect(
        hook.result.current.addManualResult({
          scheduledGameId: 'scheduled-1',
          scores: [score('team-a', 100), score('team-b', 90)],
        }),
      ).toBe(false);
    });
    expect(hook.result.current.error).toMatch(/has not started yet/);
    act(() => {
      expect(hook.result.current.recordForfeit('scheduled-1', 'team-a')).toBe(false);
    });
    expect(hook.result.current.error).toMatch(/has not started yet/);
  });

  test('release and start still respect the unresolved-round boundary', async () => {
    const hook = await controllerFor(twoRoundState());

    act(() => {
      expect(hook.result.current.releaseRound('round-2')).toBe(false);
    });
    expect(hook.result.current.error).toMatch(/still has unresolved play/);
    let started = { ok: true };
    await act(async () => {
      started = await hook.result.current.startRound('round-2');
    });
    expect(started.ok).toBe(false);
    expect(hook.result.current.error).toMatch(/still has unresolved play/);
  });

  test('final placement commits observe the write they announce', async () => {
    const state = tournamentState();
    state.teams.push(team('team-a', 'Alpha'), team('team-b', 'Beta'));
    const hook = await controllerFor(state);

    act(() => {
      const result = hook.result.current.setFinalPlacement({ order: ['team-a', 'team-b'] });
      expect(result.applied).toBe(true);
    });
    expect(hook.result.current.state.tournament?.finalPlacement?.order).toEqual(['team-a', 'team-b']);
    expect(hook.result.current.state.audit.some((entry) => entry.type === 'final-placement-set')).toBe(true);

    act(() => {
      const result = hook.result.current.setFinalPlacement({ order: [] });
      expect(result.applied).toBe(false);
    });
  });
});
