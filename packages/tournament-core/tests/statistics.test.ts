import { deriveStandings, fingerprintResult, generateRoundRobinSchedule, makePlayerGameStat } from '../src';
import type { GameResult } from '../src';
import { makeAcceptedResult, makeTeams, rules } from './helpers';

describe('derived standings and statistics', () => {
  it('counts only accepted completed results and derives team aggregates', () => {
    const teams = makeTeams(4);
    const schedule = generateRoundRobinSchedule({ phaseId: 'phase-1', teams, seed: 'stats' });
    const matches = schedule.games.filter((game) => game.kind !== 'bye');
    if (!matches[0] || !matches[1]) throw new Error('expected matches');
    const accepted = makeAcceptedResult(matches[0], 220, 150);
    const second = makeAcceptedResult(matches[1], 100, 120);
    const pending = {
      ...makeAcceptedResult(matches[2] as (typeof matches)[2] & { kind: 'game' }, 400, 0),
      reviewStatus: 'pending' as const,
    };
    const report = deriveStandings({
      teams,
      scheduledGames: schedule.games,
      acceptedResults: [accepted, second, pending],
      tiebreakers: ['wins', 'point-differential', 'points-for', 'seed'],
      scoring: rules,
    });
    const first = report.rows.find((row) => row.teamId === matches[0].teamAId);
    const secondLoser = report.rows.find((row) => row.teamId === matches[0].teamBId);

    expect(first?.wins).toBe(1);
    expect(first?.pointsFor).toBe(220);
    expect(first?.pointsAgainst).toBe(150);
    expect(first?.margin).toBe(70);
    expect(secondLoser?.losses).toBe(1);
    expect(report.includedResultIds).toEqual(expect.arrayContaining([accepted.id, second.id]));
    expect(report.ignoredResultIds).toContain(pending.id);
  });

  it('derives player statistics with the configured scoring values', () => {
    const teams = makeTeams(2);
    const schedule = generateRoundRobinSchedule({ phaseId: 'phase-1', teams, seed: 'players' });
    const match = schedule.games.find((game) => game.kind !== 'bye');
    if (!match) throw new Error('expected a match');
    const result = makeAcceptedResult(match, 180, 120);
    const playerStat = makePlayerGameStat({
      playerId: 'player-1',
      teamId: match.teamAId,
      tossupsHeard: 4,
      powers: 1,
      gets: 2,
      negs: 1,
      bonusesHeard: 2,
      bonusPoints: 15,
      points: 40,
      bouncebacks: 1,
    });
    const corrected: GameResult = {
      ...result,
      playerStats: [playerStat],
      fingerprint: fingerprintResult({ ...result, playerStats: [playerStat] }),
    };
    const report = deriveStandings({
      teams,
      players: [
        {
          id: 'player-1',
          name: 'Alex',
          organizationId: null,
          teamId: match.teamAId,
          grade: null,
          captain: false,
          active: true,
          notes: '',
          createdAt: '',
          updatedAt: '',
        },
      ],
      scheduledGames: schedule.games,
      acceptedResults: [corrected],
      scoring: { tossupPoints: 10, powerPoints: 15, negPoints: -5 },
      tiebreakers: ['wins', 'seed'],
    });

    expect(report.playerRows[0]).toMatchObject({
      playerId: 'player-1',
      tossupsHeard: 4,
      powers: 1,
      gets: 2,
      negs: 1,
      tossupPoints: 30,
      points: 40,
      bonusPoints: 15,
      bouncebacks: 1,
    });
  });

  it('marks a truly unresolved standings tie instead of inventing an order', () => {
    const teams = makeTeams(2);
    const schedule = generateRoundRobinSchedule({ phaseId: 'phase-1', teams, seed: 'tie' });
    const report = deriveStandings({
      teams,
      scheduledGames: schedule.games,
      acceptedResults: [],
      tiebreakers: ['wins'],
    });

    expect(report.rows.map((row) => row.rank)).toEqual([1, 1]);
    expect(report.rows.every((row) => row.tieStatus === 'unresolved')).toBe(true);
    expect(report.unresolvedTies).toHaveLength(1);
    expect(report.unresolvedTies[0].teamIds).toHaveLength(2);
  });
});
