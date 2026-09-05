import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  formatGenerationAvailability,
  roundScheduleIsValid,
  type TeamGameScore,
} from '../src/director/domain';
import { dropTeamFlexibly } from '../src/director/state/flexibleEditing';
import { MemoryDirectorRepository } from '../src/director/persistence';
import { useDirectorController } from '../src/director/state/useDirectorController';

function score(teamId: string, value: number): TeamGameScore {
  return {
    teamId,
    score: value,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonuses: 0,
    bonusPoints: 0,
    bouncebacks: 0,
  };
}

async function directorWithSetup(teamCount = 4, roomCount = 1) {
  const repository = new MemoryDirectorRepository();
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  act(() => {
    hook.result.current.createTournament({
      name: 'Tournament-critical regressions',
      date: '2026-09-04',
      venue: 'Test hall',
      organizer: 'QBSheet',
    });
    for (let index = 0; index < teamCount; index += 1) {
      hook.result.current.addTeam({ displayName: `Team ${index + 1}` });
    }
    for (let index = 0; index < roomCount; index += 1) {
      hook.result.current.addRoom({ name: `Room ${index + 1}` });
    }
    hook.result.current.addPacket('Packet 1');
  });
  await waitFor(() => expect(hook.result.current.saving).toBe(false));
  return hook;
}

function emptySnapshotCollections() {
  return {
    results: [],
    progress: [],
    presence: [],
    sessions: [],
    help: [],
    rosterAmendments: [],
  };
}

