import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { recommendTournamentPlan, type DirectorState } from '../domain';
import { MemoryDirectorRepository } from '../persistence';
import { useDirectorController } from '../state/useDirectorController';
import { RecommendedPlan } from './RecommendedPlan';

/**
 * The recommendation and the pairing engine have to agree about who is playing.
 *
 * `recommendTournamentPlan` was sized on every non-dropped team while the canonical scheduler
 * pairs confirmed teams only, so a waitlisted roster was offered a nine-round plan that the
 * scheduler then refused — throwing out of an action whose contract is a boolean.
 */
test('a waitlisted roster is not offered a plan, and applying one keeps editable structure', async () => {
  const repository = new MemoryDirectorRepository();
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  act(() => {
    hook.result.current.createTournament({ name: 'Waitlist only', date: '', venue: '', organizer: '' });
    for (let index = 1; index <= 10; index++) hook.result.current.addTeam({ displayName: `Team ${index}` });
  });
  // Waitlist status arrives through imports rather than the add form, so round-trip the document.
  const waitlisted = JSON.parse(hook.result.current.exportSnapshot()) as DirectorState;
  waitlisted.teams.forEach((team) => {
    team.status = 'waitlist';
  });
  act(() => {
    expect(hook.result.current.importSnapshot(waitlisted)).toBe(true);
  });
  expect(hook.result.current.state.teams.every((team) => team.status === 'waitlist')).toBe(true);

  render(
    <RecommendedPlan
      state={hook.result.current.state}
      controller={hook.result.current}
      onNavigate={vi.fn()}
      onAnnounce={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: /Use this plan/i })).toBeNull();

  // Applied directly, the plan still materializes its rounds and leaves pairings to the director
  // rather than throwing out of the action.
  act(() => {
    expect(hook.result.current.applyTournamentPlan(recommendTournamentPlan(10)!.recommended)).toBe(true);
  });
  expect(hook.result.current.state.rounds).toHaveLength(9);
  expect(hook.result.current.state.scheduledGames).toEqual([]);
  expect(hook.result.current.state.rounds.every((round) => round.scheduledGameIds.length === 0)).toBe(true);
  expect(
    hook.result.current.state.audit.some(
      (entry) => entry.type === 'format-changed' && entry.details?.pairingsDeferred,
    ),
  ).toBe(true);
  hook.unmount();
});

test('a confirmed roster is offered the plan and materializes its full rotation', async () => {
  const repository = new MemoryDirectorRepository();
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  act(() => {
    hook.result.current.createTournament({ name: 'Next Saturday', date: '', venue: '', organizer: '' });
    for (let index = 1; index <= 10; index++) hook.result.current.addTeam({ displayName: `Team ${index}` });
  });
  render(
    <RecommendedPlan
      state={hook.result.current.state}
      controller={hook.result.current}
      onNavigate={vi.fn()}
      onAnnounce={vi.fn()}
    />,
  );
  expect(screen.getAllByRole('button', { name: /Use this plan/i }).length).toBeGreaterThan(0);
  act(() => {
    expect(hook.result.current.applyTournamentPlan(recommendTournamentPlan(10)!.recommended)).toBe(true);
  });
  expect(hook.result.current.state.scheduledGames).toHaveLength(45);
  expect(
    hook.result.current.state.audit.some(
      (entry) => entry.type === 'format-changed' && entry.details?.pairingsDeferred,
    ),
  ).toBe(false);
  hook.unmount();
});
