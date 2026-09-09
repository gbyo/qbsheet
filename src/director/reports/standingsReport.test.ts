import { describe, expect, test } from 'vitest';
import { acceptedGame, playedTournament, scheduledGame, score, team } from '../../../tests/directorFixtures';
import { buildCanonicalStandingsReport } from './standingsReport';

const generatedAt = '2026-09-09T20:00:00.000Z';

describe('canonical standings report composition', () => {
  test('a simple single-stage tournament stays one standings section', () => {
    const report = buildCanonicalStandingsReport(playedTournament(), generatedAt);

    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]).toMatchObject({
      id: 'standings-overall',
      title: 'Standings',
      kind: 'cumulative',
    });
    expect(report.sections[0]!.snapshot.teams.map((row) => row.teamId)).toEqual(['team-a', 'team-b']);
  });

  test('multi-pool prelims and a later stage follow configured phase and pool order', () => {
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
    state.scheduledGames.push(scheduledGame('scheduled-pool-b', 'team-c', 'team-d', { poolId: 'pool-b' }));
    state.games.push(
      acceptedGame('game-pool-b', 'scheduled-pool-b', [score('team-c', 250), score('team-d', 200)]),
    );
    state.phases.push({
      id: 'phase-2',
      name: 'Playoffs',
      kind: 'playoff',
      order: 2,
      formatId: 'format-1',
      teamIds: ['team-a', 'team-c'],
      poolIds: [],
      roundIds: ['round-2'],
      advancementRule: null,
      carryover: false,
      status: 'active',
    });
    state.rounds.push({
      id: 'round-2',
      phaseId: 'phase-2',
      name: 'Round 2',
      number: 2,
      revision: 1,
      status: 'closed',
      packetId: null,
      scheduledGameIds: ['scheduled-playoff'],
      dayOrder: 2,
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
    });
    state.scheduledGames.push(
      scheduledGame('scheduled-playoff', 'team-a', 'team-c', {
        roundId: 'round-2',
        poolId: null,
      }),
    );
    const playoff = acceptedGame('game-playoff', 'scheduled-playoff', [
      score('team-a', 300),
      score('team-c', 220),
    ]);
    playoff.roundId = 'round-2';
    state.games.push(playoff);

    const report = buildCanonicalStandingsReport(state, generatedAt);

    expect(report.sections.map((section) => [section.kind, section.title])).toEqual([
      ['pool', 'Prelims · Pool A'],
      ['pool', 'Prelims · Pool B'],
      ['phase', 'Playoffs'],
      ['cumulative', 'All Games'],
    ]);
    expect(report.sections[0]!.snapshot.games.every((game) => game.poolId === 'pool-a')).toBe(true);
    expect(report.sections[1]!.snapshot.games.every((game) => game.poolId === 'pool-b')).toBe(true);
    expect(report.sections[2]!.snapshot.games.every((game) => game.phaseId === 'phase-2')).toBe(true);
  });

  test('explicit final placement stays distinct from calculated all-games standings', () => {
    const state = playedTournament();
    state.phases.push({
      id: 'phase-2',
      name: 'Finals',
      kind: 'final',
      order: 2,
      formatId: 'format-1',
      teamIds: ['team-a', 'team-b'],
      poolIds: [],
      roundIds: [],
      advancementRule: null,
      carryover: false,
      status: 'complete',
    });
    state.tournament!.finalPlacement = {
      order: ['team-b', 'team-a'],
      actor: 'Director',
      at: generatedAt,
      reason: 'Championship result.',
    };

    const report = buildCanonicalStandingsReport(state, generatedAt);
    const final = report.sections[0]!;
    const cumulative = report.sections.at(-1)!;

    expect(final).toMatchObject({ kind: 'final', title: 'Final Rankings' });
    expect(final.snapshot.teams.map((row) => row.teamId)).toEqual(['team-b', 'team-a']);
    expect(cumulative).toMatchObject({ kind: 'cumulative', title: 'All Games' });
    expect(cumulative.snapshot.teams.map((row) => row.teamId)).toEqual(['team-a', 'team-b']);
    expect(cumulative.snapshot.extensions?.finalPlacementApplied).toBe(false);
  });
});
