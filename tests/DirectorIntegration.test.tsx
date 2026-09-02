import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  defaultRules,
  deriveTeamStandings,
  emptyDirectorState,
  formatGenerationAvailability,
  generateRoundRobinRound,
  packetUseConflicts,
  previewAdvancement,
  runPreflight,
  scheduleIsValid,
  type DirectorState,
  type TeamGameScore,
} from '../src/director/domain';
import { useDirectorController } from '../src/director/state/useDirectorController';
import {
  IndexedDbDirectorRepository,
  MemoryDirectorRepository,
  type DirectorRepository,
} from '../src/director/persistence';
import { normalizeDirectorState } from '../src/director/persistence/stateMigrations';
import { exportArchiveBytes, importArchiveBytes } from '../src/director/format/interchange';

function score(teamId: string, value: number): TeamGameScore {
  return {
    teamId,
    score: value,
    powers: 0,
    gets: 0,
    negs: 0,
    bonuses: 0,
    bonusPoints: 0,
    bouncebacks: 0,
  };
}

function acceptedGame(
  id: string,
  roundId: string,
  leftTeamId: string,
  leftScore: number,
  rightTeamId: string,
  rightScore: number,
): DirectorState['games'][number] {
  return {
    id,
    scheduledGameId: `scheduled-${id}`,
    roundId,
    packetId: null,
    status: 'accepted',
    scores: [score(leftTeamId, leftScore), score(rightTeamId, rightScore)],
    playerStats: [],
    source: 'manual',
    detailedStats: 'unknown',
    acceptedAt: id,
  };
}

function scheduledForGame(
  game: DirectorState['games'][number],
  leftTeamId: string,
  rightTeamId: string,
  overrides: Partial<DirectorState['scheduledGames'][number]> = {},
): DirectorState['scheduledGames'][number] {
  return {
    id: game.scheduledGameId,
    roundId: game.roundId,
    poolId: null,
    roomId: null,
    packetId: null,
    leftTeamId,
    rightTeamId,
    bye: false,
    status: 'accepted',
    assignmentRevision: 1,
    ...overrides,
  };
}

function team(id: string, status: DirectorState['teams'][number]['status'] = 'confirmed') {
  return {
    id,
    organizationId: null,
    displayName: id,
    teamLetter: '',
    seed: null,
    status,
    createdAt: '',
    updatedAt: '',
  } satisfies DirectorState['teams'][number];
}

