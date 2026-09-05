import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  formatGenerationAvailability,
  roomIsAssignable,
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

  test('a resumable abandoned session cannot free an unresolved room, but cancellation releases it', async () => {
    const hook = await directorWithSetup(2, 1);
    act(() => expect(hook.result.current.generateSchedule({ roundName: 'Round 1' }).generated).toBe(true));
    const firstRound = hook.result.current.state.rounds[0];
    const firstGame = hook.result.current.state.scheduledGames.find((game) => !game.bye);
    const room = hook.result.current.state.rooms[0];
    if (!firstRound || !firstGame || !room) throw new Error('test setup did not create the first room game');
    await act(async () => {
      expect((await hook.result.current.startRound(firstRound.id)).ok).toBe(true);
    });

    const stale = structuredClone(hook.result.current.state);
    stale.rooms[0]!.status = 'available';
    stale.qbtcpSessions = [
      {
        roomId: room.id,
        sessionId: 'resumable-abandoned',
        matchId: firstGame.id,
        deviceId: 'device-1',
        state: 'abandoned',
        resumable: true,
        resultReceived: false,
        progressSequence: 4,
        lastSeenAt: '2000-01-01T00:00:00.000Z',
        progress: null,
        helpRequestId: null,
      },
    ];
    await act(async () => {
      expect(await hook.result.current.editTournamentSnapshot(stale, 'Resumable room reservation')).toBe(
        true,
      );
    });
    expect(roomIsAssignable(hook.result.current.state, room.id)).toBe(false);

    act(() => expect(hook.result.current.generateSchedule({ roundName: 'Round 2' }).generated).toBe(true));
    const secondRound = hook.result.current.state.rounds.find((round) => round.name === 'Round 2');
    const secondGame = secondRound
      ? hook.result.current.state.scheduledGames.find((game) => game.roundId === secondRound.id && !game.bye)
      : undefined;
    if (!secondGame) throw new Error('test setup did not create the second game');
    expect(secondGame.roomId).toBeNull();

    act(() =>
      expect(hook.result.current.cancelScheduledGame(firstGame.id, 'Resolved administratively')).toBe(true),
    );
    expect(roomIsAssignable(hook.result.current.state, room.id)).toBe(true);
    hook.unmount();
  });

  test('a paired session keeps its released game room-reserved until that game is resolved', async () => {
    const hook = await directorWithSetup(2, 1);
    act(() => expect(hook.result.current.generateSchedule({ roundName: 'Round 1' }).generated).toBe(true));
    const firstRound = hook.result.current.state.rounds[0];
    const firstGame = hook.result.current.state.scheduledGames.find((game) => !game.bye);
    const room = hook.result.current.state.rooms[0];
    if (!firstRound || !firstGame || !room) throw new Error('test setup did not create the first room game');
    await act(async () => {
      expect((await hook.result.current.startRound(firstRound.id)).ok).toBe(true);
    });

    const paired = structuredClone(hook.result.current.state);
    paired.rooms[0]!.status = 'available';
    paired.qbtcpSessions = [
      {
        roomId: room.id,
        sessionId: 'paired-session',
        matchId: firstGame.id,
        deviceId: 'device-1',
        state: 'paired',
        resumable: true,
        resultReceived: false,
        progressSequence: 0,
        lastSeenAt: new Date().toISOString(),
        progress: null,
        helpRequestId: null,
      },
    ];
    await act(async () => {
      expect(await hook.result.current.editTournamentSnapshot(paired, 'Paired room reservation')).toBe(true);
    });
    expect(roomIsAssignable(hook.result.current.state, room.id)).toBe(false);

    act(() => expect(hook.result.current.generateSchedule({ roundName: 'Round 2' }).generated).toBe(true));
    const secondGame = hook.result.current.state.scheduledGames.find(
      (game) => game.roundId !== firstRound.id && !game.bye,
    );
    expect(secondGame?.roomId).toBeNull();
    act(() =>
      expect(hook.result.current.cancelScheduledGame(firstGame.id, 'Resolved administratively')).toBe(true),
    );
    expect(roomIsAssignable(hook.result.current.state, room.id)).toBe(true);
    hook.unmount();
  });

  test('team drops block every operational game state without changing tournament state', async () => {
    const hook = await directorWithSetup(2, 1);
    act(() => expect(hook.result.current.generateSchedule().generated).toBe(true));
    const round = hook.result.current.state.rounds[0];
    const game = hook.result.current.state.scheduledGames.find((entry) => !entry.bye);
    if (!round || !game) throw new Error('test setup did not create a game');
    await act(async () => expect((await hook.result.current.startRound(round.id)).ok).toBe(true));
    const teamId = game.leftTeamId;

    for (const status of ['released', 'live', 'submitted'] as const) {
      if (status !== 'released') {
        const next = structuredClone(hook.result.current.state);
        next.scheduledGames.find((entry) => entry.id === game.id)!.status = status;
        await act(async () => {
          expect(await hook.result.current.editTournamentSnapshot(next, `Drop guard ${status}`)).toBe(true);
        });
      }
      const before = structuredClone(hook.result.current.state);
      await act(async () => expect(dropTeamFlexibly(hook.result.current, teamId)).resolves.toBe(false));
      expect(hook.result.current.state).toEqual(before);
      expect(hook.result.current.error).toMatch(/resolve.*(round|game)|unresolved/i);
    }

    act(() =>
      expect(hook.result.current.cancelScheduledGame(game.id, 'Administrative resolution')).toBe(true),
    );
    await act(async () => expect(dropTeamFlexibly(hook.result.current, teamId)).resolves.toBe(true));
    expect(hook.result.current.state.teams.find((team) => team.id === teamId)?.status).toBe('dropped');
    hook.unmount();
  });

  test('a cancelled elimination game is refused, and a legacy one regenerates with distinct ids', async () => {
    const hook = await directorWithSetup(2, 1);
    act(() => expect(hook.result.current.updateFormat({ kind: 'single-elimination' })).toBe(true));
    act(() =>
      expect(hook.result.current.generateSchedule({ roundName: 'Opening game' }).generated).toBe(true),
    );
    const originalRound = hook.result.current.state.rounds[0];
    const originalGame = hook.result.current.state.scheduledGames.find((game) => !game.bye);
    if (!originalRound || !originalGame || !originalGame.rightTeamId) {
      throw new Error('test setup did not create the opening elimination game');
    }

    await act(async () => {
      expect((await hook.result.current.startRound(originalRound.id)).ok).toBe(true);
    });

    // Cancelling an elimination game would strand the bracket without a winner, so the controller
    // refuses it and asks for a forfeit or an explicit administrative decision instead.
    act(() => {
      expect(hook.result.current.cancelScheduledGame(originalGame.id, 'Recovery regression')).toBe(false);
    });
    expect(
      hook.result.current.state.scheduledGames.find((game) => game.id === originalGame.id)?.status,
    ).not.toBe('cancelled');
    await waitFor(() => expect(hook.result.current.error).toMatch(/forfeit|administrative|winner/i));

    // A cancelled row can still arrive from a recovered document written before that rule existed.
    // Regeneration must then mint fresh identifiers rather than collide with the abandoned round.
    const legacy = structuredClone(hook.result.current.state);
    legacy.scheduledGames.find((game) => game.id === originalGame.id)!.status = 'cancelled';
    await act(async () => {
      expect(await hook.result.current.editTournamentSnapshot(legacy, 'Legacy cancelled elimination')).toBe(
        true,
      );
    });

    act(() => {
      expect(hook.result.current.generateSchedule({ roundName: 'Replacement game' }).generated).toBe(true);
    });
    const replacementRound = hook.result.current.state.rounds.find((round) => round.id !== originalRound.id);
    const replacementGame = hook.result.current.state.scheduledGames.find(
      (game) => game.bracketKey === originalGame.bracketKey && game.status === 'scheduled',
    );
    if (!replacementRound || !replacementGame)
      throw new Error('test setup did not regenerate the bracket game');
    expect(replacementRound.id).not.toBe(originalRound.id);
    expect(replacementGame.id).not.toBe(originalGame.id);
    expect(replacementGame).toMatchObject({
      roundId: replacementRound.id,
      leftTeamId: originalGame.leftTeamId,
      rightTeamId: originalGame.rightTeamId,
      bracketKey: originalGame.bracketKey,
    });
    expect(roundScheduleIsValid(hook.result.current.state, originalRound.id)).toBe(true);
    expect(roundScheduleIsValid(hook.result.current.state, replacementRound.id)).toBe(true);
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
    const acceptedHistoryId = hook.result.current.state.games.find(
      (game) => game.scheduledGameId === unaffected.id,
    )?.id;
    if (!acceptedHistoryId) throw new Error('test setup did not retain the accepted history record');

    const droppedTeamId = affected.leftTeamId;
    const beforeBlockedDrop = structuredClone(hook.result.current.state);
    await act(async () => {
      expect(await dropTeamFlexibly(hook.result.current, droppedTeamId)).toBe(false);
    });
    expect(hook.result.current.state.scheduledGames).toEqual(beforeBlockedDrop.scheduledGames);
    expect(hook.result.current.state.teams.find((team) => team.id === droppedTeamId)?.status).toBe(
      'confirmed',
    );
    expect(hook.result.current.error).toMatch(/resolve.*(round|game)|unresolved/i);

    act(() => expect(hook.result.current.cancelScheduledGame(affected.id, 'Room unavailable')).toBe(true));
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
    expect(hook.result.current.state.games.find((game) => game.id === acceptedHistoryId)).toMatchObject({
      status: 'accepted',
      scheduledGameId: unaffected.id,
    });
    const afterDrop = structuredClone(hook.result.current.state);
    await act(async () => {
      expect(await dropTeamFlexibly(hook.result.current, droppedTeamId)).toBe(false);
    });
    expect(hook.result.current.state).toEqual(afterDrop);

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

  test('a pending review keeps an accepted game operationally unresolved', async () => {
    const hook = await directorWithSetup(2, 1);
    act(() => expect(hook.result.current.generateSchedule().generated).toBe(true));
    const game = hook.result.current.state.scheduledGames.find((entry) => !entry.bye);
    if (!game || !game.leftTeamId || !game.rightTeamId) throw new Error('test setup did not create a game');
    const leftTeamId = game.leftTeamId;
    const rightTeamId = game.rightTeamId;
    act(() =>
      expect(
        hook.result.current.addManualResult({
          scheduledGameId: game.id,
          scores: [score(leftTeamId, 100), score(rightTeamId, 80)],
        }),
      ).toBe(true),
    );
    const accepted = structuredClone(hook.result.current.state);
    const acceptedSubmission = accepted.submissions[0];
    if (!acceptedSubmission) throw new Error('test setup did not create an accepted submission');
    accepted.submissions.push({
      ...structuredClone(acceptedSubmission),
      id: 'late-review',
      status: 'review',
      reason: 'Late conflicting result',
      acceptedAt: undefined,
      acceptedBy: undefined,
    });
    await act(async () => {
      expect(await hook.result.current.editTournamentSnapshot(accepted, 'Pending review regression')).toBe(
        true,
      );
    });
    const beforeDrop = structuredClone(hook.result.current.state);
    await act(async () => expect(await dropTeamFlexibly(hook.result.current, game.leftTeamId)).toBe(false));
    expect(hook.result.current.state).toEqual(beforeDrop);
    expect(hook.result.current.error).toMatch(/resolve|unresolved|review/i);
    hook.unmount();
  });

  test('flexible team drops cannot cancel a planned elimination slot', async () => {
    const hook = await directorWithSetup(4, 2);
    act(() => expect(hook.result.current.updateFormat({ kind: 'single-elimination' })).toBe(true));
    act(() => expect(hook.result.current.generateSchedule({ roundName: 'Semifinals' }).generated).toBe(true));
    const semifinal = hook.result.current.state.scheduledGames.find((game) => game.bracketKey && !game.bye);
    if (!semifinal) throw new Error('test setup did not create a planned elimination game');
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
    const beforeDrop = structuredClone(hook.result.current.state);
    await act(async () =>
      expect(await dropTeamFlexibly(hook.result.current, semifinal.leftTeamId)).toBe(false),
    );
    expect(hook.result.current.state).toEqual(beforeDrop);
    expect(hook.result.current.error).toMatch(/planned elimination|forfeit|resolution/i);
    hook.unmount();
  });

  test('elimination cancellation is blocked and an explicit forfeit advances a valid final', async () => {
    const hook = await directorWithSetup(4, 2);
    act(() => expect(hook.result.current.updateFormat({ kind: 'single-elimination' })).toBe(true));
    act(() => expect(hook.result.current.generateSchedule({ roundName: 'Semifinals' }).generated).toBe(true));
    const semifinalRound = hook.result.current.state.rounds[0];
    if (!semifinalRound) throw new Error('test setup did not create the semifinal round');
    await act(async () => {
      expect((await hook.result.current.startRound(semifinalRound.id)).ok).toBe(true);
    });
    const semifinals = hook.result.current.state.scheduledGames.filter(
      (game) => game.roundId === semifinalRound.id && !game.bye && game.rightTeamId,
    );
    if (semifinals.length !== 2) throw new Error('test setup did not create two semifinals');
    const beforeCancel = structuredClone(hook.result.current.state.scheduledGames);
    act(() => expect(hook.result.current.cancelScheduledGame(semifinals[0]!.id, 'Room closed')).toBe(false));
    expect(hook.result.current.error).toMatch(/winner|forfeit|administrative/i);
    expect(hook.result.current.state.scheduledGames).toEqual(beforeCancel);

    act(() => {
      expect(hook.result.current.recordForfeit(semifinals[0]!.id, semifinals[0]!.leftTeamId)).toBe(true);
      expect(
        hook.result.current.addManualResult({
          scheduledGameId: semifinals[1]!.id,
          scores: [score(semifinals[1]!.leftTeamId, 100), score(semifinals[1]!.rightTeamId!, 80)],
        }),
      ).toBe(true);
    });
    expect(
      hook.result.current.state.games.find((game) => game.scheduledGameId === semifinals[0]!.id),
    ).toMatchObject({
      status: 'forfeit',
      forfeitedTeamId: semifinals[0]!.leftTeamId,
    });
    act(() => expect(hook.result.current.finishRound(semifinalRound.id).finished).toBe(true));
    act(() => expect(hook.result.current.generateSchedule({ roundName: 'Final' }).generated).toBe(true));
    const finalRound = hook.result.current.state.rounds.find((round) => round.id !== semifinalRound.id);
    const final = finalRound
      ? hook.result.current.state.scheduledGames.find((game) => game.roundId === finalRound.id && !game.bye)
      : undefined;
    if (!final || !final.rightTeamId) throw new Error('test setup did not create the final');
    const forfeitingWinner = semifinals[0]!.rightTeamId;
    expect([final.leftTeamId, final.rightTeamId]).toContain(forfeitingWinner);
    expect([final.leftTeamId, final.rightTeamId]).toContain(semifinals[1]!.leftTeamId);
    act(() => {
      expect(hook.result.current.recordForfeit(semifinals[0]!.id, semifinals[0]!.leftTeamId)).toBe(false);
    });
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
    hook.unmount();
  });

  test('legacy cancelled elimination state cannot close without a replacement outcome', async () => {
    const hook = await directorWithSetup(4, 2);
    act(() => expect(hook.result.current.updateFormat({ kind: 'single-elimination' })).toBe(true));
    act(() => expect(hook.result.current.generateSchedule({ roundName: 'Semifinals' }).generated).toBe(true));
    const semifinalRound = hook.result.current.state.rounds[0];
    if (!semifinalRound) throw new Error('test setup did not create the semifinal round');
    await act(async () => {
      expect((await hook.result.current.startRound(semifinalRound.id)).ok).toBe(true);
    });
    const semifinals = hook.result.current.state.scheduledGames.filter(
      (game) => game.roundId === semifinalRound.id && !game.bye && game.rightTeamId,
    );
    if (semifinals.length !== 2) throw new Error('test setup did not create two semifinals');
    act(() => {
      expect(
        hook.result.current.addManualResult({
          scheduledGameId: semifinals[1]!.id,
          scores: [score(semifinals[1]!.leftTeamId, 100), score(semifinals[1]!.rightTeamId!, 80)],
        }),
      ).toBe(true);
    });
    const legacy = structuredClone(hook.result.current.state);
    legacy.scheduledGames.find((game) => game.id === semifinals[0]!.id)!.status = 'cancelled';
    await act(async () => {
      expect(await hook.result.current.editTournamentSnapshot(legacy, 'Legacy cancelled elimination')).toBe(
        true,
      );
    });

    let finished: ReturnType<typeof hook.result.current.finishRound> | undefined;
    act(() => {
      finished = hook.result.current.finishRound(semifinalRound.id);
    });
    expect(finished?.finished).toBe(false);
    await waitFor(() => expect(hook.result.current.error).toMatch(/cancelled game|replacement|resolution/i));
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
    const tieCandidate = semifinals[0]!;
    const tieRecord = hook.result.current.state.games.find(
      (game) => game.scheduledGameId === tieCandidate.id,
    );
    if (!tieRecord || !tieCandidate.rightTeamId)
      throw new Error('missing semifinal result for tie correction');
    act(() => {
      expect(
        hook.result.current.editAcceptedResult(tieRecord.id, [
          score(tieCandidate.leftTeamId, 100),
          score(tieCandidate.rightTeamId!, 100),
        ]),
      ).toBe(false);
    });
    expect(hook.result.current.state.games.find((game) => game.id === tieRecord.id)?.scores).toEqual(
      tieRecord.scores,
    );
    expect(hook.result.current.error).toMatch(/single-elimination|decisive/i);
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
    const correctedSemifinal = tieCandidate;
    const correctedRecord = tieRecord;
    const correctedRightTeamId = correctedSemifinal.rightTeamId!;

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
