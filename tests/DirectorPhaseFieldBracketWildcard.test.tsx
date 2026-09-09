import { describe, expect, test } from 'vitest';
import {
  defaultRules,
  emptyDirectorState,
  generateDirectorRound,
  phaseCompetitiveField,
  previewAdvancement,
  unresolvedBracketDependencyForTeam,
  type DirectorState,
  type Team,
} from '../src/director/domain';

function testTeam(id: string): Team {
  return {
    id,
    organizationId: null,
    displayName: id,
    teamLetter: '',
    seed: null,
    status: 'confirmed',
    createdAt: '',
    updatedAt: '',
  };
}

function baseState(kind: DirectorState['formats'][number]['kind'], phaseId = 'phase-playoff') {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-test',
    name: 'Phase field regressions',
    date: '',
    venue: '',
    organizer: '',
    status: 'running',
    timeZone: 'America/New_York',
    rules: structuredClone(defaultRules),
    formatId: 'format-test',
    currentPhaseId: phaseId,
    currentPacketId: null,
    currentRoundId: null,
    createdAt: '',
    updatedAt: '',
  };
  state.formats = [
    {
      id: 'format-test',
      name: kind,
      kind,
      phaseIds: ['phase-prelim', phaseId],
      roundsPerTeam: null,
      avoidRematches: true,
      avoidSameOrganization: false,
      allowByes: true,
      editable: true,
    },
  ];
  state.phases = [
    {
      id: 'phase-prelim',
      name: 'Prelim',
      kind: 'preliminary',
      order: 1,
      formatId: 'format-test',
      poolIds: [],
      roundIds: [],
      advancementRule: null,
      carryover: false,
      status: 'complete',
    },
    {
      id: phaseId,
      name: 'Playoff',
      kind: 'playoff',
      order: 2,
      formatId: 'format-test',
      poolIds: [],
      roundIds: [],
      advancementRule: null,
      carryover: false,
      status: 'active',
    },
  ];
  return state;
}

function acceptedResult(
  id: string,
  scheduledGameId: string,
  roundId: string,
  leftTeamId: string,
  rightTeamId: string,
  leftScore: number,
  rightScore: number,
): DirectorState['games'][number] {
  return {
    id,
    scheduledGameId,
    roundId,
    packetId: null,
    status: 'accepted',
    scores: [
      {
        teamId: leftTeamId,
        score: leftScore,
        superpowers: 0,
        powers: 0,
        gets: 0,
        negs: 0,
        bonuses: 0,
        bonusPoints: 0,
        bouncebacks: 0,
      },
      {
        teamId: rightTeamId,
        score: rightScore,
        superpowers: 0,
        powers: 0,
        gets: 0,
        negs: 0,
        bonuses: 0,
        bonusPoints: 0,
        bouncebacks: 0,
      },
    ],
    playerStats: [],
    source: 'manual',
    detailedStats: 'unknown',
    acceptedAt: id,
  };
}

