import { describe, expect, test } from 'vitest';
import { buildExtendedStatReportBundle } from '../src/printableStatReport';
import type { StatsSnapshot } from '../src/stats';

function team(
  rank: number,
  teamId: string,
  teamName: string,
): StatsSnapshot['teams'][number] {
  return {
    rank,
    teamId,
    teamName,
    gamesPlayed: 3,
    wins: rank === 1 ? 3 : 0,
    losses: rank === 1 ? 0 : 3,
    ties: 0,
    winPercentage: rank === 1 ? 1 : 0,
    pointsFor: rank === 1 ? 900 : 300,
    pointsAgainst: rank === 1 ? 300 : 900,
    ppg: rank === 1 ? 300 : 100,
    papg: rank === 1 ? 100 : 300,
    margin: rank === 1 ? 600 : -600,
    superpowers: 0,
    powers: 3,
    gets: 10,
    negs: 1,
    tossupsHeard: 60,
    tossupsHeardKnown: true,
    pptuh: rank === 1 ? 15 : 5,
    bonusPoints: rank === 1 ? 300 : 100,
    bonusesHeard: 12,
    ppb: rank === 1 ? 25 : 100 / 12,
  };
}

function snapshot(): StatsSnapshot {
  return {
    format: 'qbsheet-stats',
    version: 1,
    generatedAt: '2026-09-09T20:00:00.000Z',
    tournament: { id: 'tournament', name: 'Player Detail Test' },
    teams: [team(1, 'team-a', 'Aiken'), team(2, 'team-b', 'Wren')],
    players: [
      {
        rank: 1,
        playerId: 'player-a',
        playerName: 'Alice',
        teamId: 'team-a',
        teamName: 'Aiken',
        schoolYear: 12,
        gamesPlayed: 2,
        tossupsHeard: 20,
        superpowers: 0,
        powers: 2,
        gets: 3,
        negs: 1,
        points: 55,
        ppg: 27.5,
        pptuh: 2.75,
        bonusesHeard: 0,
        bonusPoints: 0,
        ppb: null,
      },
      {
        rank: 2,
        playerId: 'player-b',
        playerName: 'Bob',
        teamId: 'team-b',
        teamName: 'Wren',
        gamesPlayed: 1,
        tossupsHeard: 20,
        superpowers: 0,
        powers: 0,
        gets: 2,
        negs: 0,
        points: 20,
        ppg: 20,
        pptuh: 1,
        bonusesHeard: 0,
        bonusPoints: 0,
        ppb: null,
      },
    ],
    games: [
      {
        gameId: 'g1',
        phaseId: 'prelims',
        roundId: 'r1',
        roundName: 'Round 1',
        teamOneId: 'team-a',
        teamOneName: 'Aiken',
        teamOnePoints: 300,
        teamTwoId: 'team-b',
        teamTwoName: 'Wren',
        teamTwoPoints: 100,
        winnerId: 'team-a',
        status: 'accepted',
        detail: 'complete',
        playerStats: [
          {
            playerId: 'player-a',
            playerName: 'Alice',
            teamId: 'team-a',
            teamName: 'Aiken',
            tossupsHeard: 20,
            superpowers: 0,
            powers: 2,
            gets: 3,
            negs: 1,
            bonusPoints: 0,
            points: 55,
          },
          {
            playerId: 'player-b',
            playerName: 'Bob',
            teamId: 'team-b',
            teamName: 'Wren',
            tossupsHeard: 20,
            superpowers: 0,
            powers: 0,
            gets: 2,
            negs: 0,
            bonusPoints: 0,
            points: 20,
          },
        ],
      },
      {
        gameId: 'g2',
        phaseId: 'prelims',
        roundId: 'r2',
        roundName: 'Round 2',
        teamOneId: 'team-a',
        teamOneName: 'Aiken',
        teamOnePoints: 310,
        teamTwoId: 'team-b',
        teamTwoName: 'Wren',
        teamTwoPoints: 90,
        winnerId: 'team-a',
        status: 'accepted',
        detail: 'partial',
        playerStats: [],
      },
      {
        gameId: 'g3',
        phaseId: 'playoffs',
        roundId: 'r3',
        roundName: 'Round 3',
        teamOneId: 'team-a',
        teamOneName: 'Aiken',
        teamOnePoints: 0,
        teamTwoId: 'team-b',
        teamTwoName: 'Wren',
        teamTwoPoints: 0,
        status: 'forfeit',
        forfeitedTeamId: 'team-b',
        detail: 'complete',
        playerStats: [
          {
            playerId: 'player-a',
            playerName: 'Alice',
            teamId: 'team-a',
            teamName: 'Aiken',
            tossupsHeard: 0,
            superpowers: 0,
            powers: 0,
            gets: 0,
            negs: 0,
            bonusPoints: 0,
            points: 0,
          },
        ],
      },
    ],
    extensions: { scopeLabel: 'Overall' },
  };
}

function playerSection(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('</section>', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe('printable player detail', () => {
  test('lists only games with an actual canonical player line', () => {
    const page = buildExtendedStatReportBundle(snapshot()).find(
      (entry) => entry.name === 'playerdetail.html',
    )!.content;
    const alice = playerSection(page, 'player-1-player-a');

    expect(alice).toContain('Round 1');
    expect(alice).toContain('Round 3');
    expect(alice).not.toContain('Round 2');
    expect(alice).toContain('games.html#game-g1');
    expect(alice).toContain('games.html#game-g3');
    expect(alice).toContain('W (forfeit)');
    expect(alice).toContain('1 other team game is not listed');
  });

  test('keeps an explicit zero-TUH appearance distinct from absence', () => {
    const page = buildExtendedStatReportBundle(snapshot()).find(
      (entry) => entry.name === 'playerdetail.html',
    )!.content;
    const alice = playerSection(page, 'player-1-player-a');
    const roundThree = alice.slice(alice.indexOf('Round 3'));

    expect(roundThree).toContain('<td class="num">0</td>');
    expect(alice).not.toContain('Round 2');
  });

  test('shows multi-stage context and stable cross-report links', () => {
    const page = buildExtendedStatReportBundle(snapshot()).find(
      (entry) => entry.name === 'playerdetail.html',
    )!.content;
    const alice = playerSection(page, 'player-1-player-a');

    expect(alice).toContain('<th scope="col">Stage</th>');
    expect(alice).toContain('prelims');
    expect(alice).toContain('playoffs');
    expect(alice).toContain('teamdetail.html#team-2-team-b');
    expect(alice).toContain('Grade 12');
    expect(alice).toContain('55 pts');
    expect(alice).toContain('2.75 PPTUH');
  });
});
