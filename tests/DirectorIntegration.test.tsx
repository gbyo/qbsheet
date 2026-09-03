import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  defaultRules,
  deriveTeamStandings,
  directorSchemaVersion,
  emptyDirectorState,
  emptyLivePublication,
  formatGenerationAvailability,
  generateDirectorRound,
  generateRoundRobinRound,
  orderDayItems,
  packetUseConflicts,
  previewAdvancement,
  recommendTournamentPlan,
  roundScheduleIsValid,
  runPreflight,
  scheduleIsValid,
  type DirectorState,
  type TeamGameScore,
} from '../src/director/domain';
import { useDirectorController, type StartRoundResult } from '../src/director/state/useDirectorController';
import {
  IndexedDbDirectorRepository,
  MemoryDirectorRepository,
  type DirectorRepository,
} from '../src/director/persistence';
import { normalizeDirectorState } from '../src/director/persistence/stateMigrations';
import {
  exportArchiveBytes,
  exportQbj,
  importArchiveBytes,
  toInterchange,
} from '../src/director/format/interchange';
import { derivePublication } from '../src/director/live/publication';
import { saveOperatorProfile } from '../src/director/operator/operatorProfile';

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
    window.localStorage.removeItem('qbsheet.operatorProfile.v1');
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
      timeZone: 'America/New_York',
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
      {
        id: 'roster-amendment-1',
        sessionId: 'session-1',
        amendment: { playerName: 'Ada', teamId: 'team-1', created: true },
        status: 'pending',
        decidedAt: null,
        decidedBy: null,
        mappedPlayerId: null,
      },
    ];

    const imported = importArchiveBytes(exportArchiveBytes(state));
    expect(imported.ok).toBe(true);
    if (!imported.ok || !imported.state) return;
    expect(imported.state).toEqual(state);
  });

  test('canonical QBJ rules and Director extensions round-trip every supported rules decision', () => {
    const state = emptyDirectorState();
    state.tournament = {
      id: 'tournament-rules-round-trip',
      name: 'Rules round trip',
      date: '2026-09-01',
      venue: 'Main hall',
      organizer: 'QBSheet',
      status: 'draft',
      timeZone: 'America/New_York',
      rules: {
        ...structuredClone(defaultRules),
        tossupValue: 12,
        powerValue: 20,
        negValue: -10,
        bonusValue: 15,
        tossupCount: 24,
        bonusParts: 4,
        bouncebacks: true,
        overtime: false,
        timed: true,
        lightning: true,
        maximumActivePlayers: 3,
        regulationMinutes: 30,
        tiebreakers: ['record', 'points'],
      },
      formatId: null,
      currentPhaseId: null,
      currentPacketId: null,
      currentRoundId: null,
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
    };

    const interchange = toInterchange(state);
    expect(interchange.rules).toMatchObject({
      maximum_players_per_team: 3,
      regulation_tossup_count: 24,
      bonuses_bounce_back: true,
      overtime_includes_bonuses: false,
    });
    expect(interchange.rules).not.toHaveProperty('tossupValue');
    expect(interchange.tournament.extensions).toMatchObject({
      timeZone: 'America/New_York',
      timed: true,
      regulationMinutes: 30,
      tiebreakers: ['record', 'points'],
    });

    const imported = importArchiveBytes(exportArchiveBytes(state));
    expect(imported.ok).toBe(true);
    if (!imported.ok || !imported.state) return;
    expect(imported.state.tournament?.timeZone).toBe('America/New_York');
    expect(imported.state.tournament?.rules).toEqual(state.tournament.rules);
  });

  test('schema v5 migration defaults timed scoring safely and preserves legacy procedure intent', () => {
    const legacy = emptyDirectorState() as unknown as Record<string, unknown>;
    legacy.schemaVersion = 5;
    legacy.tournament = {
      id: 'legacy-timed',
      name: 'Legacy timed event',
      date: '',
      venue: '',
      organizer: '',
      status: 'draft',
      rules: { ...defaultRules, timed: undefined, roomProcedure: { timed: true } },
      formatId: null,
      currentPhaseId: null,
      currentPacketId: null,
      currentRoundId: null,
      createdAt: '',
      updatedAt: '',
    };
    const normalized = normalizeDirectorState(legacy);
    expect(normalized.schemaVersion).toBe(directorSchemaVersion);
    expect(normalized.tournament?.rules.timed).toBe(true);

    const untimed = structuredClone(legacy);
    (untimed.tournament as Record<string, unknown>).rules = { ...defaultRules };
    expect(normalizeDirectorState(untimed).tournament?.rules.timed).toBe(false);
  });

  test('schema v6 migration assigns the displayed day order deterministically', () => {
    const legacy = emptyDirectorState() as unknown as Record<string, unknown>;
    legacy.schemaVersion = 6;
    legacy.rounds = [
      {
        id: 'round-2',
        phaseId: 'phase-1',
        name: 'Round 2',
        number: 2,
        revision: 1,
        status: 'planned',
        packetId: null,
        scheduledGameIds: [],
        scheduledStart: null,
        releasedAt: null,
        startedAt: null,
        closedAt: null,
      },
      {
        id: 'round-1',
        phaseId: 'phase-1',
        name: 'Round 1',
        number: 1,
        revision: 1,
        status: 'planned',
        packetId: null,
        scheduledGameIds: [],
        scheduledStart: null,
        releasedAt: null,
        startedAt: null,
        closedAt: null,
      },
    ];
    legacy.timeline = [
      {
        id: 'lunch',
        type: 'lunch',
        title: 'Lunch',
        visibility: 'public',
        scheduledStart: null,
        scheduledEnd: null,
        createdAt: '',
        updatedAt: '',
      },
    ];
    const normalized = normalizeDirectorState(legacy);
    expect(normalized.schemaVersion).toBe(directorSchemaVersion);
    const order = new Map(
      [...normalized.rounds, ...normalized.timeline].map((entry) => [entry.id, entry.dayOrder]),
    );
    // Untimed rounds keep number order; the untimed event keeps its displayed
    // position after them (id tiebreak), and every value is dense.
    expect(order.get('round-1')).toBe(0);
    expect(order.get('round-2')).toBe(1);
    expect(order.get('lunch')).toBe(2);

    // Reloading the migrated document preserves the sequence exactly.
    const reloaded = normalizeDirectorState(
      JSON.parse(JSON.stringify(normalized)) as Record<string, unknown>,
    );
    const reloadedOrder = new Map(
      [...reloaded.rounds, ...reloaded.timeline].map((entry) => [entry.id, entry.dayOrder]),
    );
    expect(reloadedOrder.get('round-1')).toBe(0);
    expect(reloadedOrder.get('round-2')).toBe(1);
    expect(reloadedOrder.get('lunch')).toBe(2);
  });

  test('scenario A: ten-team no-time day with Lunch after round 5 survives reload', async () => {
    const { hook } = await directorWithSetup(10);
    act(() => {
      for (let index = 0; index < 9; index += 1) {
        expect(hook.result.current.generateSchedule().generated).toBe(true);
      }
      expect(
        hook.result.current.addTimelineEvent({ type: 'lunch', title: 'Lunch', visibility: 'public' }),
      ).toBe(true);
    });
    const lunchId = hook.result.current.state.timeline.find((entry) => entry.type === 'lunch')?.id;
    expect(lunchId).toBeTruthy();
    act(() => {
      for (let index = 0; index < 4; index += 1) {
        expect(hook.result.current.moveDayItem(lunchId as string, 'up')).toBe(true);
      }
    });

    const dayLabels = (state: DirectorState): string[] =>
      orderDayItems(state.rounds, state.timeline).map((item) =>
        item.kind === 'round' && item.round ? `R${item.round.number}` : (item.event?.title ?? '?'),
      );
    const expected = ['R1', 'R2', 'R3', 'R4', 'R5', 'Lunch', 'R6', 'R7', 'R8', 'R9'];
    const live = hook.result.current.state;
    expect(dayLabels(live)).toEqual(expected);

    // Full round robin: five games per round, nine games per team, no byes.
    const games = live.scheduledGames.filter((game) => !game.bye);
    expect(games).toHaveLength(45);
    const appearances = new Map<string, number>();
    for (const game of games) {
      for (const teamId of [game.leftTeamId, game.rightTeamId]) {
        if (teamId) appearances.set(teamId, (appearances.get(teamId) ?? 0) + 1);
      }
    }
    expect([...appearances.values()]).toEqual(live.teams.map(() => 9));

    // No clock times anywhere, and preflight never nags about times.
    expect(live.rounds.every((round) => round.scheduledStart == null)).toBe(true);
    expect(live.timeline.every((event) => event.scheduledStart == null && event.scheduledEnd == null)).toBe(
      true,
    );
    const timeIssues = runPreflight(live, false, false).filter((issue) =>
      /time|clock|timezone/i.test(issue.message),
    );
    expect(timeIssues).toEqual([]);

    // Reloading the persisted document preserves the sequence exactly.
    const reloaded = normalizeDirectorState(JSON.parse(JSON.stringify(live)) as Record<string, unknown>);
    expect(dayLabels(reloaded)).toEqual(expected);

    // The portable archive round-trips the sequence too.
    const report = importArchiveBytes(exportArchiveBytes(live));
    expect(report.ok).toBe(true);
    expect(report.state ? dayLabels(report.state) : []).toEqual(expected);
  });

  test('planner recommendations: use-this-plan builds nine rounds for ten teams', async () => {
    const { hook } = await directorWithSetup(10);
    const set = recommendTournamentPlan(10);
    expect(set?.recommended.id).toBe('full-round-robin');

    let applied = false;
    act(() => {
      applied = hook.result.current.applyTournamentPlan(set?.recommended ?? ({} as never));
    });
    expect(applied).toBe(true);
    const live = hook.result.current.state;
    expect(live.rounds.map((round) => round.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(live.rounds.map((round) => round.dayOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(live.phases).toHaveLength(1);
    expect(live.pools).toHaveLength(0);
    expect(live.rounds.every((round) => round.scheduledStart == null)).toBe(true);
    const format = live.formats.find((entry) => entry.id === live.tournament?.formatId);
    expect(format?.kind).toBe('round-robin');
    expect(live.audit.some((event) => event.summary.includes('Applied tournament plan'))).toBe(true);

    // Re-applying a different plan before play starts is a safe rebuild.
    act(() => {
      applied = hook.result.current.applyTournamentPlan(set?.alternatives[0] ?? ({} as never));
    });
    expect(applied).toBe(true);
    expect(hook.result.current.state.rounds).toHaveLength(18);

    // Once pairings exist the plan is refused rather than wiping them.
    const paired = await directorWithSetup(10);
    act(() => {
      expect(paired.hook.result.current.generateSchedule().generated).toBe(true);
    });
    const roundsBefore = paired.hook.result.current.state.rounds.length;
    expect(roundsBefore).toBeGreaterThan(0);
    act(() => {
      applied = paired.hook.result.current.applyTournamentPlan(set?.recommended ?? ({} as never));
    });
    expect(applied).toBe(false);
    expect(paired.hook.result.current.state.rounds.length).toBe(roundsBefore);
  });

  test('planner recommendations: eighteen teams get pools, stages, and advancement', async () => {
    const { hook } = await directorWithSetup(18);
    const set = recommendTournamentPlan(18);
    expect(set?.recommended.id).toBe('pools-playoffs');

    act(() => {
      expect(hook.result.current.applyTournamentPlan(set?.recommended ?? ({} as never))).toBe(true);
    });
    const live = hook.result.current.state;
    expect(live.phases.map((phase) => phase.name)).toEqual(['Prelims', 'Playoffs']);

    const prelim = live.phases[0];
    const prelimPools = live.pools.filter((pool) => pool.phaseId === prelim.id);
    expect(prelimPools).toHaveLength(3);
    for (const pool of prelimPools) {
      expect(pool.teamIds).toHaveLength(6);
    }
    const placed = prelimPools.flatMap((pool) => pool.teamIds).sort();
    expect(placed).toEqual(live.teams.map((team) => team.id).sort());

    expect(prelim.advancementRule?.qualifiersPerPool).toBeGreaterThan(0);
    expect(prelim.advancementRule?.manualOverrideAllowed).toBe(true);

    const playoff = live.phases[1];
    const playoffPools = live.pools.filter((pool) => pool.phaseId === playoff.id);
    expect(playoffPools.length).toBeGreaterThan(0);
    expect(playoffPools.every((pool) => pool.teamIds.length === 0)).toBe(true);

    const expectedNumbers = [
      ...(set?.recommended.stages[0].roundNumbers ?? []),
      ...(set?.recommended.stages[1].roundNumbers ?? []),
    ];
    expect(live.rounds.map((round) => round.number)).toEqual(expectedNumbers);
    const dayOrders = live.rounds.map((round) => round.dayOrder ?? -1);
    expect([...dayOrders].sort((a, b) => a - b)).toEqual(dayOrders);
  });

  test('round orchestration: manual start needs no rooms, one finish closes the round', async () => {
    const { hook } = await directorWithSetup(4);
    act(() => {
      expect(hook.result.current.generateSchedule().generated).toBe(true);
    });
    const roundId = hook.result.current.state.rounds[0].id;

    // No rooms assigned, no QBTCP sessions, no USB locations: the round still
    // starts with a single action and checkpoints first.
    let manual: StartRoundResult | undefined;
    await act(async () => {
      manual = await hook.result.current.startRound(roundId);
    });
    expect(manual?.ok).toBe(true);
    expect(manual?.manual).toBe(true);
    expect(manual?.summary).toContain('manually');
    expect(hook.result.current.state.rounds[0].status).toBe('released');
    expect(hook.result.current.state.metadata.lastCheckpointAt).not.toBeNull();
    expect(
      hook.result.current.state.audit.some((event) => event.summary === `Started ${manual?.roundName}.`),
    ).toBe(true);

    // Nothing resolved yet: finish reports what remains instead of closing.
    const unfinished = hook.result.current.finishRound(roundId);
    expect(unfinished.finished).toBe(false);
    expect(unfinished.remaining).toBe(2);
    expect(hook.result.current.state.rounds[0].status).toBe('released');

    const games = hook.result.current.state.scheduledGames.filter(
      (game) => game.roundId === roundId && !game.bye,
    );
    act(() => {
      for (const game of games) {
        expect(
          hook.result.current.addManualResult({
            scheduledGameId: game.id,
            scores: [score(game.leftTeamId, 100), score(game.rightTeamId ?? game.leftTeamId, 50)],
          }),
        ).toBe(true);
      }
    });
    let done: ReturnType<typeof hook.result.current.finishRound> | undefined;
    act(() => {
      done = hook.result.current.finishRound(roundId);
    });
    expect(done?.finished).toBe(true);
    expect(hook.result.current.state.rounds[0].status).toBe('closed');
    expect(hook.result.current.finishRound(roundId)).toMatchObject({
      finished: true,
      alreadyFinished: true,
    });
  });

  test('round orchestration: assigned rooms are enforced, delivered count is honest', async () => {
    const { hook } = await directorWithSetup(4);
    act(() => {
      expect(hook.result.current.addRoom({ name: 'Room 102' })).toBe(true);
      expect(hook.result.current.generateSchedule().generated).toBe(true);
    });
    const roundId = hook.result.current.state.rounds[0].id;
    const games = hook.result.current.state.scheduledGames.filter(
      (game) => game.roundId === roundId && !game.bye,
    );
    expect(games.every((game) => game.roomId !== null)).toBe(true);

    let result: StartRoundResult | undefined;
    await act(async () => {
      result = await hook.result.current.startRound(roundId);
    });
    expect(result?.ok).toBe(true);
    expect(result?.manual).not.toBe(true);
    expect(result?.deliveredGames).toBe(2);
    expect(result?.pendingHandoffs).toEqual([]);
    expect(hook.result.current.state.rounds[0].status).toBe('released');
  });

  test('round orchestration: partial rooms stay manual, gaps fail only with delivery configured', async () => {
    // One room exists, so generation assigns it to the first game only. With
    // no QBTCP or USB configured that partial assignment stays a label: the
    // round still starts as a manual round.
    const partial = await directorWithSetup(4);
    act(() => {
      expect(partial.hook.result.current.generateSchedule().generated).toBe(true);
    });
    const partialRoundId = partial.hook.result.current.state.rounds[0].id;
    let partialResult: StartRoundResult | undefined;
    await act(async () => {
      partialResult = await partial.hook.result.current.startRound(partialRoundId);
    });
    expect(partialResult?.ok).toBe(true);
    expect(partialResult?.manual).toBe(true);
    expect(partial.hook.result.current.state.rounds[0].status).toBe('released');

    // A paired QBTCP session means electronic delivery: the roomless game now
    // blocks the start until it has a room or a USB workflow covers it.
    const electronic = await directorWithSetup(4);
    act(() => {
      expect(electronic.hook.result.current.generateSchedule().generated).toBe(true);
    });
    const roomId = electronic.hook.result.current.state.rooms[0].id;
    const paired = structuredClone(electronic.hook.result.current.state);
    paired.qbtcpSessions = [
      {
        roomId,
        sessionId: 'session-1',
        matchId: 'match-1',
        deviceId: 'device-1',
        operatorName: 'Scorekeeper',
        state: 'paired',
        resumable: true,
        resultReceived: false,
        progressSequence: 0,
        lastSeenAt: '2026-09-01T11:02:00.000Z',
        progress: null,
        helpRequestId: null,
      },
    ];
    act(() => {
      expect(electronic.hook.result.current.importSnapshot(paired)).toBe(true);
    });
    const electronicRoundId = electronic.hook.result.current.state.rounds[0].id;
    let blocked: StartRoundResult | undefined;
    await act(async () => {
      blocked = await electronic.hook.result.current.startRound(electronicRoundId);
    });
    expect(blocked?.ok).toBe(false);
    expect(blocked?.reason).toContain('room');
    expect(electronic.hook.result.current.state.rounds[0].status).not.toBe('released');

    // Configuring the USB workflow turns that same gap into an honest
    // physical handoff instead of a failure.
    act(() => {
      electronic.hook.result.current.addTransferLocation({
        kind: 'removable-drive',
        label: 'Samsung USB',
        path: '/mnt/usb',
      });
    });
    expect(electronic.hook.result.current.state.transfers.locations).toHaveLength(1);
    let usb: StartRoundResult | undefined;
    await act(async () => {
      usb = await electronic.hook.result.current.startRound(electronicRoundId);
    });
    expect(usb?.ok).toBe(true);
    expect(usb?.manual).not.toBe(true);
    expect(usb?.deliveredGames).toBe(1);
    expect(usb?.pendingHandoffs).toHaveLength(1);
    expect(usb?.summary).toContain('handoff');
    expect(electronic.hook.result.current.state.rounds[0].status).toBe('released');
  });

  test('tournament detail updates normalize persisted text and reject blank names', async () => {
    const { hook } = await directorWithSetup();

    let updated = false;
    act(() => {
      updated = hook.result.current.updateTournament({
        name: '  Renamed event  ',
        date: ' 2026-09-02 ',
        venue: '  Main hall  ',
        organizer: '  Quiz staff  ',
      });
    });
    expect(updated).toBe(true);
    expect(hook.result.current.state.tournament).toMatchObject({
      name: 'Renamed event',
      date: '2026-09-02',
      venue: 'Main hall',
      organizer: 'Quiz staff',
    });

    act(() => {
      updated = hook.result.current.updateTournament({ name: '   ' });
    });
    expect(updated).toBe(false);
    expect(hook.result.current.state.tournament?.name).toBe('Renamed event');
    expect(hook.result.current.error).toMatch(/tournament name is required/i);
  });

  test('operator identity attributes new audit events without exporting the local profile', async () => {
    const { hook } = await directorWithSetup();
    saveOperatorProfile({ displayName: 'Archive Boundary Director', role: 'profile-role-sentinel' });
    act(() => expect(hook.result.current.updateTournament({ venue: 'Updated hall' })).toBe(true));
    expect(hook.result.current.state.audit.at(-1)).toMatchObject({
      actor: 'Archive Boundary Director',
      type: 'tournament-updated',
    });
    const historicalImport = structuredClone(hook.result.current.state);
    historicalImport.audit.push({
      id: 'historical-imported-event',
      at: '2025-01-01T00:00:00.000Z',
      actor: 'Imported Scorekeeper',
      type: 'result-received',
      summary: 'Imported historical result.',
    });
    act(() => expect(hook.result.current.importSnapshot(historicalImport)).toBe(true));
    expect(
      hook.result.current.state.audit.find((event) => event.id === 'historical-imported-event')?.actor,
    ).toBe('Imported Scorekeeper');

    const interchangeJson = JSON.stringify(toInterchange(hook.result.current.state));
    expect(interchangeJson).not.toContain('profile-role-sentinel');
    expect(interchangeJson).not.toContain('operatorProfile');
    expect(exportQbj(hook.result.current.state)).not.toContain('profile-role-sentinel');
    const archive = new TextDecoder().decode(exportArchiveBytes(hook.result.current.state));
    expect(archive).not.toContain('profile-role-sentinel');

    const liveState = structuredClone(hook.result.current.state);
    liveState.live = emptyLivePublication('bcdfghjkmnpqrstvwxyz', '2026-09-01T12:00:00.000Z');
    liveState.live.settings.enabled = true;
    const publication = derivePublication(liveState, null, { now: new Date('2026-09-01T12:00:00.000Z') });
    expect(JSON.stringify(publication.snapshot)).not.toContain('Archive Boundary Director');
    expect(JSON.stringify(publication.snapshot)).not.toContain('profile-role-sentinel');
  });

  test('Director interchange exports player points from the full stat line', () => {
    const state = emptyDirectorState();
    state.tournament = {
      id: 'tournament-player-export',
      name: 'Player export',
      date: '',
      venue: '',
      organizer: '',
      status: 'running',
      timeZone: 'America/New_York',
      rules: structuredClone(defaultRules),
      formatId: null,
      currentPhaseId: null,
      currentPacketId: null,
      currentRoundId: null,
      createdAt: '',
      updatedAt: '',
    };
    state.games = [
      {
        id: 'game-player-export',
        scheduledGameId: 'scheduled-player-export',
        roundId: 'round-player-export',
        packetId: null,
        status: 'accepted',
        scores: [],
        playerStats: [
          {
            playerId: 'player-1',
            teamId: 'team-1',
            powers: 2,
            gets: 3,
            negs: 1,
            bonusPoints: 20,
            tossupsHeard: 8,
          },
        ],
        source: 'manual',
        detailedStats: 'complete',
      },
    ];

    const exportedPlayer = toInterchange(state).games[0]?.result?.players?.[0];
    expect(exportedPlayer).toMatchObject({
      powers: 2,
      gets: 3,
      negs: 1,
      bonusPoints: 20,
      points: 75,
    });
  });

  test('Swiss formats use quizbowl power matching instead of a round-robin fallback', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.updateFormat({ kind: 'swiss', name: 'Swiss' }));

    let result: { conflicts: string[]; generated: boolean } | undefined;
    act(() => {
      result = hook.result.current.generateSchedule({ seed: 1 });
    });

    expect(result?.conflicts.join(' ')).not.toMatch(/not implemented/i);
    expect(result?.generated).toBe(true);
    expect(hook.result.current.state.rounds).toHaveLength(1);
    expect(hook.result.current.state.scheduledGames).toHaveLength(1);
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

  test('phases and pools retire without deleting historical membership or references', async () => {
    const { hook } = await directorWithSetup(4);
    const phase = hook.result.current.state.phases[0];
    if (!phase) throw new Error('test setup did not create a phase');

    act(() => {
      expect(hook.result.current.setPhaseArchived(phase.id, true)).toBe(true);
    });
    expect(hook.result.current.state.phases[0]).toMatchObject({ id: phase.id, archived: true });
    expect(hook.result.current.state.tournament?.currentPhaseId).toBeNull();
    expect(toInterchange(hook.result.current.state).phases[0]?.extensions).toEqual({ archived: true });

    act(() => {
      expect(hook.result.current.setPhaseArchived(phase.id, false)).toBe(true);
    });
    expect(hook.result.current.state.tournament?.currentPhaseId).toBe(phase.id);

    const teamIds = hook.result.current.state.teams.map((entry) => entry.id);
    act(() => {
      expect(hook.result.current.updateFormat({ kind: 'pools', name: 'Retireable pools' })).toBe(true);
      expect(hook.result.current.addPool({ phaseId: phase.id, name: 'Pool A', teamIds })).toBe(true);
    });
    const pool = hook.result.current.state.pools[0];
    if (!pool) throw new Error('test setup did not create a pool');
    act(() => {
      expect(hook.result.current.setPoolArchived(pool.id, true)).toBe(true);
    });
    expect(hook.result.current.state.pools[0]).toMatchObject({ id: pool.id, archived: true, teamIds });
    expect(formatGenerationAvailability(hook.result.current.state).supported).toBe(false);
    expect(toInterchange(hook.result.current.state).pools[0]?.extensions).toEqual({ archived: true });

    act(() => {
      expect(hook.result.current.setPoolArchived(pool.id, false)).toBe(true);
    });
    expect(hook.result.current.state.pools[0]?.archived).toBeUndefined();
  });

  test('pool rounds avoid repeating a matchup while the pool rotation is still available', async () => {
    const { hook } = await directorWithSetup(4);
    const phaseId = hook.result.current.state.phases[0]?.id;
    const teamIds = hook.result.current.state.teams.map((entry) => entry.id);
    if (!phaseId || teamIds.length !== 4) throw new Error('test setup did not create the pool field');
    act(() => {
      hook.result.current.updateFormat({ kind: 'pools', name: 'Preliminary pools' });
      expect(hook.result.current.addPool({ phaseId, name: 'Pool A', teamIds })).toBe(true);
    });

    for (let round = 0; round < 3; round += 1) {
      let result: { generated: boolean; conflicts: string[] } | undefined;
      act(() => {
        result = hook.result.current.generateSchedule();
      });
      expect(result?.generated).toBe(true);
    }

    const pairs = hook.result.current.state.scheduledGames
      .filter((game) => game.rightTeamId)
      .map((game) => [game.leftTeamId, game.rightTeamId].sort().join('|'));
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  test('player roster entry rejects an active duplicate and supports captain assignment', async () => {
    const { hook } = await directorWithSetup();
    const teamId = hook.result.current.state.teams[0]?.id;
    if (!teamId) throw new Error('test setup did not create a team');
    act(() => {
      expect(hook.result.current.addPlayer(teamId, 'Ada', true, '07', '  Late arrival ')).toBe(true);
    });
    expect(hook.result.current.state.players).toContainEqual(
      expect.objectContaining({
        teamId,
        name: 'Ada',
        captain: true,
        active: true,
        rosterNumber: '07',
        notes: 'Late arrival',
      }),
    );
    const playerId = hook.result.current.state.players[0]?.id;
    if (!playerId) throw new Error('test setup did not create a player');
    act(() => {
      expect(
        hook.result.current.updatePlayer(playerId, {
          name: '  Ada Lovelace ',
          captain: false,
          rosterNumber: '',
          notes: '  Updated roster note ',
        }),
      ).toBe(true);
    });
    expect(hook.result.current.state.players[0]).toMatchObject({
      name: 'Ada Lovelace',
      captain: false,
      notes: 'Updated roster note',
    });
    expect(hook.result.current.state.players[0]).not.toHaveProperty('rosterNumber');
    act(() => {
      expect(hook.result.current.addPlayer(teamId, ' ada lovelace ')).toBe(false);
    });
    expect(hook.result.current.state.players.filter((player) => player.teamId === teamId)).toHaveLength(1);

    act(() => expect(hook.result.current.addPlayer(teamId, 'Grace Hopper')).toBe(true));
    const secondPlayerId = hook.result.current.state.players.find(
      (player) => player.name === 'Grace Hopper',
    )?.id;
    if (!secondPlayerId) throw new Error('test setup did not create the second player');
    act(() => {
      expect(hook.result.current.updatePlayer(playerId, { active: false })).toBe(true);
      expect(hook.result.current.updatePlayer(secondPlayerId, { name: 'Ada Lovelace' })).toBe(true);
      expect(hook.result.current.updatePlayer(playerId, { active: true })).toBe(false);
      expect(hook.result.current.updatePlayer(secondPlayerId, { name: 'Grace Hopper' })).toBe(true);
      expect(hook.result.current.removePlayer(secondPlayerId)).toBe(true);
    });
    expect(hook.result.current.state.players.find((player) => player.id === playerId)?.active).toBe(false);
    expect(hook.result.current.state.players.find((player) => player.id === secondPlayerId)?.active).toBe(
      false,
    );
    act(() => expect(hook.result.current.updatePlayer(playerId, { active: true })).toBe(true));
    expect(hook.result.current.state.players.find((player) => player.id === playerId)?.active).toBe(true);
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
    expect(hook.result.current.state.rounds[0]?.releasedAt).not.toBeNull();
    expect(hook.result.current.state.rounds[0]?.startedAt).toBeNull();
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
  });

  test('restoring an inactive captain keeps one active captain per roster', async () => {
    const { hook } = await directorWithSetup();
    const teamId = hook.result.current.state.teams[0]?.id;
    if (!teamId) throw new Error('test setup did not create a team');
    act(() => expect(hook.result.current.addPlayer(teamId, 'Captain One', true)).toBe(true));
    const firstPlayerId = hook.result.current.state.players[0]?.id;
    if (!firstPlayerId) throw new Error('test setup did not create the first player');
    act(() => {
      expect(hook.result.current.addPlayer(teamId, 'Captain Two', true)).toBe(true);
      expect(hook.result.current.updatePlayer(firstPlayerId, { active: false, captain: true })).toBe(true);
    });
    const secondPlayerId = hook.result.current.state.players.find(
      (player) => player.name === 'Captain Two',
    )?.id;
    if (!secondPlayerId) throw new Error('test setup did not create the second player');
    act(() => expect(hook.result.current.updatePlayer(firstPlayerId, { active: true })).toBe(true));
    expect(hook.result.current.state.players.find((player) => player.id === firstPlayerId)).toMatchObject({
      active: true,
      captain: true,
    });
    expect(hook.result.current.state.players.find((player) => player.id === secondPlayerId)).toMatchObject({
      active: true,
      captain: false,
    });
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
  });

  test('dropping a team is allowed after its only open slot is cancelled', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.generateSchedule());
    const scheduled = hook.result.current.state.scheduledGames[0];
    if (!scheduled) throw new Error('test setup did not generate a scheduled game');
    act(() => expect(hook.result.current.cancelScheduledGame(scheduled.id, 'Room closed')).toBe(true));
    act(() => expect(hook.result.current.dropTeam(scheduled.leftTeamId, 'Unable to attend')).toBe(true));
    expect(hook.result.current.state.teams.find((team) => team.id === scheduled.leftTeamId)?.status).toBe(
      'dropped',
    );
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
  });

  test('preflight blocks a prepared game assigned to an unavailable room', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.generateSchedule());
    const round = hook.result.current.state.rounds[0];
    const room = hook.result.current.state.rooms[0];
    if (!round || !room) throw new Error('test setup did not generate a room assignment');
    act(() => {
      expect(hook.result.current.prepareRound(round.id)).toBe(true);
      hook.result.current.updateRoom(room.id, { available: false });
    });

    expect(runPreflight(hook.result.current.state)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'games-with-unavailable-rooms',
          severity: 'blocker',
        }),
      ]),
    );
  });

  test('room availability toggles restore the schedulable idle status', async () => {
    const { hook } = await directorWithSetup();
    const room = hook.result.current.state.rooms[0];
    if (!room) throw new Error('test setup did not create a room');

    act(() => {
      expect(hook.result.current.updateRoom(room.id, { available: false })).toBe(true);
    });
    expect(hook.result.current.state.rooms[0]).toMatchObject({ available: false, status: 'offline' });

    act(() => {
      expect(hook.result.current.updateRoom(room.id, { available: true })).toBe(true);
    });
    expect(hook.result.current.state.rooms[0]).toMatchObject({ available: true, status: 'available' });
  });

  test('room, staff, and equipment names stay unique when edited through the controller', async () => {
    const { hook } = await directorWithSetup();
    act(() => {
      expect(hook.result.current.addRoom({ name: '  room 1 ' })).toBe(false);
      expect(hook.result.current.addRoom({ name: 'Room 2' })).toBe(true);
    });
    const firstRoom = hook.result.current.state.rooms[0];
    const secondRoom = hook.result.current.state.rooms[1];
    if (!firstRoom || !secondRoom) throw new Error('test setup did not create both rooms');
    act(() => {
      expect(hook.result.current.updateRoom(firstRoom.id, { name: ` ${secondRoom.name} ` })).toBe(false);
      expect(hook.result.current.addStaff({ name: 'Moderator One' })).toBe(true);
      expect(hook.result.current.addStaff({ name: ' moderator one ' })).toBe(false);
      expect(hook.result.current.addEquipment({ name: 'Buzzer One', kind: 'buzzer' })).toBe(true);
      expect(hook.result.current.addEquipment({ name: ' buzzer one ', kind: 'buzzer' })).toBe(false);
    });
    const staff = hook.result.current.state.staff[0];
    const equipment = hook.result.current.state.equipment[0];
    if (!staff || !equipment) throw new Error('test setup did not create resources');
    act(() => {
      expect(hook.result.current.updateStaff(staff.id, { name: ' moderator one ' })).toBe(true);
      expect(hook.result.current.updateEquipment(equipment.id, { name: ' buzzer one ' })).toBe(true);
    });
    expect(hook.result.current.state.rooms).toHaveLength(2);
    expect(hook.result.current.state.staff).toHaveLength(1);
    expect(hook.result.current.state.equipment).toHaveLength(1);
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
  });

  test('completed tournaments do not show next-round setup blockers', async () => {
    const { hook } = await directorWithSetup();
    const complete = structuredClone(hook.result.current.state);
    if (!complete.tournament || !complete.phases[0])
      throw new Error('test setup did not create a tournament');
    complete.tournament.status = 'complete';
    complete.phases[0].status = 'complete';

    const issueIds = runPreflight(complete, false, true).map((issue) => issue.id);
    expect(issueIds).not.toEqual(
      expect.arrayContaining(['format-generation-unavailable', 'qbtcp-offline', 'checkpoint-missing']),
    );
  });

  test('room operational notes are trimmed and persisted with the room', async () => {
    const { hook, repository } = await directorWithSetup();
    const roomId = hook.result.current.state.rooms[0]?.id;
    if (!roomId) throw new Error('test setup did not create a room');

    act(() => {
      hook.result.current.updateRoom(roomId, {
        name: '  Room 101  ',
        building: '  Main building ',
        floor: ' First ',
        accessibility: '  Step-free entrance ',
        directions: ' East stairwell ',
        notes: '  Bring the spare buzzer. ',
      });
    });

    expect(hook.result.current.state.rooms[0]).toMatchObject({
      id: roomId,
      name: 'Room 101',
      building: 'Main building',
      floor: 'First',
      accessibility: 'Step-free entrance',
      directions: 'East stairwell',
      notes: 'Bring the spare buzzer.',
    });
    await waitFor(async () => {
      const saved = await repository.load();
      expect(saved.rooms[0]).toMatchObject({
        name: 'Room 101',
        accessibility: 'Step-free entrance',
        directions: 'East stairwell',
        notes: 'Bring the spare buzzer.',
      });
    });
  });

  test('staff and equipment notes and metadata remain editable and persisted', async () => {
    const { hook, repository } = await directorWithSetup();
    act(() => {
      hook.result.current.addStaff({
        name: '  Moderator One ',
        roles: ['moderator'],
        notes: '  Call from HQ if reassigned. ',
      });
      hook.result.current.addEquipment({
        name: '  Buzzer One ',
        kind: 'buzzer',
        notes: '  Keep the spare cable nearby. ',
      });
    });
    const staffId = hook.result.current.state.staff[0]?.id;
    const equipmentId = hook.result.current.state.equipment[0]?.id;
    if (!staffId || !equipmentId) throw new Error('test setup did not create staff resources');

    act(() => {
      expect(
        hook.result.current.updateStaff(staffId, {
          name: '  Moderator Two ',
          roles: ['moderator', 'runner'],
          notes: '  Also covers room checks. ',
        }),
      ).toBe(true);
      expect(
        hook.result.current.updateEquipment(equipmentId, {
          name: '  Buzzer Two ',
          kind: 'device',
          notes: '  Fully charged. ',
        }),
      ).toBe(true);
    });

    expect(hook.result.current.state.staff[0]).toMatchObject({
      name: 'Moderator Two',
      roles: ['moderator', 'runner'],
      notes: 'Also covers room checks.',
    });
    expect(hook.result.current.state.equipment[0]).toMatchObject({
      name: 'Buzzer Two',
      kind: 'device',
      notes: 'Fully charged.',
    });
    await waitFor(async () => {
      const saved = await repository.load();
      expect(saved.staff[0]).toMatchObject({ name: 'Moderator Two', notes: 'Also covers room checks.' });
      expect(saved.equipment[0]).toMatchObject({
        name: 'Buzzer Two',
        kind: 'device',
        notes: 'Fully charged.',
      });
    });
  });

  test('schedule generation does not assign rooms that are operationally busy', async () => {
    const { hook } = await directorWithSetup();
    const roomId = hook.result.current.state.rooms[0]?.id;
    if (!roomId) throw new Error('test setup did not create a room');
    const imported = structuredClone(hook.result.current.state);
    imported.rooms[0]!.status = 'live';
    act(() => {
      expect(hook.result.current.importSnapshot(imported)).toBe(true);
    });

    let generated = false;
    act(() => {
      generated = hook.result.current.generateSchedule().generated;
    });
    expect(generated).toBe(true);
    expect(hook.result.current.state.scheduledGames[0]?.roomId).toBeNull();
    expect(hook.result.current.state.scheduledGames[0]?.roomId).not.toBe(roomId);
    expect(runPreflight(hook.result.current.state)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'games-without-rooms', severity: 'warning' })]),
    );
  });

  test('round lifecycle actions require complete field and ledger validation', async () => {
    const { hook } = await directorWithSetup(4);
    act(() => hook.result.current.generateSchedule());
    const roundId = hook.result.current.state.rounds[0]?.id;
    if (!roundId) throw new Error('test setup did not generate a round');

    const malformed = structuredClone(hook.result.current.state);
    const round = malformed.rounds[0];
    const removedGameId = round?.scheduledGameIds[0];
    if (!round || !removedGameId) throw new Error('test setup did not generate a round ledger');
    malformed.scheduledGames = malformed.scheduledGames.filter((game) => game.id !== removedGameId);

    expect(roundScheduleIsValid(malformed, roundId)).toBe(false);
    act(() => {
      expect(hook.result.current.importSnapshot(malformed)).toBe(true);
    });
    expect(hook.result.current.prepareRound(roundId)).toBe(false);
    expect(hook.result.current.state.rounds[0]?.status).toBe('planned');
  });

  test('cancelling a scheduled game rejects pending submissions and lets an unassigned slot close', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.generateSchedule());
    const generated = hook.result.current.state.scheduledGames[0];
    const round = hook.result.current.state.rounds[0];
    if (!generated || !round || !generated.rightTeamId) {
      throw new Error('test setup did not generate a playable round');
    }

    const imported = structuredClone(hook.result.current.state);
    const scheduled = imported.scheduledGames.find((game) => game.id === generated.id);
    if (!scheduled) throw new Error('test setup lost the generated game');
    const rightTeamId = scheduled.rightTeamId;
    if (!rightTeamId) throw new Error('test setup lost the opposing team');
    scheduled.roomId = null;
    scheduled.status = 'submitted';
    imported.games.push({
      id: 'pending-cancellation-game',
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
      id: 'pending-cancellation-submission',
      gameId: 'pending-cancellation-game',
      receivedAt: '2026-09-01T12:00:00.000Z',
      fingerprint: 'pending-cancellation-fingerprint',
      status: 'review',
      rawSubmission: { source: 'test' },
    });
    act(() => {
      expect(hook.result.current.importSnapshot(imported)).toBe(true);
      expect(hook.result.current.cancelScheduledGame(scheduled.id, 'Room closed')).toBe(true);
    });

    expect(hook.result.current.state.scheduledGames.find((game) => game.id === scheduled.id)?.status).toBe(
      'cancelled',
    );
    expect(
      hook.result.current.state.games.find((game) => game.id === 'pending-cancellation-game'),
    ).toMatchObject({
      status: 'cancelled',
      note: expect.stringContaining('Room closed'),
    });
    expect(
      hook.result.current.state.submissions.find(
        (submission) => submission.id === 'pending-cancellation-submission',
      ),
    ).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('Room closed'),
    });

    const lateSubmissionState = structuredClone(hook.result.current.state);
    lateSubmissionState.games.push({
      id: 'late-cancellation-game',
      scheduledGameId: scheduled.id,
      roundId: scheduled.roundId,
      packetId: scheduled.packetId,
      status: 'submitted',
      scores: [score(scheduled.leftTeamId, 30), score(rightTeamId, 15)],
      playerStats: [],
      source: 'qbtcp',
      detailedStats: 'unknown',
    });
    lateSubmissionState.submissions.push({
      id: 'late-cancellation-submission',
      gameId: 'late-cancellation-game',
      receivedAt: '2026-09-01T12:01:00.000Z',
      fingerprint: 'late-cancellation-fingerprint',
      status: 'review',
      rawSubmission: { source: 'test' },
    });
    act(() => {
      expect(hook.result.current.importSnapshot(lateSubmissionState)).toBe(true);
    });
    let acceptedLateResult = true;
    let addedLateResult = true;
    act(() => {
      acceptedLateResult = hook.result.current.acceptSubmission('late-cancellation-submission');
      addedLateResult = hook.result.current.addManualResult({
        scheduledGameId: scheduled.id,
        scores: [score(scheduled.leftTeamId, 30), score(rightTeamId, 15)],
      });
    });
    expect(acceptedLateResult).toBe(false);
    expect(addedLateResult).toBe(false);
    expect(hook.result.current.state.scheduledGames.find((game) => game.id === scheduled.id)?.status).toBe(
      'cancelled',
    );

    act(() => {
      expect(hook.result.current.prepareRound(round.id)).toBe(true);
      expect(hook.result.current.releaseRound(round.id)).toBe(true);
      expect(hook.result.current.closeRound(round.id)).toBe(true);
    });
    expect(hook.result.current.state.rounds.find((entry) => entry.id === round.id)?.status).toBe('closed');
    expect(hook.result.current.state.audit.some((event) => event.type === 'schedule-cancelled')).toBe(true);
  });

  test('preflight reports scheduled games that are detached from every round', async () => {
    const { hook } = await directorWithSetup(4);
    act(() => hook.result.current.generateSchedule());
    const imported = structuredClone(hook.result.current.state);
    const source = imported.scheduledGames[0];
    if (!source) throw new Error('test setup did not generate a scheduled game');
    imported.scheduledGames.push({ ...source, id: 'orphan-game', roundId: 'missing-round' });

    const orphanIssue = runPreflight(imported).find((issue) => issue.id === 'games-without-round');
    expect(orphanIssue?.severity).toBe('blocker');
    expect(orphanIssue?.message).toMatch(/1 scheduled game/);
  });

  test('format type changes are blocked after schedule generation', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.generateSchedule());
    act(() => hook.result.current.updateFormat({ kind: 'pools' }));

    expect(hook.result.current.state.formats[0]?.kind).toBe('round-robin');
    expect(hook.result.current.error).toMatch(/locked after schedule generation/i);
  });

  test('rounds per team limits generation and validates persisted format settings', async () => {
    const { hook } = await directorWithSetup(4);
    let updated = false;
    act(() => {
      updated = hook.result.current.updateFormat({ roundsPerTeam: 2 });
    });
    expect(updated).toBe(true);
    expect(hook.result.current.state.formats[0]?.roundsPerTeam).toBe(2);

    for (let index = 0; index < 2; index += 1) {
      let result: ReturnType<typeof hook.result.current.generateSchedule> | undefined;
      act(() => {
        result = hook.result.current.generateSchedule({ seed: index + 1 });
      });
      expect(result?.generated).toBe(true);
    }

    let extraRound: ReturnType<typeof hook.result.current.generateSchedule> | undefined;
    act(() => {
      extraRound = hook.result.current.generateSchedule({ seed: 3 });
    });
    expect(extraRound).toEqual({
      generated: false,
      conflicts: ['This format has reached its configured limit of 2 rounds per team.'],
    });
    expect(formatGenerationAvailability(hook.result.current.state)).toMatchObject({ supported: false });

    act(() => {
      updated = hook.result.current.updateFormat({ roundsPerTeam: 0 });
    });
    expect(updated).toBe(false);
    expect(hook.result.current.state.formats[0]?.roundsPerTeam).toBe(2);
    expect(hook.result.current.error).toMatch(/whole number from 1 to 99/i);
  });

  test('double round robin repeats its first rotation once and then stops', async () => {
    const { hook } = await directorWithSetup(4);
    act(() => hook.result.current.updateFormat({ kind: 'double-round-robin', avoidRematches: false }));
    for (let index = 0; index < 6; index += 1) {
      let result: ReturnType<typeof hook.result.current.generateSchedule> | undefined;
      act(() => {
        result = hook.result.current.generateSchedule({ seed: 11 });
      });
      expect(result?.generated).toBe(true);
    }

    const pairingsByRound = hook.result.current.state.rounds.map((round) =>
      hook.result.current.state.scheduledGames
        .filter((game) => game.roundId === round.id && !game.bye)
        .map((game) => [game.leftTeamId, game.rightTeamId].sort().join('|'))
        .sort(),
    );
    expect(pairingsByRound).toHaveLength(6);
    expect(pairingsByRound.slice(3)).toEqual(pairingsByRound.slice(0, 3));

    let extraRound: ReturnType<typeof hook.result.current.generateSchedule> | undefined;
    act(() => {
      extraRound = hook.result.current.generateSchedule({ seed: 11 });
    });
    expect(extraRound).toEqual({
      generated: false,
      conflicts: ['This double round robin already contains both complete rotations.'],
    });
    expect(formatGenerationAvailability(hook.result.current.state)).toMatchObject({ supported: false });
  });

  test('preflight stays silent about delivery for a roomless manual tournament', async () => {
    const { hook } = await directorWithSetup(2);
    const roomless = structuredClone(hook.result.current.state);
    roomless.rooms = [];
    act(() => {
      expect(hook.result.current.importSnapshot(roomless)).toBe(true);
    });
    const issueIds = runPreflight(hook.result.current.state, false, true).map((issue) => issue.id);
    expect(issueIds).not.toContain('qbtcp-offline');
    expect(issueIds).not.toContain('games-without-rooms');

    const roomed = structuredClone(hook.result.current.state);
    // Restore the setup room: delivery guidance returns with it.
    roomed.rooms = [
      {
        id: 'room-1',
        name: 'Room 1',
        status: 'available',
        moderatorId: null,
        scorekeeperId: null,
        equipmentId: null,
        available: true,
      },
    ];
    act(() => {
      expect(hook.result.current.importSnapshot(roomed)).toBe(true);
    });
    const roomedIds = runPreflight(hook.result.current.state, false, true).map((issue) => issue.id);
    expect(roomedIds).toContain('qbtcp-offline');
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

  test('packet metadata can be edited and persists through the repository', async () => {
    const { hook, repository } = await directorWithSetup();
    const packet = hook.result.current.state.packets[0];
    if (!packet) throw new Error('test setup did not create a packet');

    act(() => {
      expect(
        hook.result.current.updatePacket(packet.id, {
          name: '  Championship tiebreaker  ',
          tiebreaker: true,
          notes: '  Keep sealed until needed.  ',
        }),
      ).toBe(true);
    });

    expect(hook.result.current.state.packets[0]).toMatchObject({
      id: packet.id,
      name: 'Championship tiebreaker',
      tiebreaker: true,
      notes: 'Keep sealed until needed.',
    });
    await waitFor(async () =>
      expect((await repository.load()).packets[0]?.notes).toBe('Keep sealed until needed.'),
    );

    act(() => {
      expect(hook.result.current.updatePacket(packet.id, { notes: '  ' })).toBe(true);
    });
    expect(hook.result.current.state.packets[0]?.notes).toBeUndefined();
    await waitFor(async () => expect((await repository.load()).packets[0]?.notes).toBeUndefined());
  });

  test('packet edits reject duplicate names without mutating the inventory', async () => {
    const { hook } = await directorWithSetup();
    act(() => expect(hook.result.current.addPacket('Packet 2')).toBe(true));
    const before = structuredClone(hook.result.current.state.packets);
    const packet = hook.result.current.state.packets[1];
    if (!packet) throw new Error('test setup did not create a second packet');

    act(() => {
      expect(hook.result.current.updatePacket(packet.id, { name: ' packet 1 ' })).toBe(false);
    });
    expect(hook.result.current.state.packets).toEqual(before);
    expect(hook.result.current.error).toMatch(/already exists/i);

    act(() => expect(hook.result.current.addPacket(' packet 1 ')).toBe(false));
    expect(hook.result.current.state.packets).toEqual(before);
  });

  test('packet retirement preserves historical references and selects only live inventory', async () => {
    const { hook } = await directorWithSetup();
    act(() => expect(hook.result.current.addPacket('Packet 2')).toBe(true));
    const first = hook.result.current.state.packets[0];
    const second = hook.result.current.state.packets[1];
    if (!first || !second) throw new Error('test setup did not create two packets');

    act(() => hook.result.current.generateSchedule());
    const scheduled = hook.result.current.state.scheduledGames[0];
    if (!scheduled) throw new Error('test setup did not generate a scheduled game');
    expect(first.assignedGameIds).toHaveLength(0);
    expect(hook.result.current.state.packets[0]?.assignedGameIds).toContain(scheduled.id);

    act(() => expect(hook.result.current.setPacketRetired(first.id, true)).toBe(true));
    expect(hook.result.current.state.packets.find((packet) => packet.id === first.id)).toMatchObject({
      retired: true,
      assignedGameIds: [scheduled.id],
    });
    expect(hook.result.current.state.tournament?.currentPacketId).toBe(second.id);

    act(() => hook.result.current.selectPacket(first.id));
    expect(hook.result.current.error).toMatch(/retired packets cannot be selected/i);
    act(() => expect(hook.result.current.setPacketRetired(first.id, false)).toBe(true));
    expect(
      hook.result.current.state.packets.find((packet) => packet.id === first.id)?.retired,
    ).toBeUndefined();
    expect(hook.result.current.state.audit.at(-1)).toMatchObject({
      type: 'packet-changed',
      entityId: first.id,
      details: { retired: false, retainsHistory: true },
    });
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
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

  test('phase and tiebreaker settings validate and persist as structured rules', async () => {
    const { hook } = await directorWithSetup();
    const phase = hook.result.current.state.phases[0];
    if (!phase) throw new Error('test setup did not create a phase');

    act(() => {
      expect(
        hook.result.current.updatePhase(phase.id, {
          name: 'Championship prelims',
          kind: 'playoff',
          carryover: true,
          advancementRule: {
            qualifiersPerPool: 2,
            tiebreakers: ['record', 'points'],
            manualOverrideAllowed: true,
          },
        }),
      ).toBe(true);
      expect(
        hook.result.current.updateRules({
          tiebreakers: ['record', 'head-to-head', 'points', 'margin', 'powers', 'gets', 'playoff'],
        }),
      ).toBe(true);
    });

    expect(hook.result.current.state.phases[0]).toMatchObject({
      name: 'Championship prelims',
      kind: 'playoff',
      carryover: true,
      advancementRule: {
        qualifiersPerPool: 2,
        tiebreakers: ['record', 'points'],
        manualOverrideAllowed: true,
      },
    });
    expect(hook.result.current.state.tournament?.rules.tiebreakers[0]).toBe('record');

    act(() => {
      expect(
        hook.result.current.updatePhase(phase.id, {
          advancementRule: {
            qualifiersPerPool: 0,
            tiebreakers: ['record'],
            manualOverrideAllowed: false,
          },
        }),
      ).toBe(false);
      expect(hook.result.current.updateRules({ tiebreakers: ['record', 'record'] })).toBe(false);
    });
    expect(hook.result.current.error).toMatch(/repeated|positive whole number/i);
  });

  test('generation availability blocks fields that are too small or phases that are complete', async () => {
    const { hook } = await directorWithSetup(1);
    expect(formatGenerationAvailability(hook.result.current.state)).toMatchObject({
      supported: false,
      message: expect.stringMatching(/at least two confirmed teams/i),
    });

    const complete = structuredClone(hook.result.current.state);
    complete.teams.push({ ...team('second') });
    complete.phases[0]!.status = 'complete';
    expect(formatGenerationAvailability(complete)).toMatchObject({
      supported: false,
      message: expect.stringMatching(/phase is complete/i),
    });
    expect(generateDirectorRound(complete).hardFailure).toBe(true);
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

  test('organizations can be edited and archived without removing historical team links', async () => {
    const { hook } = await directorWithSetup(1);
    const target = hook.result.current.state.teams[0];
    if (!target) throw new Error('test setup did not create a team');

    let added = false;
    act(() => {
      added = hook.result.current.addOrganization({
        name: 'Northview High',
        shortName: 'Northview',
        notes: 'Archived after the season',
      });
    });
    expect(added).toBe(true);
    const organization = hook.result.current.state.organizations[0];
    if (!organization) throw new Error('organization was not created');

    act(() => {
      expect(hook.result.current.updateTeam(target.id, { organizationName: organization.name })).toBe(true);
      expect(hook.result.current.updateOrganization(organization.id, { shortName: 'NV' })).toBe(true);
    });
    expect(hook.result.current.state.organizations[0]).toMatchObject({ shortName: 'NV' });

    act(() => {
      expect(hook.result.current.dropTeam(target.id)).toBe(true);
      expect(hook.result.current.setOrganizationArchived(organization.id, true)).toBe(true);
    });
    expect(hook.result.current.state.teams[0]?.organizationId).toBe(organization.id);
    expect(hook.result.current.state.organizations[0]?.archived).toBe(true);
    expect(toInterchange(hook.result.current.state).organizations[0]?.extensions).toEqual({ archived: true });

    let addedToArchived = true;
    act(() => {
      addedToArchived = hook.result.current.addTeam({
        displayName: 'New team',
        organizationName: 'Northview High',
      });
    });
    expect(addedToArchived).toBe(false);
    act(() => {
      expect(hook.result.current.setOrganizationArchived(organization.id, false)).toBe(true);
    });
    expect(hook.result.current.state.organizations[0]?.archived).toBeUndefined();
  });

  test('team mutations reject duplicate names and protect open rounds', async () => {
    const { hook } = await directorWithSetup();
    const firstTeam = hook.result.current.state.teams[0];
    if (!firstTeam) throw new Error('test setup did not create a team');

    let added = true;
    act(() => {
      added = hook.result.current.addTeam({ displayName: ` ${firstTeam.displayName.toUpperCase()} ` });
    });
    expect(added).toBe(false);
    expect(hook.result.current.state.teams).toHaveLength(2);

    let renamed = true;
    act(() => {
      renamed = hook.result.current.updateTeam(firstTeam.id, { displayName: ' team 2 ' });
    });
    expect(renamed).toBe(false);
    expect(hook.result.current.state.teams[0]?.displayName).toBe(firstTeam.displayName);

    let edited = true;
    act(() => {
      edited = hook.result.current.updateTeam(firstTeam.id, { displayName: '   ' });
    });
    expect(edited).toBe(false);
    expect(hook.result.current.state.teams[0]?.displayName).toBe(firstTeam.displayName);

    act(() => hook.result.current.generateSchedule());
    let dropped = true;
    act(() => {
      dropped = hook.result.current.dropTeam(firstTeam.id);
    });
    expect(dropped).toBe(false);
    expect(hook.result.current.state.teams[0]?.status).toBe('confirmed');
    expect(hook.result.current.error).toMatch(/finish or repair/i);
  });

  test('closed round history remains valid after a team is dropped and replaced', async () => {
    const { hook } = await directorWithSetup();
    act(() => hook.result.current.generateSchedule());
    const scheduled = hook.result.current.state.scheduledGames.find((game) => !game.bye);
    const round = hook.result.current.state.rounds[0];
    if (!scheduled || !round || !scheduled.rightTeamId) throw new Error('test setup did not generate a game');

    act(() => {
      expect(hook.result.current.prepareRound(round.id)).toBe(true);
      expect(hook.result.current.releaseRound(round.id)).toBe(true);
      expect(
        hook.result.current.addManualResult({
          scheduledGameId: scheduled.id,
          scores: [score(scheduled.leftTeamId, 120), score(scheduled.rightTeamId!, 90)],
        }),
      ).toBe(true);
      expect(hook.result.current.closeRound(round.id)).toBe(true);
    });
    expect(hook.result.current.state.rounds[0]?.status).toBe('closed');

    act(() => {
      expect(hook.result.current.dropTeam(scheduled.leftTeamId, 'Medical withdrawal')).toBe(true);
      expect(hook.result.current.addTeam({ displayName: 'Replacement Team' })).toBe(true);
    });
    expect(roundScheduleIsValid(hook.result.current.state, round.id)).toBe(true);
    expect(
      runPreflight(hook.result.current.state).some((issue) => issue.id === `round-invalid-${round.id}`),
    ).toBe(false);
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

  test('protests cannot target an accepted bye or unmatched scheduled game', async () => {
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
    const importedScheduled = imported.scheduledGames.find((entry) => entry.id === scheduled.id);
    if (!importedScheduled) throw new Error('test setup lost the scheduled game');
    importedScheduled.rightTeamId = null;
    importedScheduled.bye = true;
    act(() => {
      expect(hook.result.current.importSnapshot(imported)).toBe(true);
    });

    let added = true;
    act(() => {
      added = hook.result.current.addProtest(game.id, 'This bye should not be protestable.');
    });
    expect(added).toBe(false);
    expect(hook.result.current.state.protests).toHaveLength(0);
    expect(hook.result.current.error).toMatch(/two-team game/i);
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
        scheduledStart: null,
        releasedAt: null,
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
        scheduledStart: null,
        releasedAt: null,
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
    const ambiguousState = structuredClone(hook.result.current.state);
    ambiguousState.teams.find((team) => team.id === leftTeamId)!.displayName = 'Same name';
    ambiguousState.teams.find((team) => team.id === rightTeamId)!.displayName = 'Same name';
    act(() => expect(hook.result.current.importSnapshot(ambiguousState)).toBe(true));
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

  test('a QBTCP restart closes persisted help requests the server no longer knows', async () => {
    const { hook } = await directorWithSetup();
    const imported = structuredClone(hook.result.current.state);
    const room = imported.rooms[0];
    if (!room) throw new Error('test setup did not create a room');
    room.status = 'help';
    imported.qbtcpSessions = [
      {
        roomId: room.id,
        sessionId: 'help-session',
        deviceId: 'device-1',
        state: 'live',
        resumable: false,
        resultReceived: false,
        lastSeenAt: '2026-09-01T11:02:00.000Z',
        progress: null,
        helpRequestId: 'help-restarted',
      },
    ];
    imported.qbtcpHelpRequests = [
      {
        id: 'help-restarted',
        roomId: room.id,
        roomName: room.name,
        category: 'equipment-technical',
        message: 'Buzzer is not responding',
        status: 'open',
        createdAt: '2026-09-01T11:01:00.000Z',
        updatedAt: '2026-09-01T11:01:00.000Z',
        deviceId: 'device-1',
      },
    ];
    act(() => {
      expect(hook.result.current.importSnapshot(imported)).toBe(true);
    });
    const invoke = vi.fn(async () => ({
      results: [],
      progress: [],
      presence: [],
      sessions: [],
      help: [],
      rosterAmendments: [],
    }));
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });
    await act(async () => {
      await hook.result.current.syncQbtcp();
    });

    expect(hook.result.current.state.qbtcpHelpRequests[0]?.status).toBe('cancelled');
    expect(hook.result.current.state.qbtcpSessions[0]?.helpRequestId).toBeNull();
    expect(hook.result.current.state.rooms[0]?.status).toBe('available');
  });

  test('Director resolves QBTCP help through the trusted native operation and restores derived room state', async () => {
    const { hook } = await directorWithSetup();
    const imported = structuredClone(hook.result.current.state);
    const room = imported.rooms[0];
    if (!room) throw new Error('test setup did not create a room');
    room.status = 'help';
    imported.qbtcpSessions = [
      {
        roomId: room.id,
        sessionId: 'resolve-session',
        deviceId: 'resolve-device',
        state: 'live',
        resumable: false,
        resultReceived: false,
        lastSeenAt: '2026-09-01T11:02:00.000Z',
        progress: null,
        helpRequestId: 'help-to-resolve',
      },
    ];
    imported.qbtcpHelpRequests = [
      {
        id: 'help-to-resolve',
        roomId: room.id,
        roomName: room.name,
        category: 'procedure',
        message: 'Please confirm the procedure.',
        status: 'open',
        createdAt: '2026-09-01T11:01:00.000Z',
        updatedAt: '2026-09-01T11:01:00.000Z',
        deviceId: 'resolve-device',
      },
    ];
    act(() => expect(hook.result.current.importSnapshot(imported)).toBe(true));
    saveOperatorProfile({ displayName: 'Resolution Director', role: 'Tournament control' });
    const invoke = vi.fn(async (command: string) => {
      if (command === 'director_resolve_qbtcp_help') {
        return {
          ...imported.qbtcpHelpRequests[0],
          status: 'resolved',
          updatedAt: '2026-09-01T11:05:00.000Z',
        };
      }
      return undefined;
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });

    await act(async () => {
      expect(await hook.result.current.resolveQbtcpHelp('help-to-resolve')).toBe(true);
    });
    expect(invoke).toHaveBeenCalledWith('director_resolve_qbtcp_help', { helpId: 'help-to-resolve' });
    expect(hook.result.current.state.qbtcpHelpRequests[0]).toMatchObject({
      id: 'help-to-resolve',
      status: 'resolved',
      updatedAt: '2026-09-01T11:05:00.000Z',
    });
    expect(hook.result.current.state.qbtcpSessions[0]?.helpRequestId).toBeNull();
    expect(hook.result.current.state.rooms[0]?.status).toBe('live');
    expect(hook.result.current.state.audit.at(-1)).toMatchObject({
      type: 'qbtcp-help-resolved',
      actor: 'Resolution Director',
      entityId: 'help-to-resolve',
    });
  });

  test('QBTCP roster amendments are idempotent and require an auditable Director decision', async () => {
    const { hook } = await directorWithSetup();
    const [teamOne, teamTwo] = hook.result.current.state.teams;
    if (!teamOne || !teamTwo) throw new Error('test setup did not create two teams');
    act(() => expect(hook.result.current.addPlayer(teamOne.id, 'Ada Lovelace')).toBe(true));
    const existing = hook.result.current.state.players[0];
    if (!existing) throw new Error('test setup did not create an existing player');
    saveOperatorProfile({ displayName: 'Casey Director', role: 'Head director' });

    const invoke = vi.fn(async () => ({
      results: [],
      progress: [],
      presence: [],
      sessions: [],
      help: [],
      rosterAmendments: [
        { sessionId: 'session-new', amendment: { playerName: 'Grace Hopper', teamId: teamOne.id } },
        { sessionId: 'session-map', amendment: { playerName: 'Ada', teamId: teamOne.id } },
        { sessionId: 'session-reject', amendment: { playerName: 'Mystery', teamId: teamTwo.id } },
      ],
    }));
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });
    await act(async () => {
      await hook.result.current.syncQbtcp();
      await hook.result.current.syncQbtcp();
    });
    expect(hook.result.current.state.qbtcpRosterAmendments).toHaveLength(3);

    const bySession = (sessionId: string) =>
      hook.result.current.state.qbtcpRosterAmendments.find((entry) => entry.sessionId === sessionId)!;
    const newAmendment = bySession('session-new');
    const mapAmendment = bySession('session-map');
    const rejectAmendment = bySession('session-reject');

    act(() => {
      expect(hook.result.current.approveRosterAmendmentAsNew(newAmendment.id)).toBe(true);
      expect(hook.result.current.mapRosterAmendment(mapAmendment.id, existing.id)).toBe(true);
      expect(
        hook.result.current.rejectRosterAmendment(rejectAmendment.id, 'Not on the submitted roster'),
      ).toBe(true);
    });

    expect(hook.result.current.state.qbtcpRosterAmendments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: newAmendment.id,
          status: 'approved-new',
          decidedBy: 'Casey Director',
          mappedPlayerId: null,
        }),
        expect.objectContaining({
          id: mapAmendment.id,
          status: 'mapped-existing',
          decidedBy: 'Casey Director',
          mappedPlayerId: existing.id,
        }),
        expect.objectContaining({
          id: rejectAmendment.id,
          status: 'rejected',
          decidedBy: 'Casey Director',
          decisionReason: 'Not on the submitted roster',
        }),
      ]),
    );
    expect(hook.result.current.state.players.some((player) => player.name === 'Grace Hopper')).toBe(true);
    expect(hook.result.current.state.qbtcpRosterAmendments[0]?.amendment).toEqual({
      playerName: 'Grace Hopper',
      teamId: teamOne.id,
    });
    expect(
      hook.result.current.state.audit.filter(
        (event) => event.type === 'roster-amendment' && event.actor === 'Casey Director',
      ),
    ).toHaveLength(3);
    act(() => {
      expect(hook.result.current.rejectRosterAmendment(newAmendment.id)).toBe(false);
    });
  });

  test('legacy roster observations migrate to deterministic pending decisions', () => {
    const legacy = emptyDirectorState() as unknown as Record<string, unknown>;
    legacy.schemaVersion = 4;
    legacy.qbtcpRosterAmendments = [
      { sessionId: 'session-legacy', amendment: { teamId: 'team-1', playerName: 'Ada' } },
    ];
    const normalized = normalizeDirectorState(legacy);
    expect(normalized.schemaVersion).toBe(directorSchemaVersion);
    expect(normalized.qbtcpRosterAmendments[0]).toMatchObject({
      sessionId: 'session-legacy',
      status: 'pending',
      decidedAt: null,
      decidedBy: null,
      mappedPlayerId: null,
    });
    expect(normalized.qbtcpRosterAmendments[0]?.id).toMatch(/^roster-amendment-/);
    expect(normalized.qbtcpRosterAmendments[0]?.amendment).toEqual({ teamId: 'team-1', playerName: 'Ada' });
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
      timeZone: 'America/New_York',
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

  test('cancelled scheduled games never contribute accepted records to standings', () => {
    const state = emptyDirectorState();
    state.teams = [team('active'), team('opponent')];
    state.games = [acceptedGame('2026-02-02', 'round-1', 'active', 5, 'opponent', 0)];
    state.scheduledGames = [scheduledForGame(state.games[0]!, 'active', 'opponent', { status: 'cancelled' })];

    const standings = deriveTeamStandings(state);
    expect(standings.every((standing) => standing.gamesPlayed === 0)).toBe(true);
    expect(standings.every((standing) => standing.wins === 0 && standing.losses === 0)).toBe(true);
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
      timeZone: 'America/New_York',
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
        scheduledStart: null,
        releasedAt: null,
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
        scheduledStart: null,
        releasedAt: null,
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
    expect(migrated.schemaVersion).toBe(directorSchemaVersion);
    expect(migrated.tournament?.currentPhaseId).toBe('phase-old');
    expect(migrated.tournament?.currentPacketId).toBeNull();
    // v3 adds the tournament zone. A document that never recorded one gets UTC rather than this
    // machine's zone, so a migration cannot silently move a tournament's schedule by an hour.
    expect(migrated.tournament?.timeZone).toBe('UTC');
    expect(migrated.timeline).toEqual([]);
    expect(migrated.live).toBeNull();
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

  test('v3 round timestamps migrate from release time without inventing an actual start', () => {
    const legacy = emptyDirectorState() as unknown as Record<string, unknown>;
    legacy.schemaVersion = 3;
    legacy.rounds = [
      {
        id: 'legacy-round',
        phaseId: 'phase-1',
        name: 'Legacy round',
        number: 1,
        revision: 1,
        status: 'released',
        packetId: null,
        scheduledGameIds: [],
        startedAt: '2026-09-05T13:53:00.000Z',
        closedAt: null,
      },
    ];
    const migrated = normalizeDirectorState(legacy);
    expect(migrated.rounds[0]).toMatchObject({
      scheduledStart: null,
      releasedAt: '2026-09-05T13:53:00.000Z',
      startedAt: null,
    });
  });

  test('a partial or invalid rules object is completed without preserving unsafe fields', () => {
    const legacy = emptyDirectorState() as unknown as Record<string, unknown>;
    legacy.tournament = {
      id: 'tournament-partial-rules',
      name: 'Partial rules tournament',
      status: 'draft',
      rules: {
        tossupValue: 20,
        negValue: -4,
        bonusParts: 0,
        bouncebacks: true,
        tiebreakers: ['record', 'not-a-tiebreaker'],
      },
    };

    const normalized = normalizeDirectorState(legacy);
    expect(normalized.tournament?.rules).toMatchObject({
      tossupValue: 20,
      negValue: -4,
      powerValue: defaultRules.powerValue,
      bonusParts: defaultRules.bonusParts,
      bouncebacks: true,
      tiebreakers: defaultRules.tiebreakers,
    });

    const emptyTiebreakers = structuredClone(legacy);
    (emptyTiebreakers.tournament as Record<string, unknown>).rules = { tiebreakers: [] };
    expect(normalizeDirectorState(emptyTiebreakers).tournament?.rules.tiebreakers).toEqual(
      defaultRules.tiebreakers,
    );

    const duplicateTiebreakers = structuredClone(legacy);
    (duplicateTiebreakers.tournament as Record<string, unknown>).rules = {
      tiebreakers: ['record', 'record'],
    };
    expect(normalizeDirectorState(duplicateTiebreakers).tournament?.rules.tiebreakers).toEqual(
      defaultRules.tiebreakers,
    );
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

  test('browser storage migrates the legacy current document into the tournament catalog', async () => {
    const legacy = emptyDirectorState();
    legacy.schemaVersion = 4;
    legacy.tournament = {
      id: 'browser-legacy',
      name: 'Legacy browser event',
      date: '2026-09-02',
      venue: 'Hall',
      organizer: 'QBSheet',
      status: 'running',
      timeZone: 'UTC',
      rules: structuredClone(defaultRules),
      formatId: null,
      currentPhaseId: null,
      currentPacketId: null,
      currentRoundId: null,
      createdAt: '2026-09-02T10:00:00.000Z',
      updatedAt: '2026-09-02T10:00:00.000Z',
    };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('qbsheet-director', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('tournament-state');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('tournament-state', 'readwrite');
        transaction.objectStore('tournament-state').put(legacy, 'current');
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });

    const repository = new IndexedDbDirectorRepository();
    const loaded = await repository.load();
    expect(loaded.tournament?.id).toBe('browser-legacy');
    expect(loaded.schemaVersion).toBe(directorSchemaVersion);
    expect(await repository.listTournaments()).toEqual([
      expect.objectContaining({ id: 'browser-legacy', name: 'Legacy browser event' }),
    ]);
  });

  test('browser catalog keeps A and B independent across switching, archive, reopen, and restart', async () => {
    const makeState = (id: string, name: string): DirectorState => {
      const state = emptyDirectorState();
      state.tournament = {
        id,
        name,
        date: '2026-09-02',
        venue: 'Hall',
        organizer: 'QBSheet',
        status: 'draft',
        timeZone: 'UTC',
        rules: structuredClone(defaultRules),
        formatId: null,
        currentPhaseId: null,
        currentPacketId: null,
        currentRoundId: null,
        createdAt: `${id}-created`,
        updatedAt: `${id}-created`,
      };
      return state;
    };
    const repository = new IndexedDbDirectorRepository();
    const stateA = makeState('tournament-a', 'Tournament A');
    const stateB = makeState('tournament-b', 'Tournament B');
    await repository.saveDocument(stateA, true);
    await repository.saveDocument(stateB, true);
    const changedB = structuredClone(stateB);
    changedB.tournament!.venue = 'B venue';
    changedB.tournament!.updatedAt = '2026-09-02T11:00:00.000Z';
    await repository.saveDocument(changedB, true);
    const changedA = structuredClone(stateA);
    changedA.tournament!.venue = 'A venue';
    changedA.tournament!.updatedAt = '2026-09-02T12:00:00.000Z';
    await repository.saveDocument(changedA, false);

    expect((await repository.openTournament('tournament-b')).tournament?.venue).toBe('B venue');
    expect((await repository.openTournament('tournament-a')).tournament?.venue).toBe('A venue');
    expect((await repository.readTournament('tournament-b')).tournament?.venue).toBe('B venue');

    const restarted = new IndexedDbDirectorRepository();
    expect((await restarted.load()).tournament?.id).toBe('tournament-a');
    const archived = structuredClone(changedA);
    archived.tournament!.status = 'archived';
    await restarted.saveDocument(archived, false);
    expect((await restarted.listTournaments()).filter((entry) => entry.status !== 'archived')).toHaveLength(
      1,
    );
    const reopened = structuredClone(archived);
    reopened.tournament!.status = 'draft';
    await restarted.saveDocument(reopened, false);
    expect((await restarted.listTournaments()).filter((entry) => entry.status === 'archived')).toHaveLength(
      0,
    );
  });

  test('localStorage catalog fallback is migrated in full when IndexedDB becomes available', async () => {
    const makeState = (id: string): DirectorState => {
      const state = emptyDirectorState();
      state.tournament = {
        id,
        name: id,
        date: '',
        venue: '',
        organizer: '',
        status: 'draft',
        timeZone: 'UTC',
        rules: structuredClone(defaultRules),
        formatId: null,
        currentPhaseId: null,
        currentPacketId: null,
        currentRoundId: null,
        createdAt: id,
        updatedAt: id,
      };
      return state;
    };
    window.localStorage.setItem(
      'qbsheet.director.library.v1',
      JSON.stringify({
        currentId: 'fallback-b',
        documents: { 'fallback-a': makeState('fallback-a'), 'fallback-b': makeState('fallback-b') },
      }),
    );
    const repository = new IndexedDbDirectorRepository();
    expect((await repository.load()).tournament?.id).toBe('fallback-b');
    expect((await repository.listTournaments()).map((entry) => entry.id).sort()).toEqual([
      'fallback-a',
      'fallback-b',
    ]);
  });
});
