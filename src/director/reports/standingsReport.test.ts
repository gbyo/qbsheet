import { describe, expect, test } from 'vitest';
import type { DirectorState, Phase } from '../domain';
import { acceptedGame, playedTournament, scheduledGame, score, team } from '../../../tests/directorFixtures';
import { buildCanonicalStandingsReport } from './standingsReport';

const generatedAt = '2026-09-09T20:00:00.000Z';

function addPhase(
  state: DirectorState,
  id: string,
  name: string,
  order: number,
  overrides: Partial<Phase> = {},
): Phase {
  const phase: Phase = {
    id,
    name,
    kind: 'playoff',
    order,
    formatId: 'format-1',
    teamIds: [],
    poolIds: [],
    roundIds: [],
    advancementRule: null,
    carryover: false,
    status: 'active',
    ...overrides,
  };
  state.phases.push(phase);
  return phase;
}

function addRound(
  state: DirectorState,
  id: string,
  phaseId: string,
  name: string,
  number: number,
  dayOrder: number,
  packetId: string | null = null,
): void {
  state.rounds.push({
    id,
    phaseId,
    name,
    number,
    revision: 1,
    status: 'closed',
    packetId,
    scheduledGameIds: [],
    dayOrder,
    scheduledStart: null,
    releasedAt: null,
    startedAt: null,
    closedAt: generatedAt,
  });
  const phase = state.phases.find((entry) => entry.id === phaseId);
  if (phase && !phase.roundIds.includes(id)) phase.roundIds.push(id);
}

function addAcceptedGame(
  state: DirectorState,
  gameId: string,
  scheduledId: string,
  roundId: string,
  leftTeamId: string,
  rightTeamId: string,
  leftPoints: number,
  rightPoints: number,
  options: { poolId?: string | null; packetId?: string | null; bracketKey?: string } = {},
): void {
  const scheduled = scheduledGame(scheduledId, leftTeamId, rightTeamId, {
    roundId,
    poolId: options.poolId ?? null,
    packetId: options.packetId ?? null,
    ...(options.bracketKey ? { bracketKey: options.bracketKey } : {}),
  });
  state.scheduledGames.push(scheduled);
  const game = acceptedGame(gameId, scheduledId, [
    score(leftTeamId, leftPoints),
    score(rightTeamId, rightPoints),
  ]);
  game.roundId = roundId;
  game.packetId = options.packetId ?? null;
  state.games.push(game);
  const round = state.rounds.find((entry) => entry.id === roundId);
  if (round) round.scheduledGameIds.push(scheduledId);
}

function addPlayoffPhase(state: DirectorState, teamIds = ['team-a']): Phase {
  return addPhase(state, 'phase-2', 'Playoffs', 2, { teamIds });
}

function configureSourceAdvancement(state: DirectorState): void {
  const source = state.phases[0]!;
  source.name = 'Prelims';
  source.poolIds = ['pool-source'];
  source.advancementRule = {
    qualifiersPerPool: 1,
    wildcards: 0,
    tiebreakers: [...state.tournament!.rules.tiebreakers],
    manualOverrideAllowed: true,
  };
  state.pools.push({
    id: 'pool-source',
    phaseId: source.id,
    name: 'Prelim Pool',
    teamIds: ['team-a', 'team-b'],
    order: 1,
  });
  state.scheduledGames[0]!.poolId = 'pool-source';
}