describe('phase-scoped scheduling and advancement', () => {
  test.each(['round-robin', 'swiss', 'single-elimination'] as const)(
    '%s uses an explicit later-phase field instead of the global roster',
    (kind) => {
      const state = baseState(kind);
      state.teams = ['qualified-a', 'qualified-b', 'eliminated-a', 'eliminated-b'].map(testTeam);
      state.phases[1]!.teamIds = ['qualified-a', 'qualified-b'];

      const result = generateDirectorRound(state, { seed: 4 });

      expect(result.hardFailure).toBe(false);
      expect(
        new Set(
          result.games.flatMap((game) => [game.leftTeamId, ...(game.rightTeamId ? [game.rightTeamId] : [])]),
        ),
      ).toEqual(new Set(['qualified-a', 'qualified-b']));
      if (kind === 'single-elimination') {
        expect(result.bracket?.seeding.map((entry) => entry.teamId)).toEqual(
          expect.arrayContaining(['qualified-a', 'qualified-b']),
        );
        expect(result.bracket?.seeding).toHaveLength(2);
      }
    },
  );

  test('a later non-pool phase without a committed field fails explicitly', () => {
    const state = baseState('round-robin');
    state.teams = [testTeam('A'), testTeam('B')];
    const field = phaseCompetitiveField(state, 'phase-playoff');
    expect(field.issues[0]).toMatch(/no committed competitive field/i);
    expect(generateDirectorRound(state).conflicts[0]?.message).toMatch(/no committed competitive field/i);
  });

  test('an existing bracket keeps its field and next slice after an unrelated team is added', () => {
    const state = baseState('single-elimination');
    state.phases[0]!.id = 'phase-playoff';
    state.phases[0]!.name = 'Championship';
    state.phases[0]!.order = 1;
    state.phases = [state.phases[0]!];
    state.formats[0]!.phaseIds = ['phase-playoff'];
    state.teams = ['A', 'B', 'C', 'D'].map(testTeam);

    const first = generateDirectorRound(state);
    expect(first.bracket).toBeDefined();
    expect(first.games.filter((game) => !game.bye)).toHaveLength(2);
    state.formats[0]!.bracket = first.bracket;
    state.rounds.push(first.round);
    state.phases[0]!.roundIds.push(first.round.id);
    state.scheduledGames.push(...first.games.map((game) => ({ ...game, status: 'accepted' as const })));
    for (const game of first.games.filter((entry) => !entry.bye && entry.rightTeamId)) {
      state.games.push(
        acceptedResult(
          `result-${game.id}`,
          game.id,
          game.roundId,
          game.leftTeamId,
          game.rightTeamId!,
          100,
          80,
        ),
      );
    }
    state.teams.push(testTeam('late-team'));

    const winner = first.games.find((game) => !game.bye)!.leftTeamId;
    const dependency = unresolvedBracketDependencyForTeam(state, winner);
    expect(dependency).toMatchObject({ bracketKey: expect.any(String) });

    const next = generateDirectorRound(state);
    expect(next.hardFailure).toBe(false);
    expect(next.bracket?.teamCount).toBe(4);
    expect(next.bracket?.seeding.map((entry) => entry.teamId)).toEqual(['A', 'B', 'C', 'D']);
    expect(next.games.filter((game) => !game.bye)).toHaveLength(1);
  });

  test('wildcard head-to-head includes pooled games and resolves the cutoff', () => {
    const state = baseState('round-robin', 'phase-prelim');
    state.formats[0]!.phaseIds = ['phase-prelim'];
    state.phases = [
      {
        id: 'phase-prelim',
        name: 'Prelim',
        kind: 'preliminary',
        order: 1,
        formatId: 'format-test',
        poolIds: ['pool-1', 'pool-2'],
        roundIds: ['round-prelim'],
        advancementRule: {
          qualifiersPerPool: 1,
          wildcards: 1,
          tiebreakers: ['points', 'head-to-head'],
          manualOverrideAllowed: true,
        },
        carryover: false,
        status: 'active',
      },
    ];
    state.teams = ['A', 'alpha', 'zulu', 'C', 'D'].map(testTeam);
    state.pools = [
      { id: 'pool-1', phaseId: 'phase-prelim', name: 'Pool 1', teamIds: ['A', 'alpha', 'zulu'], order: 1 },
      { id: 'pool-2', phaseId: 'phase-prelim', name: 'Pool 2', teamIds: ['C', 'D'], order: 2 },
    ];
    state.rounds = [
      {
        id: 'round-prelim',
        phaseId: 'phase-prelim',
        name: 'Prelim',
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
    ];
    const results = [
      ['A-alpha', 'A', 'alpha', 100, 50],
      ['A-zulu', 'A', 'zulu', 90, 40],
      ['zulu-alpha', 'zulu', 'alpha', 60, 50],
      ['C-D', 'C', 'D', 100, 0],
    ] as const;
    state.games = results.map(([id, left, right, leftScore, rightScore]) =>
      acceptedResult(id, `scheduled-${id}`, 'round-prelim', left, right, leftScore, rightScore),
    );
    state.scheduledGames = results.map(([id, left, right]) => ({
      id: `scheduled-${id}`,
      roundId: 'round-prelim',
      poolId: id === 'C-D' ? 'pool-2' : 'pool-1',
      roomId: null,
      packetId: null,
      leftTeamId: left,
      rightTeamId: right,
      bye: false,
      status: 'accepted' as const,
      assignmentRevision: 1,
    }));
    state.rounds[0]!.scheduledGameIds = state.scheduledGames.map((game) => game.id);

    const preview = previewAdvancement(state, state.phases[0]!);

    expect(preview.qualifiers.map((team) => team.id)).toContain('zulu');
    expect(preview.wildcards.map((team) => team.id)).toEqual(['zulu']);
    expect(preview.unresolved).toHaveLength(0);
  });
});
