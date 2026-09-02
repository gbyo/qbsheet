import {
  deriveStandings,
  fingerprintResult,
  generateRoundRobinSchedule,
  makePlayerGameStat,
  makeTeamGameStat,
} from '../src';
import type { GameResult, ScheduledMatch } from '../src';
import { makeAcceptedResult, makeTeams, makeTeam, rules } from './helpers';

function gameBetween(games: readonly ScheduledMatch[], left: string, right: string): ScheduledMatch {
  const game = games.find(
    (candidate) =>
      (candidate.teamAId === left && candidate.teamBId === right) ||
      (candidate.teamAId === right && candidate.teamBId === left),
  );
  if (!game) throw new Error(`expected a game between ${left} and ${right}`);
  return game;
}

function resultForScores(game: ScheduledMatch, scores: Readonly<Record<string, number>>): GameResult {
  const result = makeAcceptedResult(game, scores[game.teamAId] ?? 0, scores[game.teamBId] ?? 0);
  const teamScores = [
    makeTeamGameStat({ teamId: game.teamAId, score: scores[game.teamAId] ?? 0, tossupsHeard: 20 }),
    makeTeamGameStat({ teamId: game.teamBId, score: scores[game.teamBId] ?? 0, tossupsHeard: 20 }),
  ];
  const payload = { ...result, teamScores };
  return { ...payload, fingerprint: fingerprintResult(payload) };
}

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

  it('uses only the tied teams’ head-to-head record, not unrelated wins', () => {
    const teams = makeTeams(4);
    const schedule = generateRoundRobinSchedule({ phaseId: 'phase-1', teams, seed: 'h2h-two-team' });
    const matches = schedule.games.filter((game): game is ScheduledMatch => game.kind !== 'bye');
    const results = [
      resultForScores(gameBetween(matches, 'team-1', 'team-2'), { 'team-1': 210, 'team-2': 180 }),
      resultForScores(gameBetween(matches, 'team-1', 'team-3'), { 'team-1': 150, 'team-3': 170 }),
      resultForScores(gameBetween(matches, 'team-1', 'team-4'), { 'team-1': 220, 'team-4': 190 }),
      resultForScores(gameBetween(matches, 'team-2', 'team-3'), { 'team-2': 205, 'team-3': 180 }),
      resultForScores(gameBetween(matches, 'team-2', 'team-4'), { 'team-2': 200, 'team-4': 190 }),
    ];
    const report = deriveStandings({
      teams,
      scheduledGames: schedule.games,
      acceptedResults: results,
      tiebreakers: ['wins', 'head-to-head'],
    });

    expect(report.rows.slice(0, 2).map((row) => row.teamId)).toEqual(['team-1', 'team-2']);
    expect(report.rows.slice(0, 2).every((row) => row.wins === 2)).toBe(true);
    expect(report.rows.slice(0, 2).every((row) => row.tieStatus === 'clear')).toBe(true);
  });

  it('uses a multi-team head-to-head mini-standings and leaves a circular tie unresolved', () => {
    const teams = makeTeams(3);
    const schedule = generateRoundRobinSchedule({ phaseId: 'phase-1', teams, seed: 'h2h-three-team' });
    const matches = schedule.games.filter((game): game is ScheduledMatch => game.kind !== 'bye');
    const results = [
      resultForScores(gameBetween(matches, 'team-1', 'team-2'), { 'team-1': 200, 'team-2': 150 }),
      resultForScores(gameBetween(matches, 'team-2', 'team-3'), { 'team-2': 200, 'team-3': 150 }),
      resultForScores(gameBetween(matches, 'team-3', 'team-1'), { 'team-3': 200, 'team-1': 150 }),
    ];
    const report = deriveStandings({
      teams,
      scheduledGames: schedule.games,
      acceptedResults: results,
      tiebreakers: ['wins', 'head-to-head'],
    });

    expect(report.rows.map((row) => row.rank)).toEqual([1, 1, 1]);
    expect(report.rows.every((row) => row.tieStatus === 'unresolved')).toBe(true);
    expect(report.unresolvedTies).toEqual([
      expect.objectContaining({ teamIds: expect.arrayContaining(['team-1', 'team-2', 'team-3']) }),
    ]);
  });

  it('preserves an accepted result against a dropped team while hiding that team when requested', () => {
    const active = makeTeam('team-1', { name: 'Active', status: 'active' });
    const dropped = makeTeam('team-2', { name: 'Dropped', status: 'dropped' });
    const other = makeTeam('team-3', { name: 'Other', status: 'active' });
    const teams = [active, dropped, other];
    const schedule = generateRoundRobinSchedule({ phaseId: 'phase-1', teams, seed: 'dropped-history' });
    const matches = schedule.games.filter((game): game is ScheduledMatch => game.kind !== 'bye');
    const historical = resultForScores(gameBetween(matches, 'team-1', 'team-2'), {
      'team-1': 210,
      'team-2': 180,
    });
    const current = resultForScores(gameBetween(matches, 'team-1', 'team-3'), {
      'team-1': 150,
      'team-3': 180,
    });
    const report = deriveStandings({
      teams,
      scheduledGames: schedule.games,
      acceptedResults: [historical, current],
      includeDroppedTeams: false,
      tiebreakers: ['wins'],
    });
    const activeRow = report.rows.find((row) => row.teamId === active.id);

    expect(report.rows.some((row) => row.teamId === dropped.id)).toBe(false);
    expect(activeRow).toMatchObject({ gamesPlayed: 2, wins: 1, losses: 1, pointsFor: 360 });
    expect(report.includedResultIds).toEqual(expect.arrayContaining([historical.id, current.id]));
  });

  it('restricts results to the requested phase and explicit game ids', () => {
    const teams = makeTeams(2);
    const prelim = generateRoundRobinSchedule({ phaseId: 'prelim', teams, seed: 'scope-prelim' });
    const playoff = generateRoundRobinSchedule({ phaseId: 'playoff', teams, seed: 'scope-playoff' });
    const prelimGame = prelim.games.find((game): game is ScheduledMatch => game.kind !== 'bye');
    const playoffGame = playoff.games.find((game): game is ScheduledMatch => game.kind !== 'bye');
    if (!prelimGame || !playoffGame) throw new Error('expected phase games');
    const prelimResult = makeAcceptedResult(prelimGame, 200, 150);
    const playoffResult = makeAcceptedResult(playoffGame, 20, 300);
    const report = deriveStandings({
      teams,
      scheduledGames: [...prelim.games, ...playoff.games],
      acceptedResults: [prelimResult, playoffResult],
      phaseId: 'prelim',
      gameIds: [prelimGame.id],
      tiebreakers: ['wins'],
    });

    expect(report.includedResultIds).toEqual([prelimResult.id]);
    expect(report.ignoredResultIds).toContain(playoffResult.id);
    expect(report.includedGameIds).toEqual([prelimGame.id]);
  });
});
