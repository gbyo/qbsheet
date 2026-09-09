import { describe, expect, test } from 'vitest';
import { buildPrintableStatReportBundle } from '../src/boxScoreReport';
import type { StatsSnapshot } from '../src/stats';
import type { GamePlayerStatsRow, GameTeamStatsRow } from '../src/reportDetail';

const teamRows: StatsSnapshot['teams'] = [
  {
    rank: 1,
    teamId: 'team-a',
    teamName: 'Aiken <A>',
    gamesPlayed: 2,
    wins: 2,
    losses: 0,
    ties: 0,
    winPercentage: 1,
    pointsFor: 700,
    pointsAgainst: 300,
    ppg: 350,
    papg: 150,
    margin: 400,
    superpowers: 1,
    powers: 4,
    gets: 10,
    negs: 1,
    tossupsHeard: 40,
    tossupsHeardKnown: true,
    pptuh: 17.5,
    bonusPoints: 360,
    bonusesHeard: 14,
    ppb: 360 / 14,
  },
  {
    rank: 2,
    teamId: 'team-b',
    teamName: 'Wren',
    gamesPlayed: 2,
    wins: 0,
    losses: 2,
    ties: 0,
    winPercentage: 0,
    pointsFor: 300,
    pointsAgainst: 700,
    ppg: 150,
    papg: 350,
    margin: -400,
    superpowers: 0,
    powers: 1,
    gets: 7,
    negs: 2,
    tossupsHeard: 40,
    tossupsHeardKnown: true,
    pptuh: 7.5,
    bonusPoints: 120,
    bonusesHeard: 8,
    ppb: 15,
  },
];

const playerRows: StatsSnapshot['players'] = [
  {
    rank: 1,
    playerId: 'player-a',
    playerName: 'Alice & Co.',
    teamId: 'team-a',
    teamName: 'Aiken <A>',
    gamesPlayed: 1,
    tossupsHeard: 20,
    superpowers: 1,
    powers: 2,
    gets: 5,
    negs: 0,
    points: 95,
    ppg: 95,
    pptuh: 4.75,
    bonusesHeard: 0,
    bonusPoints: 0,
    ppb: null,
  },
  {
    rank: 2,
    playerId: 'bench-a',
    playerName: 'Bench Player',
    teamId: 'team-a',
    teamName: 'Aiken <A>',
    gamesPlayed: 1,
    tossupsHeard: 20,
    superpowers: 0,
    powers: 0,
    gets: 1,
    negs: 0,
    points: 10,
    ppg: 10,
    pptuh: 0.5,
    bonusesHeard: 0,
    bonusPoints: 0,
    ppb: null,
  },
  {
    rank: 3,
    playerId: 'player-b',
    playerName: 'Bob',
    teamId: 'team-b',
    teamName: 'Wren',
    gamesPlayed: 1,
    tossupsHeard: 20,
    superpowers: 0,
    powers: 1,
    gets: 3,
    negs: 1,
    points: 40,
    ppg: 40,
    pptuh: 2,
    bonusesHeard: 0,
    bonusPoints: 0,
    ppb: null,
  },
];

function detailedTeam(
  overrides: Partial<GameTeamStatsRow> & Pick<GameTeamStatsRow, 'teamId' | 'teamName' | 'points'>,
): GameTeamStatsRow {
  return {
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    tossupsHeard: 20,
    bonusesHeard: 0,
    bonusPoints: 0,
    ppb: null,
    bouncebacks: 0,
    ...overrides,
  };
}

function detailedPlayer(
  overrides: Partial<GamePlayerStatsRow> &
    Pick<GamePlayerStatsRow, 'playerId' | 'playerName' | 'teamId' | 'teamName'>,
): GamePlayerStatsRow {
  return {
    tossupsHeard: 20,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonusPoints: 0,
    points: 0,
    ...overrides,
  };
}