async function directorWithSetup(teamCount = 2) {
  const repository = new MemoryDirectorRepository();
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  act(() => {
    hook.result.current.createTournament({
      name: 'Director regression',
      date: '2026-09-01',
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
  return { hook, repository };
}

describe('Director integration hardening', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete window.__TAURI_INTERNALS__;
  });

  test('portable archives preserve operational state losslessly', () => {
    const state = emptyDirectorState();
    state.tournament = {
      id: 'tournament-archive',
      name: 'Archive fidelity',
      date: '2026-09-01',
      venue: 'Main hall',
      organizer: 'Director',
      status: 'running',
      rules: structuredClone(defaultRules),
      formatId: null,
      currentPhaseId: null,
      currentPacketId: null,
      currentRoundId: null,
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T11:00:00.000Z',
    };
    state.players = [
      {
        id: 'player-1',
        teamId: 'team-1',
        name: 'Ada',
        captain: true,
        active: true,
        rosterNumber: '07',
        notes: 'late arrival',
      },
    ];
    state.qbtcpSessions = [
      {
        roomId: 'room-1',
        sessionId: 'session-1',
        matchId: 'match-1',
        deviceId: 'device-1',
        operatorName: 'Scorekeeper',
        state: 'abandoned',
        resumable: true,
        resultReceived: false,
        progressSequence: 9,
        lastSeenAt: '2026-09-01T11:02:00.000Z',
        progress: { tossupsRead: 8, leftScore: 75, rightScore: 60 },
        helpRequestId: 'help-1',
      },
    ];
    state.qbtcpHelpRequests = [
      {
        id: 'help-1',
        roomId: 'room-1',
        roomName: 'Room 1',
        category: 'equipment-technical',
        message: 'Buzzer is not responding',
        status: 'open',
        createdAt: '2026-09-01T11:01:00.000Z',
        updatedAt: '2026-09-01T11:01:00.000Z',
        deviceId: 'device-1',
        operatorName: 'Scorekeeper',
        currentMatchup: { roundNumber: 1, leftTeam: 'North', rightTeam: 'South' },
      },
    ];
    state.qbtcpRosterAmendments = [
      { sessionId: 'session-1', amendment: { playerName: 'Ada', teamId: 'team-1', created: true } },
    ];

    const imported = importArchiveBytes(exportArchiveBytes(state));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.state).toEqual(state);
  });

  test('unsupported formats never fall back to round-robin generation', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.updateFormat({ kind: 'swiss', name: 'Swiss' }));

    let result: { conflicts: string[] } | undefined;
    act(() => {
      result = hook.result.current.generateSchedule({ seed: 1 });
    });

    expect(result?.conflicts.join(' ')).toMatch(/not implemented/i);
    expect(hook.result.current.state.rounds).toHaveLength(0);
    expect(hook.result.current.state.scheduledGames).toHaveLength(0);
  });

  test('pool formats require exclusive complete membership before generation', async () => {
    const { hook } = await directorWithSetup(4);
    const phaseId = hook.result.current.state.phases[0]?.id;
    const teamIds = hook.result.current.state.teams.map((entry) => entry.id);
    if (!phaseId || teamIds.length !== 4) throw new Error('test setup did not create the pool field');
    act(() => hook.result.current.updateFormat({ kind: 'pools', name: 'Preliminary pools' }));

    let added = false;
    act(() => {
      added = hook.result.current.addPool({ phaseId, name: 'Pool A', teamIds: teamIds.slice(0, 2) });
    });
    expect(added).toBe(true);

    let incomplete: { generated: boolean; conflicts: string[] } | undefined;
    act(() => {
      incomplete = hook.result.current.generateSchedule();
    });
    expect(incomplete?.generated).toBe(false);
    expect(incomplete?.conflicts.join(' ')).toMatch(/not assigned to a pool/i);
    expect(hook.result.current.state.rounds).toHaveLength(0);

    act(() => {
      expect(hook.result.current.addPool({ phaseId, name: 'Pool B', teamIds: teamIds.slice(2) })).toBe(true);
    });
    let complete: { generated: boolean; conflicts: string[] } | undefined;
    act(() => {
      complete = hook.result.current.generateSchedule();
    });
    expect(complete?.generated).toBe(true);
    expect(hook.result.current.state.scheduledGames).toHaveLength(2);
    expect(new Set(hook.result.current.state.scheduledGames.map((game) => game.poolId)).size).toBe(2);
  });

  test('playoff pools can generate from advancing teams without reassigning the full field', async () => {
    const { hook } = await directorWithSetup(4);
    const phaseId = hook.result.current.state.phases[0]?.id;
    const advancingTeamIds = hook.result.current.state.teams.slice(0, 2).map((entry) => entry.id);
    if (!phaseId || advancingTeamIds.length !== 2)
      throw new Error('test setup did not create playoff entrants');

    act(() => hook.result.current.updateFormat({ kind: 'playoff-pools', name: 'Playoff pools' }));
    act(() => {
      expect(
        hook.result.current.addPool({ phaseId, name: 'Championship pool', teamIds: advancingTeamIds }),
      ).toBe(true);
    });

    expect(formatGenerationAvailability(hook.result.current.state).supported).toBe(true);
    let result: { generated: boolean; conflicts: string[] } | undefined;
    act(() => {
      result = hook.result.current.generateSchedule();
    });

    expect(result?.generated).toBe(true);
    expect(hook.result.current.state.scheduledGames).toHaveLength(1);
    expect(
      new Set(
        hook.result.current.state.scheduledGames.flatMap((game) =>
          game.rightTeamId ? [game.leftTeamId, game.rightTeamId] : [game.leftTeamId],
        ),
      ),
    ).toEqual(new Set(advancingTeamIds));
  });

  test('pool generation availability explains incomplete membership before the generate action', async () => {
    const { hook } = await directorWithSetup(4);
    const phaseId = hook.result.current.state.phases[0]?.id;
    const teamIds = hook.result.current.state.teams.map((entry) => entry.id);
    if (!phaseId || teamIds.length !== 4) throw new Error('test setup did not create the pool field');
    act(() => hook.result.current.updateFormat({ kind: 'pools', name: 'Preliminary pools' }));
    act(() => {
      expect(hook.result.current.addPool({ phaseId, name: 'Pool A', teamIds: teamIds.slice(0, 2) })).toBe(
        true,
      );
    });

    const availability = formatGenerationAvailability(hook.result.current.state);
    expect(availability.supported).toBe(false);
    expect(availability.message).toMatch(/every confirmed team/i);
    expect(
      runPreflight(hook.result.current.state).some((issue) => issue.id === 'format-generation-unavailable'),
    ).toBe(true);
  });

  test('player roster entry rejects an active duplicate and supports captain assignment', async () => {
    const { hook } = await directorWithSetup();
    const teamId = hook.result.current.state.teams[0]?.id;
    if (!teamId) throw new Error('test setup did not create a team');
    act(() => {
      expect(hook.result.current.addPlayer(teamId, 'Ada', true)).toBe(true);
    });
    expect(hook.result.current.state.players).toContainEqual(
      expect.objectContaining({ teamId, name: 'Ada', captain: true, active: true }),
    );
    act(() => {
      expect(hook.result.current.addPlayer(teamId, ' ada ')).toBe(false);
    });
    expect(hook.result.current.state.players.filter((player) => player.teamId === teamId)).toHaveLength(1);
  });

  test('unavailable room resources can be restored and block release until they are ready', async () => {
    const { hook } = await directorWithSetup();
    act(() => {
      hook.result.current.addStaff({ name: 'Moderator One', roles: ['moderator'] });
      hook.result.current.addEquipment({ name: 'Buzzer One', kind: 'buzzer' });
    });
    const staffId = hook.result.current.state.staff[0]?.id;
    const equipmentId = hook.result.current.state.equipment[0]?.id;
    const roomId = hook.result.current.state.rooms[0]?.id;
    if (!staffId || !equipmentId || !roomId) throw new Error('test setup did not create room resources');

    act(() => {
      hook.result.current.updateRoom(roomId, { moderatorId: staffId, equipmentId });
      expect(hook.result.current.updateStaff(staffId, { available: false })).toBe(true);
      expect(hook.result.current.updateEquipment(equipmentId, { available: false })).toBe(true);
    });
    expect(runPreflight(hook.result.current.state).map((issue) => issue.id)).toEqual(
      expect.arrayContaining([`staff-unavailable-${staffId}`, `equipment-unavailable-${equipmentId}`]),
    );

    act(() => hook.result.current.generateSchedule());
    const roundId = hook.result.current.state.rounds[0]?.id;
    if (!roundId) throw new Error('test setup did not generate a round');
    act(() => {
      expect(hook.result.current.prepareRound(roundId)).toBe(true);
    });
    let released = true;
    act(() => {
      released = hook.result.current.releaseRound(roundId);
    });
    expect(released).toBe(false);
    expect(hook.result.current.error).toMatch(/unavailable but assigned/i);

    act(() => {
      expect(hook.result.current.updateStaff(staffId, { available: true })).toBe(true);
    });
    released = true;
    act(() => {
      released = hook.result.current.releaseRound(roundId);
    });
    expect(released).toBe(false);
    expect(hook.result.current.error).toMatch(/unavailable but assigned/i);

    act(() => {
      expect(hook.result.current.updateEquipment(equipmentId, { available: true })).toBe(true);
    });
    act(() => {
      released = hook.result.current.releaseRound(roundId);
    });
    expect(released).toBe(true);
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
  });

  test('format type changes are blocked after schedule generation', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.generateSchedule());
    act(() => hook.result.current.updateFormat({ kind: 'pools' }));

    expect(hook.result.current.state.formats[0]?.kind).toBe('round-robin');
    expect(hook.result.current.error).toMatch(/locked after schedule generation/i);
  });

  test('browser preflight omits the native-only QBTCP recommendation', async () => {
    const { hook } = await directorWithSetup();
    const browserIssues = runPreflight(hook.result.current.state, false, false);
    const nativeIssues = runPreflight(hook.result.current.state, false, true);

    expect(browserIssues.some((issue) => issue.id === 'qbtcp-offline')).toBe(false);
    expect(nativeIssues.some((issue) => issue.id === 'qbtcp-offline')).toBe(true);
  });

  test('forbidden byes reject the generation without mutating state', async () => {
    const { hook } = await directorWithSetup(3);
    act(() => hook.result.current.updateFormat({ allowByes: false }));
    const before = structuredClone(hook.result.current.state);

    act(() => {
      hook.result.current.generateSchedule({ seed: 2 });
    });

    expect(hook.result.current.state.rounds).toEqual(before.rounds);
    expect(hook.result.current.state.scheduledGames).toEqual(before.scheduledGames);
    expect(hook.result.current.state.tournament?.currentRoundId).toBe(before.tournament?.currentRoundId);
  });

  test('a bye does not consume a room slot', async () => {
    const { hook } = await directorWithSetup(3);
    act(() => {
      hook.result.current.generateSchedule({ seed: 3 });
    });

    const games = hook.result.current.state.scheduledGames;
    expect(games).toHaveLength(2);
    expect(games.filter((game) => game.bye)).toHaveLength(1);
    expect(games.filter((game) => !game.bye)[0]?.roomId).toBe(hook.result.current.state.rooms[0]?.id);
    expect(games.find((game) => game.bye)?.roomId).toBeNull();
  });

  test('round generation preserves every eligible team across field sizes and seeds', () => {
    for (const teamCount of [2, 3, 4, 5, 6, 7, 8, 9]) {
      const state = emptyDirectorState();
      state.teams = Array.from({ length: teamCount }, (_, index) => team(`team-${index + 1}`));
      for (const seed of [1, 7, 19]) {
        const generated = generateRoundRobinRound(state, { seed, roomIds: [] });
        expect(generated.hardFailure).toBe(false);
        expect(scheduleIsValid(generated.games, state.teams, { expectedByeCount: teamCount % 2 })).toBe(true);
        const appearances = new Map<string, number>();
        for (const game of generated.games) {
          appearances.set(game.leftTeamId, (appearances.get(game.leftTeamId) ?? 0) + 1);
          if (game.rightTeamId)
            appearances.set(game.rightTeamId, (appearances.get(game.rightTeamId) ?? 0) + 1);
        }
        expect([...appearances.values()].every((count) => count === 1)).toBe(true);
        expect(appearances.size).toBe(teamCount);
      }
    }
  });

  test('manual results validate explicitly, allow negative totals, and retain incomplete stats', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.generateSchedule());
    const scheduled = hook.result.current.state.scheduledGames[0];
    if (!scheduled || !scheduled.leftTeamId || !scheduled.rightTeamId) {
      throw new Error('test setup did not generate a two-team game');
    }
    const rightTeamId = scheduled.rightTeamId;

    act(() => {
      hook.result.current.addManualResult({
        scheduledGameId: scheduled.id,
        scores: [score(scheduled.leftTeamId, -5), score(rightTeamId, 10)],
      });
    });
    const accepted = hook.result.current.state.games[0];
    expect(accepted?.scores[0]?.score).toBe(-5);
    expect(accepted?.detailedStats).toBe('unknown');
    expect(hook.result.current.state.packets[0]?.usedGameIds).toEqual([scheduled.id]);

    const gameCount = hook.result.current.state.games.length;
    act(() => {
      hook.result.current.addManualResult({
        scheduledGameId: scheduled.id,
        scores: [score(scheduled.leftTeamId, Number.NaN), score(rightTeamId, 10)],
      });
    });
    expect(hook.result.current.state.games).toHaveLength(gameCount);
  });

  test('scoring rule updates keep incomplete numeric edits out of persisted state', async () => {
    const { hook } = await directorWithSetup();

    act(() => {
      expect(hook.result.current.updateRules({ bonusValue: 12 })).toBe(true);
    });
    expect(hook.result.current.state.tournament?.rules.bonusValue).toBe(12);

    act(() => {
      expect(hook.result.current.updateRules({ tossupValue: Number.NaN })).toBe(false);
    });
    expect(hook.result.current.state.tournament?.rules.tossupValue).toBe(10);
    expect(hook.result.current.error).toMatch(/finite positive number/i);
  });

  test('editing a team keeps organization data relational', async () => {
    const { hook } = await directorWithSetup();
    const target = hook.result.current.state.teams[0];
    if (!target) throw new Error('test setup did not create a team');

    act(() => {
      hook.result.current.updateTeam(target.id, {
        displayName: 'Northview B',
        organizationName: 'Northview High',
        teamLetter: 'B',
        seed: 4,
        notes: 'late registration',
      });
    });

    const edited = hook.result.current.state.teams.find((entry) => entry.id === target.id);
    const organization = hook.result.current.state.organizations.find(
      (entry) => entry.name === 'Northview High',
    );
    expect(edited).toMatchObject({
      displayName: 'Northview B',
      teamLetter: 'B',
      seed: 4,
      notes: 'late registration',
    });
    expect(organization).toBeTruthy();
    expect(edited?.organizationId).toBe(organization?.id);
    expect(edited).not.toHaveProperty('organizationName');

    act(() => {
      hook.result.current.updateTeam(target.id, { organizationName: ' ' });
    });
    expect(
      hook.result.current.state.teams.find((entry) => entry.id === target.id)?.organizationId,
    ).toBeNull();
  });

  test('rejecting a submission reopens the assignment for a later result', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.generateSchedule());
    const scheduled = hook.result.current.state.scheduledGames[0];
    if (!scheduled || !scheduled.rightTeamId) throw new Error('test setup did not generate a game');
    const rightTeamId = scheduled.rightTeamId;
    const imported = structuredClone(hook.result.current.state);
    const gameId = 'game-qbtcp-review';
    const submissionId = 'submission-qbtcp-review';
    imported.games.push({
      id: gameId,
      scheduledGameId: scheduled.id,
      roundId: scheduled.roundId,
      packetId: scheduled.packetId,
      status: 'submitted',
      scores: [score(scheduled.leftTeamId, 20), score(rightTeamId, 10)],
      playerStats: [],
      source: 'qbtcp',
      detailedStats: 'unknown',
    });
    imported.submissions.push({
      id: submissionId,
      gameId,
      receivedAt: new Date().toISOString(),
      fingerprint: 'review-fingerprint',
      status: 'review',
      rawSubmission: { source: 'test' },
    });
    imported.scheduledGames.find((game) => game.id === scheduled.id)!.status = 'submitted';
    act(() => {
      expect(hook.result.current.importSnapshot(imported)).toBe(true);
      hook.result.current.rejectSubmission(submissionId, 'Bad score sheet');
    });

    expect(hook.result.current.state.games.find((game) => game.id === gameId)?.status).toBe('rejected');
    expect(hook.result.current.state.scheduledGames.find((game) => game.id === scheduled.id)?.status).toBe(
      'scheduled',
    );
  });

  test('a second submission cannot become a second canonical accepted result', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.generateSchedule());
    const scheduled = hook.result.current.state.scheduledGames[0];
    if (!scheduled || !scheduled.rightTeamId) throw new Error('test setup did not generate a game');
    const rightTeamId = scheduled.rightTeamId;
    const imported = structuredClone(hook.result.current.state);
    const gameId = 'game-two-submissions';
    imported.games.push({
      id: gameId,
      scheduledGameId: scheduled.id,
      roundId: scheduled.roundId,
      packetId: scheduled.packetId,
      status: 'submitted',
      scores: [score(scheduled.leftTeamId, 20), score(rightTeamId, 10)],
      playerStats: [],
      source: 'qbtcp',
      detailedStats: 'unknown',
    });
    imported.submissions.push(
      {
        id: 'submission-one',
        gameId,
        receivedAt: '2026-09-01T12:00:00.000Z',
        fingerprint: 'fingerprint-one',
        status: 'review',
        rawSubmission: { source: 'test' },
      },
      {
        id: 'submission-two',
        gameId,
        receivedAt: '2026-09-01T12:01:00.000Z',
        fingerprint: 'fingerprint-two',
        status: 'review',
        rawSubmission: { source: 'test' },
      },
    );
    imported.scheduledGames.find((game) => game.id === scheduled.id)!.status = 'submitted';
    act(() => {
      expect(hook.result.current.importSnapshot(imported)).toBe(true);
    });

    let firstAccepted = false;
    act(() => {
      firstAccepted = hook.result.current.acceptSubmission('submission-one');
    });
    let secondAccepted = true;
    act(() => {
      secondAccepted = hook.result.current.acceptSubmission('submission-two');
    });

    expect(firstAccepted).toBe(true);
    expect(secondAccepted).toBe(false);
    expect(
      hook.result.current.state.submissions.filter(
        (submission) => submission.gameId === gameId && submission.status === 'accepted',
      ),
    ).toHaveLength(1);
    expect(
      hook.result.current.state.submissions.find((submission) => submission.id === 'submission-two')?.status,
    ).toBe('review');
  });

  test('rejecting a retry attached to a canonical result does not reopen that result', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.generateSchedule());
    const scheduled = hook.result.current.state.scheduledGames[0];
    if (!scheduled || !scheduled.rightTeamId) throw new Error('test setup did not generate a game');
    const rightTeamId = scheduled.rightTeamId;
    act(() => {
      hook.result.current.addManualResult({
        scheduledGameId: scheduled.id,
        scores: [score(scheduled.leftTeamId, 20), score(rightTeamId, 10)],
      });
    });
    const game = hook.result.current.state.games[0];
    if (!game) throw new Error('test setup did not accept a result');
    const imported = structuredClone(hook.result.current.state);
    imported.submissions.push({
      id: 'submission-retry',
      gameId: game.id,
      receivedAt: '2026-09-01T12:02:00.000Z',
      fingerprint: 'retry-fingerprint',
      status: 'review',
      rawSubmission: { association: 'matched', source: 'qbtcp-retry' },
    });
    act(() => {
      expect(hook.result.current.importSnapshot(imported)).toBe(true);
      expect(hook.result.current.rejectSubmission('submission-retry')).toBe(true);
    });

    expect(hook.result.current.state.games.find((entry) => entry.id === game.id)?.status).toBe('accepted');
    expect(hook.result.current.state.scheduledGames.find((entry) => entry.id === scheduled.id)?.status).toBe(
      'accepted',
    );
    expect(
      hook.result.current.state.submissions.filter(
        (entry) => entry.gameId === game.id && entry.status === 'accepted',
      ),
    ).toHaveLength(1);
  });

  test('protest corrections use the audited canonical correction flow', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.generateSchedule());
    const scheduled = hook.result.current.state.scheduledGames[0];
    if (!scheduled || !scheduled.rightTeamId) throw new Error('test setup did not generate a game');
    const rightTeamId = scheduled.rightTeamId;
    act(() => {
      hook.result.current.addManualResult({
        scheduledGameId: scheduled.id,
        scores: [score(scheduled.leftTeamId, 20), score(rightTeamId, 10)],
      });
    });
    const gameId = hook.result.current.state.games[0]?.id;
    if (!gameId) throw new Error('test setup did not accept a result');
    act(() => {
      hook.result.current.addProtest(gameId, 'Score correction', 'tossup');
    });
    const protestId = hook.result.current.state.protests[0]?.id;
    if (!protestId) throw new Error('test setup did not create a protest');
    act(() => {
      hook.result.current.ruleProtest(protestId, 'Ruling changes one tossup.', {
        teamId: scheduled.leftTeamId,
        delta: -5,
      });
    });

    const state = hook.result.current.state;
    expect(state.games.find((game) => game.id === gameId)?.scores[0]?.score).toBe(15);
    expect(
      state.submissions.filter(
        (submission) => submission.gameId === gameId && submission.status === 'accepted',
      ),
    ).toHaveLength(1);
    expect(
      state.submissions.some(
        (submission) => submission.gameId === gameId && submission.status === 'superseded',
      ),
    ).toBe(true);
    expect(state.protests[0]?.correctionSubmissionId).toBeTruthy();
    expect(state.audit.some((event) => event.type === 'result-edited' && event.entityId === gameId)).toBe(
      true,
    );
  });

  test('packet-use validation reports reuse by scheduled-game identity', async () => {
    const { hook } = await directorWithSetup(4);
    act(() => hook.result.current.generateSchedule());
    const conflicts = packetUseConflicts(hook.result.current.state);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.gameIds).toHaveLength(2);
  });

  test('packet-use validation reports direct use in a different round from a round packet', () => {
    const state = emptyDirectorState();
    state.packets = [
      {
        id: 'packet-shared',
        name: 'Shared packet',
        source: 'manual',
        assignedRoundIds: [],
        assignedGameIds: ['game-round-2'],
        usedGameIds: [],
        replacementForPacketId: null,
        tiebreaker: false,
      },
    ];
    state.rounds = [
      {
        id: 'round-1',
        phaseId: 'phase-1',
        name: 'Round 1',
        number: 1,
        revision: 1,
        status: 'released',
        packetId: 'packet-shared',
        scheduledGameIds: ['scheduled-round-1'],
        startedAt: null,
        closedAt: null,
      },
      {
        id: 'round-2',
        phaseId: 'phase-1',
        name: 'Round 2',
        number: 2,
        revision: 1,
        status: 'released',
        packetId: null,
        scheduledGameIds: ['scheduled-round-2'],
        startedAt: null,
        closedAt: null,
      },
    ];
    state.scheduledGames = [
      {
        id: 'scheduled-round-1',
        roundId: 'round-1',
        poolId: null,
        roomId: null,
        packetId: null,
        leftTeamId: 'team-a',
        rightTeamId: 'team-b',
        bye: false,
        status: 'released',
        assignmentRevision: 1,
      },
      {
        id: 'scheduled-round-2',
        roundId: 'round-2',
        poolId: null,
        roomId: null,
        packetId: null,
        leftTeamId: 'team-c',
        rightTeamId: 'team-d',
        bye: false,
        status: 'released',
        assignmentRevision: 1,
      },
    ];
    state.games = [
      {
        id: 'game-round-2',
        scheduledGameId: 'scheduled-round-2',
        roundId: 'round-2',
        packetId: 'packet-shared',
        status: 'submitted',
        scores: [],
        playerStats: [],
        source: 'manual',
        detailedStats: 'unknown',
      },
    ];

    const conflicts = packetUseConflicts(state);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.packetId).toBe('packet-shared');
    expect(conflicts[0]?.gameIds).toEqual(['scheduled-round-2', 'round:round-1']);
  });

  test('packet validation catches a ledger reference that disagrees with a game override', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.generateSchedule());
    const imported = structuredClone(hook.result.current.state);
    const scheduled = imported.scheduledGames[0];
    const packet = imported.packets[0];
    if (!scheduled || !packet || !imported.rounds[0])
      throw new Error('test setup did not generate packet state');
    const overrideId = 'packet-override';
    imported.packets.push({
      id: overrideId,
      name: 'Override packet',
      source: 'manual',
      assignedRoundIds: [],
      assignedGameIds: [],
      usedGameIds: [],
      replacementForPacketId: null,
      tiebreaker: false,
    });
    scheduled.packetId = overrideId;
    packet.assignedGameIds = [scheduled.id];

    const issues = runPreflight(imported).filter((issue) => issue.area === 'packets');
    expect(issues.some((issue) => /lists game.*uses packet/i.test(issue.message))).toBe(true);
    expect(issues.some((issue) => issue.id === `packet-assignment-conflict-${scheduled.id}`)).toBe(true);
  });

  test('unmatched QBTCP results stay review-only until a director associates them', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.generateSchedule());
    const scheduled = hook.result.current.state.scheduledGames[0];
    if (!scheduled || !scheduled.rightTeamId) throw new Error('test setup did not generate a game');
    const invoke = vi.fn(async (command: string) => {
      if (command !== 'director_server_snapshot') throw new Error(`unexpected command ${command}`);
      return {
        results: [
          {
            id: 'transport-unmatched',
            sessionId: 'session-unmatched',
            matchId: 'match-not-on-schedule',
            fingerprint: 'fingerprint-unmatched',
            reviewRequired: false,
            warnings: [],
            qbj: {
              type: 'Match',
              id: 'match-not-on-schedule',
              match_teams: [
                { team: { $ref: 'unknown-team-a' }, points: 15 },
                { team: { $ref: 'unknown-team-b' }, points: 10 },
              ],
            },
          },
        ],
        progress: [],
        presence: [],
      };
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });
    await act(async () => {
      await hook.result.current.syncQbtcp();
    });

    const state = hook.result.current.state;
    const submission = state.submissions.find((entry) => entry.transportResultId === 'transport-unmatched');
    expect(submission?.status).toBe('review');
    expect(state.scheduledGames.find((game) => game.id === scheduled.id)?.status).toBe('scheduled');
    expect(submission && hook.result.current.acceptSubmission(submission.id)).toBe(false);
    if (!submission) throw new Error('test setup did not stage an unmatched result');
    act(() => {
      expect(hook.result.current.associateSubmission(submission.id, scheduled.id)).toBe(true);
    });
    const associated = hook.result.current.state.games.find((game) => game.id === submission.gameId);
    expect(associated?.scheduledGameId).toBe(scheduled.id);
    expect(associated?.scores.map((entry) => entry.teamId)).toEqual([
      scheduled.leftTeamId,
      scheduled.rightTeamId,
    ]);
    expect(hook.result.current.state.submissions.find((entry) => entry.id === submission.id)?.status).toBe(
      'review',
    );
    act(() => {
      expect(hook.result.current.acceptSubmission(submission.id)).toBe(true);
    });
    expect(hook.result.current.state.scheduledGames.find((game) => game.id === scheduled.id)?.status).toBe(
      'accepted',
    );
  });

  test('QBTCP stable team references beat renamed display names and ambiguous names stay in review', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.generateSchedule());
    const scheduled = hook.result.current.state.scheduledGames[0];
    if (!scheduled || !scheduled.leftTeamId || !scheduled.rightTeamId) {
      throw new Error('test setup did not generate a two-team game');
    }
    const leftTeamId = scheduled.leftTeamId;
    const rightTeamId = scheduled.rightTeamId;
    const invoke = vi.fn(async () => ({
      results: [
        {
          id: 'transport-stable',
          sessionId: 'session-stable',
          matchId: scheduled.id,
          fingerprint: 'fingerprint-stable',
          reviewRequired: false,
          warnings: [],
          qbj: {
            type: 'Match',
            id: scheduled.id,
            match_teams: [
              { team: { $ref: leftTeamId, name: 'Renamed left' }, points: 15 },
              { team: { id: rightTeamId, name: 'Renamed right' }, points: 10 },
            ],
          },
        },
      ],
      progress: [],
      presence: [],
    }));
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });
    await act(async () => {
      await hook.result.current.syncQbtcp();
    });
    const stableGame = hook.result.current.state.games.find(
      (game) => game.transportResultId === 'transport-stable',
    );
    expect(stableGame?.scores.map((entry) => entry.teamId)).toEqual([
      scheduled.leftTeamId,
      scheduled.rightTeamId,
    ]);
    expect(
      hook.result.current.state.submissions.find((entry) => entry.transportResultId === 'transport-stable')
        ?.status,
    ).toBe('received');
    act(() => {
      hook.result.current.updateTeam(leftTeamId, { displayName: 'Same name' });
      hook.result.current.updateTeam(rightTeamId, { displayName: 'Same name' });
    });
    const ambiguousInvoke = vi.fn(async () => ({
      results: [
        {
          id: 'transport-ambiguous',
          sessionId: 'session-ambiguous',
          matchId: scheduled.id,
          fingerprint: 'fingerprint-ambiguous',
          reviewRequired: false,
          warnings: [],
          qbj: {
            type: 'Match',
            id: scheduled.id,
            match_teams: [
              { team: { name: 'Same name' }, points: 20 },
              { team: { name: 'Same name' }, points: 10 },
            ],
          },
        },
      ],
      progress: [],
      presence: [],
    }));
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke: ambiguousInvoke },
    });
    await act(async () => {
      await hook.result.current.syncQbtcp();
    });
    const ambiguousSubmission = hook.result.current.state.submissions.find(
      (entry) => entry.transportResultId === 'transport-ambiguous',
    );
    expect(ambiguousSubmission?.status).toBe('review');
    expect(ambiguousSubmission?.warnings?.some((warning) => /ambiguous/i.test(warning))).toBe(true);
  });

  test('expired QBTCP sessions lose stale progress and release an idle room', async () => {
    const { hook } = await directorWithSetup();
    const imported = structuredClone(hook.result.current.state);
    const room = imported.rooms[0];
    if (!room) throw new Error('test setup did not create a room');
    room.status = 'live';
    imported.qbtcpSessions = [
      {
        roomId: room.id,
        sessionId: 'stale-session',
        deviceId: 'device-1',
        state: 'live',
        resumable: false,
        resultReceived: false,
        lastSeenAt: '2000-01-01T00:00:00.000Z',
        progressSequence: 4,
        progress: { tossupsRead: 4, leftScore: 20, rightScore: 10 },
        helpRequestId: null,
      },
    ];
    act(() => {
      expect(hook.result.current.importSnapshot(imported)).toBe(true);
    });
    const invoke = vi.fn(async () => ({ results: [], progress: [], presence: [] }));
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });
    await act(async () => {
      await hook.result.current.syncQbtcp();
    });
    expect(hook.result.current.state.qbtcpSessions[0]).toMatchObject({
      state: 'abandoned',
      progress: null,
      resumable: true,
    });
    expect(hook.result.current.state.rooms[0]?.status).toBe('available');
  });

  test('head-to-head ranks a tied pair from their own game, not unrelated wins', () => {
    const state = emptyDirectorState();
    state.tournament = {
      id: 'tournament-stats',
      name: 'Stats',
      date: '',
      venue: '',
      organizer: '',
      status: 'running',
      rules: { ...defaultRules, tiebreakers: ['head-to-head'] },
      formatId: null,
      currentPhaseId: null,
      currentPacketId: null,
      currentRoundId: null,
      createdAt: '',
      updatedAt: '',
    };
    state.teams = [team('A'), team('B'), team('C')];
    state.games = [
      acceptedGame('2026-01-01', 'round-1', 'A', 20, 'B', 10),
      acceptedGame('2026-01-02', 'round-1', 'B', 20, 'C', 10),
      acceptedGame('2026-01-03', 'round-1', 'C', 20, 'A', 10),
    ];
    state.scheduledGames = state.games.map((game) =>
      scheduledForGame(game, game.scores[0]!.teamId, game.scores[1]!.teamId),
    );
    const standings = deriveTeamStandings(state);
    expect(standings.map((standing) => standing.teamId)).toEqual(['A', 'B', 'C']);
    expect(standings.every((standing) => standing.wins === 1 && standing.losses === 1)).toBe(true);
  });

  test('dropped teams stay out of display without erasing opponents historical results', () => {
    const state = emptyDirectorState();
    state.teams = [team('active'), team('dropped', 'dropped')];
    state.games = [acceptedGame('2026-02-01', 'round-1', 'active', 5, 'dropped', 0)];
    state.scheduledGames = [scheduledForGame(state.games[0]!, 'active', 'dropped')];
    const standings = deriveTeamStandings(state);
    expect(standings).toHaveLength(1);
    expect(standings[0]).toMatchObject({ teamId: 'active', gamesPlayed: 1, wins: 1, pointsFor: 5 });
  });

  test('advancement selects the configured number from each pool and ignores later-phase games', () => {
    const state = emptyDirectorState();
    state.tournament = {
      id: 'tournament-advancement',
      name: 'Advancement',
      date: '',
      venue: '',
      organizer: '',
      status: 'running',
      rules: structuredClone(defaultRules),
      formatId: 'format-prelim',
      currentPhaseId: 'phase-prelim',
      currentPacketId: null,
      currentRoundId: null,
      createdAt: '',
      updatedAt: '',
    };
    state.teams = [team('A'), team('B'), team('C'), team('D')];
    state.phases = [
      {
        id: 'phase-prelim',
        name: 'Prelim',
        kind: 'preliminary',
        order: 1,
        formatId: 'format-prelim',
        poolIds: ['pool-1', 'pool-2'],
        roundIds: ['round-prelim'],
        advancementRule: {
          qualifiersPerPool: 1,
          tiebreakers: defaultRules.tiebreakers,
          manualOverrideAllowed: false,
        },
        carryover: false,
        status: 'active',
      },
      {
        id: 'phase-playoff',
        name: 'Playoff',
        kind: 'playoff',
        order: 2,
        formatId: 'format-playoff',
        poolIds: [],
        roundIds: ['round-playoff'],
        advancementRule: null,
        carryover: false,
        status: 'planned',
      },
    ];
    state.pools = [
      { id: 'pool-1', phaseId: 'phase-prelim', name: 'Pool 1', teamIds: ['A', 'B'], order: 1 },
      { id: 'pool-2', phaseId: 'phase-prelim', name: 'Pool 2', teamIds: ['C', 'D'], order: 2 },
    ];
    state.rounds = [
      {
        id: 'round-prelim',
        phaseId: 'phase-prelim',
        name: 'Prelim round',
        number: 1,
        revision: 1,
        status: 'closed',
        packetId: null,
        scheduledGameIds: [],
        startedAt: null,
        closedAt: null,
      },
      {
        id: 'round-playoff',
        phaseId: 'phase-playoff',
        name: 'Playoff round',
        number: 2,
        revision: 1,
        status: 'closed',
        packetId: null,
        scheduledGameIds: [],
        startedAt: null,
        closedAt: null,
      },
    ];
    state.games = [
      acceptedGame('2026-03-01', 'round-prelim', 'A', 100, 'B', 0),
      acceptedGame('2026-03-02', 'round-prelim', 'C', 10, 'D', 0),
      acceptedGame('2026-03-03', 'round-playoff', 'A', 0, 'C', 200),
    ];
    state.scheduledGames = [
      scheduledForGame(state.games[0]!, 'A', 'B', { poolId: 'pool-1' }),
      scheduledForGame(state.games[1]!, 'C', 'D', { poolId: 'pool-2' }),
      scheduledForGame(state.games[2]!, 'A', 'C'),
    ];
    state.rounds[0]!.scheduledGameIds = [state.scheduledGames[0]!.id, state.scheduledGames[1]!.id];
    state.rounds[1]!.scheduledGameIds = [state.scheduledGames[2]!.id];
    const preview = previewAdvancement(state, state.phases[0]!);
    expect(preview.qualifiers.map((entry) => entry.id).sort()).toEqual(['A', 'C']);
  });

  test('known old state migrates and future state is not rewritten', () => {
    const old = emptyDirectorState() as unknown as Record<string, unknown>;
    old.schemaVersion = 1;
    const current = emptyDirectorState();
    old.tournament = {
      id: 'tournament-old',
      name: 'Old tournament',
      date: '',
      venue: '',
      organizer: '',
      status: 'draft',
      rules: structuredClone(defaultRules),
      formatId: 'format-old',
      currentRoundId: null,
      createdAt: '',
      updatedAt: '',
    };
    old.formats = [
      {
        id: 'format-old',
        name: 'Round robin',
        kind: 'round-robin',
        phaseIds: ['phase-old'],
        roundsPerTeam: null,
        avoidRematches: true,
        avoidSameOrganization: false,
        allowByes: true,
        editable: true,
      },
    ];
    old.phases = [
      {
        id: 'phase-old',
        name: 'Preliminary',
        kind: 'preliminary',
        order: 1,
        formatId: 'format-old',
        poolIds: [],
        roundIds: [],
        advancementRule: null,
        carryover: false,
        status: 'planned',
      },
    ];
    const migrated = normalizeDirectorState(old);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.tournament?.currentPhaseId).toBe('phase-old');
    expect(migrated.tournament?.currentPacketId).toBeNull();
    expect(() => normalizeDirectorState({ ...current, schemaVersion: 99 })).toThrow(
      /newest supported schema/i,
    );
  });

  test('a tournament without rules receives a complete independent default ruleset', () => {
    const legacy = emptyDirectorState() as unknown as Record<string, unknown>;
    legacy.tournament = {
      id: 'tournament-without-rules',
      name: 'Legacy tournament',
      date: '',
      venue: '',
      organizer: '',
      status: 'draft',
    };

    const normalized = normalizeDirectorState(legacy);
    expect(normalized.tournament?.rules).toEqual(defaultRules);
    if (!normalized.tournament) throw new Error('test setup did not produce a tournament');
    normalized.tournament.rules.tossupValue = 99;
    expect(defaultRules.tossupValue).toBe(10);
    expect(normalizeDirectorState(legacy).tournament?.rules.tossupValue).toBe(10);
  });

  test('malformed required state shapes are rejected instead of erased', () => {
    const current = emptyDirectorState() as unknown as Record<string, unknown>;
    expect(() => normalizeDirectorState({ ...current, teams: { not: 'an array' } })).toThrow(/teams.*array/i);
    expect(() => normalizeDirectorState({ ...current, metadata: [] })).toThrow(/metadata/i);
  });

  test('checkpoint waits behind saves and later edits are persisted after it', async () => {
    const events: string[] = [];
    let releaseFirstSave: () => void = () => undefined;
    let firstSave = true;
    const gate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const repository: DirectorRepository & { state: DirectorState } = {
      kind: 'memory',
      state: emptyDirectorState(),
      async load() {
        return structuredClone(this.state);
      },
      async save(state) {
        events.push('save:start');
        if (firstSave) {
          firstSave = false;
          await gate;
        }
        this.state = structuredClone(state);
        events.push('save:end');
      },
      async checkpoint(state) {
        events.push('checkpoint:start');
        this.state = structuredClone(state);
        events.push('checkpoint:end');
      },
    };
    const hook = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    let checkpointPromise: Promise<void> | undefined;
    act(() => {
      hook.result.current.createTournament({ name: 'Before checkpoint', date: '', venue: '', organizer: '' });
      checkpointPromise = hook.result.current.checkpoint('ordering test');
      hook.result.current.updateTournament({ name: 'After checkpoint' });
    });
    releaseFirstSave();
    await checkpointPromise;
    await waitFor(() => expect(hook.result.current.saving).toBe(false));

    expect(events.indexOf('checkpoint:start')).toBeGreaterThan(events.indexOf('save:end'));
    expect(repository.state.tournament?.name).toBe('After checkpoint');
    expect(repository.state.metadata.lastCheckpointAt).toBeTruthy();
  });

  test('browser fallback reports a write failure when localStorage is unavailable', async () => {
    // jsdom exposes Storage as a proxy in some Node versions. Spying on the instance can then
    // shadow a named storage entry instead of the method that bare `localStorage` resolves to.
    const storage = Object.getPrototypeOf(window.localStorage) as Storage;
    const setItem = vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      const repository = new IndexedDbDirectorRepository();
      (repository as unknown as { databasePromise: Promise<IDBDatabase | null> | null }).databasePromise =
        Promise.resolve(null);
      await expect(repository.save(emptyDirectorState())).rejects.toThrow(
        /quota|permissions|could not be saved/i,
      );
    } finally {
      setItem.mockRestore();
    }
  });
});