describe('Director tournament-critical regressions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete window.__TAURI_INTERNALS__;
  });

  test('QBTCP applies matching progress, remains idempotent, rejects older progress, and protects an occupied room', async () => {
    const hook = await directorWithSetup(2, 1);
    act(() => expect(hook.result.current.generateSchedule().generated).toBe(true));
    const round = hook.result.current.state.rounds[0];
    const scheduled = hook.result.current.state.scheduledGames.find((game) => !game.bye);
    const room = hook.result.current.state.rooms[0];
    if (!round || !scheduled || !room) throw new Error('test setup did not create a room game');

    await act(async () => {
      expect((await hook.result.current.startRound(round.id)).ok).toBe(true);
    });

    const observedAt = new Date().toISOString();
    const snapshot = (sequence: number, leftScore: number) => ({
      ...emptySnapshotCollections(),
      sessions: [
        {
          sessionId: 'session-progress',
          roomId: room.id,
          matchId: scheduled.id,
          deviceId: 'device-progress',
          status: 'open',
          resumable: true,
          resultReceived: false,
          progressSequence: sequence,
          updatedAt: observedAt,
        },
      ],
      progress: [
        {
          sessionId: 'session-progress',
          roomId: room.id,
          sequence,
          matchState: {
            type: 'Match',
            tossups_read: sequence,
            match_teams: [{ points: leftScore }, { points: 10 }],
          },
          receivedAt: observedAt,
        },
      ],
    });
    const invoke = vi.fn(async () => snapshot(4, 20));
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });

    await act(async () => {
      await hook.result.current.syncQbtcp();
    });
    expect(hook.result.current.state.qbtcpSessions[0]).toMatchObject({
      state: 'live',
      progressSequence: 4,
      progress: { tossupsRead: 4, leftScore: 20, rightScore: 10 },
    });
    expect(hook.result.current.state.rooms[0]?.status).toBe('live');

    const afterFirstProgress = structuredClone(hook.result.current.state.qbtcpSessions[0]);
    await act(async () => {
      await hook.result.current.syncQbtcp();
    });
    expect(hook.result.current.state.qbtcpSessions[0]).toEqual(afterFirstProgress);

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke: vi.fn(async () => snapshot(5, 30)),
      },
    });
    await act(async () => {
      await hook.result.current.syncQbtcp();
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke: vi.fn(async () => snapshot(3, 5)),
      },
    });
    await act(async () => {
      await hook.result.current.syncQbtcp();
    });
    expect(hook.result.current.state.qbtcpSessions[0]).toMatchObject({
      progressSequence: 5,
      progress: { tossupsRead: 5, leftScore: 30, rightScore: 10 },
    });

    let secondRoundResult: ReturnType<typeof hook.result.current.generateSchedule>;
    act(() => {
      secondRoundResult = hook.result.current.generateSchedule({ roundName: 'Round 2' });
    });
    expect(secondRoundResult!).toMatchObject({ generated: true });
    const secondRound = hook.result.current.state.rounds.at(-1);
    const secondGame = secondRound
      ? hook.result.current.state.scheduledGames.find((game) => game.roundId === secondRound.id && !game.bye)
      : undefined;
    if (!secondRound || !secondGame) throw new Error('test setup did not create a second round');
    expect(secondRound.status).toBe('planned');

    // Simulate a stale room status after a synchronization defect. The live session remains the
    // authoritative occupancy signal, so a later assignment cannot be released into this room.
    const occupied = structuredClone(hook.result.current.state);
    occupied.rooms[0]!.status = 'available';
    occupied.scheduledGames.find((game) => game.id === secondGame.id)!.roomId = room.id;
    expect(roundScheduleIsValid(occupied, secondRound.id)).toBe(true);
    await act(async () => {
      expect(await hook.result.current.editTournamentSnapshot(occupied, 'Occupied room regression')).toBe(
        true,
      );
    });
    expect(hook.result.current.state.rounds.find((entry) => entry.id === secondRound.id)?.status).toBe(
      'planned',
    );
    expect(roundScheduleIsValid(hook.result.current.state, secondRound.id)).toBe(true);
    act(() => {
      expect(hook.result.current.prepareRound(secondRound.id)).toBe(true);
    });
    act(() => {
      expect(hook.result.current.releaseRound(secondRound.id)).toBe(false);
    });
    expect(hook.result.current.error).toMatch(/available|room|released/i);
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
    hook.unmount();
  });

  test('dropping a team closes a released round without losing matchup history and leaves future rounds operable', async () => {
    const hook = await directorWithSetup(4, 1);
    act(() => expect(hook.result.current.generateSchedule({ roundName: 'Round 1' }).generated).toBe(true));
    act(() => expect(hook.result.current.generateSchedule({ roundName: 'Round 2' }).generated).toBe(true));
    const round = hook.result.current.state.rounds.find((entry) => entry.name === 'Round 1');
    const futureRound = hook.result.current.state.rounds.find((entry) => entry.name === 'Round 2');
    if (!round || !futureRound) throw new Error('test setup did not create both rounds');

    await act(async () => {
      expect((await hook.result.current.startRound(round.id)).ok).toBe(true);
    });
    const roundGames = hook.result.current.state.scheduledGames.filter(
      (game) => game.roundId === round.id && !game.bye,
    );
    const affected = roundGames.find((game) => game.roomId === null);
    const unaffected = roundGames.find((game) => game.id !== affected?.id);
    if (!affected || !unaffected || !affected.rightTeamId || !unaffected.rightTeamId) {
      throw new Error('test setup did not create affected and unaffected games');
    }
    const unaffectedRightTeamId = unaffected.rightTeamId;
    act(() => {
      expect(
        hook.result.current.addManualResult({
          scheduledGameId: unaffected.id,
          scores: [score(unaffected.leftTeamId, 100), score(unaffectedRightTeamId, 80)],
        }),
      ).toBe(true);
    });

    const droppedTeamId = affected.leftTeamId;
    await act(async () => {
      expect(await dropTeamFlexibly(hook.result.current, droppedTeamId)).toBe(true);
    });
    const cancelled = hook.result.current.state.scheduledGames.find((game) => game.id === affected.id);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      leftTeamId: affected.leftTeamId,
      rightTeamId: affected.rightTeamId,
    });
    expect(roundScheduleIsValid(hook.result.current.state, round.id)).toBe(true);
    expect(roundScheduleIsValid(hook.result.current.state, futureRound.id)).toBe(true);

    act(() => {
      expect(hook.result.current.finishRound(round.id)).toMatchObject({ finished: true });
    });
    expect(hook.result.current.state.rounds.find((entry) => entry.id === round.id)?.status).toBe('closed');
    expect(hook.result.current.state.rooms[0]?.status).toBe('available');

    act(() => {
      expect(hook.result.current.prepareRound(futureRound.id)).toBe(true);
    });
    await act(async () => {
      expect((await hook.result.current.startRound(futureRound.id)).ok).toBe(true);
    });
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
    hook.unmount();
  });

  test('dropping a team keeps a planned pool round operable while retaining pool history', async () => {
    const hook = await directorWithSetup(4, 1);
    const phaseId = hook.result.current.state.phases[0]?.id;
    const teamIds = hook.result.current.state.teams.map((team) => team.id);
    if (!phaseId || teamIds.length !== 4) throw new Error('test setup did not create a pool field');
    act(() =>
      expect(hook.result.current.updateFormat({ kind: 'pools', name: 'Preliminary pools' })).toBe(true),
    );
    act(() => {
      expect(hook.result.current.addPool({ phaseId, name: 'Pool A', teamIds })).toBe(true);
      expect(hook.result.current.generateSchedule({ roundName: 'Pool 1' }).generated).toBe(true);
      expect(hook.result.current.generateSchedule({ roundName: 'Pool 2' }).generated).toBe(true);
    });
    const futureRound = hook.result.current.state.rounds.find((round) => round.name === 'Pool 2');
    if (!futureRound) throw new Error('test setup did not create a future pool round');

    await act(async () => {
      expect(await dropTeamFlexibly(hook.result.current, teamIds[0]!)).toBe(true);
    });
    expect(hook.result.current.state.pools[0]?.teamIds).toEqual(teamIds);
    expect(formatGenerationAvailability(hook.result.current.state).supported).toBe(true);
    expect(roundScheduleIsValid(hook.result.current.state, futureRound.id)).toBe(true);
    act(() => {
      expect(hook.result.current.prepareRound(futureRound.id)).toBe(true);
    });
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
    hook.unmount();
  });

  test('single-elimination completion waits for the generated final and corrections reconcile or block safely', async () => {
    const hook = await directorWithSetup(4, 2);
    const phase = hook.result.current.state.phases[0];
    if (!phase) throw new Error('test setup did not create a phase');
    act(() => expect(hook.result.current.updateFormat({ kind: 'single-elimination' })).toBe(true));
    act(() => expect(hook.result.current.generateSchedule({ roundName: 'Semifinals' }).generated).toBe(true));
    const semifinalRound = hook.result.current.state.rounds[0];
    if (!semifinalRound) throw new Error('test setup did not create semifinals');

    await act(async () => {
      expect((await hook.result.current.startRound(semifinalRound.id)).ok).toBe(true);
    });
    const semifinals = hook.result.current.state.scheduledGames.filter(
      (game) => game.roundId === semifinalRound.id && !game.bye && game.rightTeamId,
    );
    if (semifinals.length !== 2) throw new Error('test setup did not create two semifinal games');
    act(() => {
      for (const game of semifinals) {
        expect(
          hook.result.current.addManualResult({
            scheduledGameId: game.id,
            scores: [score(game.leftTeamId, 100), score(game.rightTeamId!, 80)],
          }),
        ).toBe(true);
      }
    });
    act(() => expect(hook.result.current.finishRound(semifinalRound.id).finished).toBe(true));
    expect(hook.result.current.state.phases[0]?.status).toBe('active');
    expect(formatGenerationAvailability(hook.result.current.state).supported).toBe(true);

    act(() => expect(hook.result.current.generateSchedule({ roundName: 'Final' }).generated).toBe(true));
    const finalRound = hook.result.current.state.rounds.find((round) => round.id !== semifinalRound.id);
    const final = finalRound
      ? hook.result.current.state.scheduledGames.find((game) => game.roundId === finalRound.id && !game.bye)
      : undefined;
    if (!finalRound || !final || !final.rightTeamId) throw new Error('test setup did not create a final');
    const originalFinalParticipants = [final.leftTeamId, final.rightTeamId];
    const correctedSemifinal = semifinals[0]!;
    const correctedRecord = hook.result.current.state.games.find(
      (game) => game.scheduledGameId === correctedSemifinal.id,
    );
    if (!correctedRecord || !correctedSemifinal.rightTeamId) throw new Error('missing semifinal result');
    const correctedRightTeamId = correctedSemifinal.rightTeamId;

    act(() => {
      expect(
        hook.result.current.editAcceptedResult(correctedRecord.id, [
          score(correctedSemifinal.leftTeamId, 10),
          score(correctedRightTeamId, 120),
        ]),
      ).toBe(true);
    });
    const reconciledFinal = hook.result.current.state.scheduledGames.find((game) => game.id === final.id);
    expect(reconciledFinal).toMatchObject({
      leftTeamId: expect.any(String),
      rightTeamId: expect.any(String),
      bracketKey: final.bracketKey,
    });
    expect([reconciledFinal!.leftTeamId, reconciledFinal!.rightTeamId]).not.toEqual(
      originalFinalParticipants,
    );
    expect(roundScheduleIsValid(hook.result.current.state, finalRound.id)).toBe(true);

    // Independently malformed stale state cannot pass the release gate.
    const stale = structuredClone(hook.result.current.state);
    const staleFinal = stale.scheduledGames.find((game) => game.id === final.id)!;
    staleFinal.leftTeamId = originalFinalParticipants[0];
    staleFinal.rightTeamId = originalFinalParticipants[1];
    expect(roundScheduleIsValid(stale, finalRound.id)).toBe(false);
    const validAfterRepair = structuredClone(hook.result.current.state);
    await act(async () => {
      expect(
        await hook.result.current.editTournamentSnapshot(stale, 'Stale bracket validation regression'),
      ).toBe(true);
    });
    act(() => {
      expect(hook.result.current.prepareRound(finalRound.id)).toBe(false);
    });
    await act(async () => {
      expect(
        await hook.result.current.editTournamentSnapshot(validAfterRepair, 'Restore reconciled bracket'),
      ).toBe(true);
    });

    await act(async () => {
      expect((await hook.result.current.startRound(finalRound.id)).ok).toBe(true);
    });
    // A correction cannot rewrite a dependent game once it has been released. The same guard
    // must hold if the dependent is already live, before any final result exists.
    act(() => {
      expect(
        hook.result.current.editAcceptedResult(correctedRecord.id, [
          score(correctedSemifinal.leftTeamId, 130),
          score(correctedRightTeamId, 20),
        ]),
      ).toBe(false);
    });
    const liveFinalState = structuredClone(hook.result.current.state);
    liveFinalState.scheduledGames.find((game) => game.id === final.id)!.status = 'live';
    await act(async () => {
      expect(
        await hook.result.current.editTournamentSnapshot(liveFinalState, 'Live bracket guard regression'),
      ).toBe(true);
    });
    act(() => {
      expect(
        hook.result.current.editAcceptedResult(correctedRecord.id, [
          score(correctedSemifinal.leftTeamId, 130),
          score(correctedRightTeamId, 20),
        ]),
      ).toBe(false);
    });
    const finalRecordInput = hook.result.current.state.scheduledGames.find((game) => game.id === final.id)!;
    act(() => {
      expect(
        hook.result.current.addManualResult({
          scheduledGameId: final.id,
          scores: [score(finalRecordInput.leftTeamId, 100), score(finalRecordInput.rightTeamId!, 90)],
        }),
      ).toBe(true);
    });
    const finalRecord = hook.result.current.state.games.find((game) => game.scheduledGameId === final.id);
    if (!finalRecord) throw new Error('test setup did not create final result');
    act(() => {
      expect(
        hook.result.current.editAcceptedResult(correctedRecord.id, [
          score(correctedSemifinal.leftTeamId, 130),
          score(correctedRightTeamId, 20),
        ]),
      ).toBe(false);
    });
    expect(hook.result.current.error).toMatch(/dependent bracket game|released|result/i);
    act(() => expect(hook.result.current.finishRound(finalRound.id).finished).toBe(true));
    expect(hook.result.current.state.phases[0]?.status).toBe('complete');
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
    hook.unmount();
  });
});
