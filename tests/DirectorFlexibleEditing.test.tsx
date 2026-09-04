import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { MemoryDirectorRepository } from '../src/director/persistence';
import { useDirectorController } from '../src/director/state/useDirectorController';
import { dropTeamFlexibly, removeRoundFlexibly } from '../src/director/state/flexibleEditing';

async function directorWithSetup(teamCount = 4) {
  const repository = new MemoryDirectorRepository();
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  act(() => {
    hook.result.current.createTournament({
      name: 'Flexible editing regression',
      date: '2026-09-03',
      venue: 'Test hall',
      organizer: 'QBSheet',
    });
    for (let index = 0; index < teamCount; index += 1) {
      hook.result.current.addTeam({ displayName: `Team ${index + 1}` });
    }
    hook.result.current.addRoom({ name: 'Room 1' });
    hook.result.current.addPacket('Packet 1');
  });
  await waitFor(() => expect(hook.result.current.saving).toBe(false));
  return hook;
}

describe('Director flexible editing', () => {
  test('dropping after schedule generation preserves user notes and cancels only unresolved future assignments', async () => {
    const hook = await directorWithSetup();
    const team = hook.result.current.state.teams[0];
    expect(team).toBeDefined();
    if (!team) return;

    act(() => {
      expect(hook.result.current.updateTeam(team.id, { notes: 'Arriving by bus' })).toBe(true);
      expect(hook.result.current.generateSchedule().generated).toBe(true);
    });
    const affected = hook.result.current.state.scheduledGames.filter(
      (game) => !game.bye && (game.leftTeamId === team.id || game.rightTeamId === team.id),
    );
    expect(affected.length).toBeGreaterThan(0);

    await act(async () => {
      expect(await dropTeamFlexibly(hook.result.current, team.id)).toBe(true);
    });
    expect(hook.result.current.state.teams.find((entry) => entry.id === team.id)).toMatchObject({
      status: 'dropped',
      notes: 'Arriving by bus',
    });
    expect(
      hook.result.current.state.scheduledGames
        .filter((game) => affected.some((entry) => entry.id === game.id))
        .every((game) => game.status === 'cancelled'),
    ).toBe(true);

    const auditCount = hook.result.current.state.audit.length;
    await act(async () => {
      expect(await dropTeamFlexibly(hook.result.current, team.id)).toBe(false);
    });
    expect(hook.result.current.state.audit).toHaveLength(auditCount);

    act(() => {
      expect(hook.result.current.restoreTeam(team.id)).toBe(true);
    });
    await act(async () => {
      expect(await dropTeamFlexibly(hook.result.current, team.id)).toBe(true);
    });
    expect(hook.result.current.state.teams.find((entry) => entry.id === team.id)?.notes).toBe(
      'Arriving by bus',
    );
  });

  test('round removal cleans schedule and phase references', async () => {
    const hook = await directorWithSetup();
    act(() => {
      expect(hook.result.current.generateSchedule().generated).toBe(true);
    });
    const round = hook.result.current.state.rounds[0];
    expect(round).toBeDefined();
    if (!round) return;
    const scheduledIds = hook.result.current.state.scheduledGames
      .filter((game) => game.roundId === round.id)
      .map((game) => game.id);
    expect(scheduledIds.length).toBeGreaterThan(0);

    await act(async () => {
      expect(await removeRoundFlexibly(hook.result.current, round.id)).toBe(true);
    });
    expect(hook.result.current.state.rounds.some((entry) => entry.id === round.id)).toBe(false);
    expect(hook.result.current.state.scheduledGames.some((game) => scheduledIds.includes(game.id))).toBe(
      false,
    );
    expect(hook.result.current.state.phases.some((phase) => phase.roundIds.includes(round.id))).toBe(false);
    expect(
      hook.result.current.state.packets.some((packet) => packet.assignedRoundIds.includes(round.id)),
    ).toBe(false);
  });
});