function snapshot(): StatsSnapshot {
  return {
    format: 'qbsheet-stats',
    version: 1,
    generatedAt: '2026-09-09T20:00:00.000Z',
    tournament: { id: 'tournament', name: 'Cavalier Classic' },
    teams: teamRows,
    players: playerRows,
    games: [
      {
        gameId: 'game/one',
        phaseId: 'phase-1',
        roundId: 'round-1',
        roundName: 'Round 1',
        packetId: 'packet-1',
        packetName: 'Packet <A>',
        teamOneId: 'team-a',
        teamOneName: 'Aiken <A>',
        teamOnePoints: 400,
        teamTwoId: 'team-b',
        teamTwoName: 'Wren',
        teamTwoPoints: 160,
        winnerId: 'team-a',
        status: 'accepted',
        detail: 'complete',
        tossupsRead: 20,
        overtimeTossupsRead: 0,
        teamStats: [
          detailedTeam({
            teamId: 'team-a',
            teamName: 'Aiken <A>',
            points: 400,
            superpowers: 1,
            powers: 2,
            gets: 5,
            bonusesHeard: 8,
            bonusPoints: 160,
            ppb: 20,
          }),
          detailedTeam({
            teamId: 'team-b',
            teamName: 'Wren',
            points: 160,
            powers: 1,
            gets: 3,
            negs: 1,
            bonusesHeard: 4,
            bonusPoints: 60,
            ppb: 15,
          }),
        ],
        playerStats: [
          detailedPlayer({
            playerId: 'player-a',
            playerName: 'Alice & Co.',
            teamId: 'team-a',
            teamName: 'Aiken <A>',
            superpowers: 1,
            powers: 2,
            gets: 5,
            points: 95,
          }),
          detailedPlayer({
            playerId: 'player-b',
            playerName: 'Bob',
            teamId: 'team-b',
            teamName: 'Wren',
            powers: 1,
            gets: 3,
            negs: 1,
            points: 40,
          }),
        ],
      },
      {
        gameId: 'game-two',
        phaseId: 'phase-1',
        roundId: 'round-2',
        roundName: 'Round 2',
        teamOneId: 'team-a',
        teamOneName: 'Aiken <A>',
        teamOnePoints: 300,
        teamTwoId: 'team-b',
        teamTwoName: 'Wren',
        teamTwoPoints: 140,
        winnerId: 'team-a',
        status: 'accepted',
        detail: 'partial',
        tossupsRead: null,
        overtimeTossupsRead: null,
      },
    ],
    extensions: { scopeLabel: 'Overall' },
  };
}

describe('printable game box scores', () => {
  test('replaces games.html with detailed, anchored box scores', () => {
    const pages = buildPrintableStatReportBundle(snapshot());
    expect(pages).toHaveLength(7);
    const games = pages.find((page) => page.name === 'games.html')!.content;

    expect(games).toContain('id="game-game-one"');
    expect(games).toContain('id="game-game-two"');
    expect(games).toContain('href="#round-round-1"');
    expect(games).toContain('Packet: Packet &lt;A&gt;');
    expect(games).toContain('Tossups read: 20');
    expect(games).toContain('Alice &amp; Co.');
    expect(games).toContain('Team total');
    expect(games).toContain('Bonuses heard: <strong>8</strong>');
    expect(games).toContain('PPB: <strong>20.00</strong>');
    expect(games).toContain('Detailed statistics unavailable for this result.');
  });

  test('does not turn roster membership into a player appearance', () => {
    const games = buildPrintableStatReportBundle(snapshot()).find((page) => page.name === 'games.html')!.content;
    expect(games).not.toContain('Bench Player');
  });

  test('escapes names while keeping the rest of the report bundle intact', () => {
    const pages = buildPrintableStatReportBundle(snapshot());
    const games = pages.find((page) => page.name === 'games.html')!.content;
    expect(games).toContain('Aiken &lt;A&gt;');
    expect(games).not.toContain('Aiken <A>');
    expect(pages.map((page) => page.name).sort()).toEqual(
      [
        'games.html',
        'index.html',
        'individuals.html',
        'playerdetail.html',
        'rounds.html',
        'standings.html',
        'teamdetail.html',
      ].sort(),
    );
  });
});