describe('canonical standings report composition', () => {
  test('a simple single-stage tournament stays one rich standings section', () => {
    const state = playedTournament();
    state.teams[0]!.classifications = ['small-school'];
    const report = buildCanonicalStandingsReport(state, generatedAt);

    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]).toMatchObject({
      id: 'standings-overall',
      title: 'Standings',
      kind: 'cumulative',
      scopeLabel: 'Overall',
    });
    expect(report.sections[0]!.teams.map((row) => row.teamId)).toEqual(['team-a', 'team-b']);
    expect(report.sections[0]!.teams[0]).toMatchObject({
      classifications: ['Small School'],
      tossupsHeard: 20,
      tossupsHeardKnown: true,
      pptuh: 15,
    });
  });

  test('two prelim pools and playoffs follow configured order rather than array or lexical order', () => {
    const state = playedTournament();
    state.teams.push(team('team-c', 'Dorman'), team('team-d', 'Spartanburg'));
    state.phases[0]!.name = 'Prelims';
    state.phases[0]!.poolIds = ['pool-b', 'pool-a'];
    state.pools.push(
      {
        id: 'pool-b',
        phaseId: 'phase-1',
        name: 'Pool B',
        teamIds: ['team-c', 'team-d'],
        order: 2,
      },
      {
        id: 'pool-a',
        phaseId: 'phase-1',
        name: 'Pool A',
        teamIds: ['team-a', 'team-b'],
        order: 1,
      },
    );
    state.scheduledGames[0]!.poolId = 'pool-a';
    addAcceptedGame(state, 'game-pool-b', 'scheduled-pool-b', 'round-1', 'team-c', 'team-d', 250, 200, {
      poolId: 'pool-b',
    });
    const playoffs = addPhase(state, 'phase-zzz', 'Playoffs', 2, {
      teamIds: ['team-a', 'team-c'],
    });
    addRound(state, 'round-playoff', playoffs.id, 'Playoff Round', 99, 1);
    addAcceptedGame(
      state,
      'game-playoff',
      'scheduled-playoff',
      'round-playoff',
      'team-a',
      'team-c',
      300,
      220,
    );
    state.phases.reverse();
    state.pools.reverse();

    const report = buildCanonicalStandingsReport(state, generatedAt);

    expect(report.sections.map((section) => [section.kind, section.title])).toEqual([
      ['pool', 'Prelims · Pool A'],
      ['pool', 'Prelims · Pool B'],
      ['phase', 'Playoffs'],
      ['cumulative', 'All Games'],
    ]);
    expect(report.sections[0]!.teams.map((row) => row.teamId)).toEqual(['team-a', 'team-b']);
    expect(report.sections[1]!.teams.map((row) => row.teamId)).toEqual(['team-c', 'team-d']);
    expect(report.sections[2]!.teams.map((row) => row.teamId)).toEqual(['team-a', 'team-c']);
  });

  test('advancement is provisional until committed, then uses the actual target pool', () => {
    const state = playedTournament();
    configureSourceAdvancement(state);
    const target = addPlayoffPhase(state);
    target.poolIds = ['pool-championship'];
    target.teamIds = undefined;
    state.pools.push({
      id: 'pool-championship',
      phaseId: target.id,
      name: 'Championship Pool',
      teamIds: [],
      order: 1,
    });

    const previewReport = buildCanonicalStandingsReport(state, generatedAt);
    const prelim = previewReport.sections.find((section) => section.phaseId === 'phase-1')!;
    expect(prelim.advancement?.['team-a']).toEqual({ status: 'provisional', target: 'Playoffs' });
    expect(prelim.advancement?.['team-b']).toEqual({ status: 'eliminated' });

    state.pools.find((pool) => pool.id === 'pool-championship')!.teamIds = ['team-a'];
    state.audit.push({
      id: 'audit-advancement',
      at: generatedAt,
      actor: 'Director',
      type: 'advancement-committed',
      summary: 'Committed advancement.',
      entityId: target.id,
      details: {
        sourcePhaseId: 'phase-1',
        assignments: [{ teamId: 'team-a', targetPoolId: 'pool-championship' }],
      },
    });

    const committed = buildCanonicalStandingsReport(state, generatedAt);
    const committedPrelim = committed.sections.find((section) => section.phaseId === 'phase-1')!;
    expect(committedPrelim.advancement?.['team-a']).toEqual({
      status: 'committed',
      target: 'Playoffs · Championship Pool',
    });
    expect(committedPrelim.advancement?.['team-b']).toEqual({ status: 'eliminated' });
  });

  test('an unresolved cutoff is never printed as definite and preserves shared canonical rank', () => {
    const state = playedTournament();
    state.teams.push(team('team-c', 'Dorman'));
    state.tournament!.rules.tiebreakers = ['record', 'playoff'];
    configureSourceAdvancement(state);
    state.phases[0]!.advancementRule!.tiebreakers = ['record', 'playoff'];
    state.pools[0]!.teamIds.push('team-c');
    state.scheduledGames[0]!.poolId = 'pool-source';
    addAcceptedGame(state, 'game-b-c', 'scheduled-b-c', 'round-1', 'team-b', 'team-c', 100, 0, {
      poolId: 'pool-source',
    });
    addAcceptedGame(state, 'game-c-a', 'scheduled-c-a', 'round-1', 'team-c', 'team-a', 100, 0, {
      poolId: 'pool-source',
    });
    addPlayoffPhase(state, ['team-a']);

    const report = buildCanonicalStandingsReport(state, generatedAt);
    const prelim = report.sections.find((section) => section.phaseId === 'phase-1')!;

    expect(Object.values(prelim.advancement ?? {}).every((cell) => cell.status === 'unresolved')).toBe(true);
    expect(prelim.advancement?.['team-a']?.note).toMatch(/tie/i);
    expect(prelim.advancement?.['team-a']?.note).toMatch(/resolution is required/i);
    expect(report.displayRanks?.[`${prelim.id}:team-a`]).toBe(1);
    expect(report.displayRanks?.[`${prelim.id}:team-b`]).toBe(1);
    expect(report.displayRanks?.[`${prelim.id}:team-c`]).toBe(1);
  });

  test('tiebreaker games are explicit context and are not added to statistics a second time', () => {
    const state = playedTournament();
    addPlayoffPhase(state, ['team-a']);
    state.packets.push({
      id: 'packet-tb',
      name: 'Tiebreaker Packet',
      source: 'manual',
      assignedRoundIds: ['round-tb'],
      assignedGameIds: [],
      usedGameIds: [],
      replacementForPacketId: null,
      tiebreaker: true,
    });
    addRound(state, 'round-tb', 'phase-1', 'Tiebreaker', 2, 2, 'packet-tb');
    addAcceptedGame(state, 'game-tb', 'scheduled-tb', 'round-tb', 'team-a', 'team-b', 50, 40, {
      packetId: 'packet-tb',
    });

    const report = buildCanonicalStandingsReport(state, generatedAt);
    const prelim = report.sections.find((section) => section.phaseId === 'phase-1')!;
    const teamA = prelim.teams.find((row) => row.teamId === 'team-a')!;

    expect(prelim.contextGames).toEqual([
      expect.objectContaining({ gameId: 'game-tb', kind: 'tiebreaker', label: 'Tiebreaker Packet' }),
    ]);
    expect(teamA.gamesPlayed).toBe(2);
  });

  test('final placement, explicit finals and placement results, and calculated all-games order stay distinct', () => {
    const state = playedTournament();
    const finals = addPhase(state, 'phase-final', 'Finals', 2, {
      kind: 'final',
      teamIds: ['team-a', 'team-b'],
      status: 'complete',
    });
    addRound(state, 'round-final', finals.id, 'Championship Round', 2, 2);
    addAcceptedGame(state, 'game-final', 'scheduled-final', 'round-final', 'team-b', 'team-a', 250, 200);
    const placement = addPhase(state, 'phase-placement', 'Placement', 3, {
      kind: 'placement',
      teamIds: ['team-a', 'team-b'],
      status: 'complete',
    });
    addRound(state, 'round-placement', placement.id, 'Placement Round', 3, 3);
    addAcceptedGame(
      state,
      'game-placement',
      'scheduled-placement',
      'round-placement',
      'team-a',
      'team-b',
      100,
      0,
    );
    state.tournament!.finalPlacement = {
      order: ['team-b', 'team-a'],
      actor: 'Director',
      at: generatedAt,
      reason: 'Internal adjudication note that must not become report metadata.',
    };

    const report = buildCanonicalStandingsReport(state, generatedAt);
    const final = report.sections[0]!;
    const cumulative = report.sections.at(-1)!;

    expect(final).toMatchObject({ kind: 'final', title: 'Final Rankings' });
    expect(final.teams.map((row) => row.teamId)).toEqual(['team-b', 'team-a']);
    expect(final.contextGames).toEqual([
      expect.objectContaining({ gameId: 'game-final', kind: 'final', label: 'Finals' }),
      expect.objectContaining({ gameId: 'game-placement', kind: 'placement', label: 'Placement' }),
    ]);
    expect(cumulative).toMatchObject({ kind: 'cumulative', title: 'All Games' });
    expect(cumulative.teams.map((row) => row.teamId)).toEqual(['team-a', 'team-b']);
    expect(JSON.stringify(report)).not.toContain('Internal adjudication note');
  });

  test('carryover includes prior games between the later-stage field exactly once', () => {
    const state = playedTournament();
    const playoffs = addPhase(state, 'phase-2', 'Playoffs', 2, {
      teamIds: ['team-a', 'team-b'],
      carryover: true,
    });
    addRound(state, 'round-2', playoffs.id, 'Round 2', 2, 2);
    addAcceptedGame(state, 'game-2', 'scheduled-2', 'round-2', 'team-b', 'team-a', 250, 200);

    const report = buildCanonicalStandingsReport(state, generatedAt);
    const playoff = report.sections.find((section) => section.phaseId === 'phase-2')!;
    const cumulative = report.sections.at(-1)!;

    expect(playoff.carryover).toBe(true);
    expect(playoff.scopeLabel).toContain('including carryover');
    expect(playoff.teams.find((row) => row.teamId === 'team-a')?.gamesPlayed).toBe(2);
    expect(playoff.teams.find((row) => row.teamId === 'team-b')?.gamesPlayed).toBe(2);
    expect(cumulative.teams.find((row) => row.teamId === 'team-a')?.gamesPlayed).toBe(2);
  });
});
