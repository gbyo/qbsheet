import { describe, expect, test } from 'vitest';
import {
  addGameRowAnchors,
  renderStageAwareStandingsReport,
  standingsGameAnchor,
  type CanonicalStandingsReport,
  type TeamStatsRow,
} from '../src';

function teamRow(rank: number, teamId: string, teamName: string): TeamStatsRow {
  return {
    rank,
    teamId,
    teamName,
    classifications: rank === 1 ? ['Small School'] : [],
    gamesPlayed: 1,
    wins: rank === 1 ? 1 : 0,
    losses: rank === 1 ? 0 : 1,
    ties: 0,
    winPercentage: rank === 1 ? 1 : 0,
    pointsFor: rank === 1 ? 300 : 200,
    pointsAgainst: rank === 1 ? 200 : 300,
    ppg: rank === 1 ? 300 : 200,
    papg: rank === 1 ? 200 : 300,
    margin: rank === 1 ? 100 : -100,
    superpowers: 0,
    powers: rank === 1 ? 4 : 2,
    gets: rank === 1 ? 8 : 7,
    negs: rank === 1 ? 1 : 2,
    tossupsHeard: 20,
    tossupsHeardKnown: true,
    pptuh: rank === 1 ? 15 : 10,
    bonusPoints: rank === 1 ? 130 : 90,
    bonusesHeard: rank === 1 ? 12 : 9,
    ppb: rank === 1 ? 130 / 12 : 10,
  };
}

function report(): CanonicalStandingsReport {
  return {
    tournament: { id: 'tournament', name: 'Cavalier <Classic>' },
    generatedAt: '2026-09-09T20:00:00.000Z',
    teamDetailRanks: { 'team-a': 1, 'team-b': 2 },
    displayRanks: {
      'standings-prelims:team-a': 1,
      'standings-prelims:team-b': 1,
    },
    sections: [
      {
        id: 'standings-prelims',
        title: 'Prelims',
        kind: 'phase',
        scopeLabel: 'Prelims',
        teams: [teamRow(1, 'team-a', 'Aiken'), teamRow(2, 'team-b', 'Wren')],
        advancement: {
          'team-a': { status: 'provisional', target: 'Playoffs' },
          'team-b': { status: 'unresolved', note: 'Tie at the advancement cutoff.' },
        },
        contextGames: [
          {
            gameId: 'tb/1',
            kind: 'tiebreaker',
            label: 'Tiebreaker Packet',
            roundName: 'Tiebreaker',
            teamOneName: 'Aiken',
            teamOnePoints: 50,
            teamTwoName: 'Wren',
            teamTwoPoints: 40,
          },
        ],
      },
      {
        id: 'standings-final',
        title: 'Final Rankings',
        kind: 'final',
        scopeLabel: 'Final Rankings',
        teams: [teamRow(1, 'team-b', 'Wren'), teamRow(2, 'team-a', 'Aiken')],
        contextGames: [
          {
            gameId: 'championship/1',
            kind: 'final',
            label: 'Championship',
            roundName: 'Round 10',
            teamOneName: 'Wren',
            teamOnePoints: 280,
            teamTwoName: 'Aiken',
            teamTwoPoints: 260,
          },
        ],
      },
    ],
  };
}

describe('stage-aware standings report HTML', () => {
  test('renders canonical sections, shared ranks, rich columns, advancement, and exact game links', () => {
    const html = renderStageAwareStandingsReport(report());

    expect(html).toContain('Cavalier &lt;Classic&gt;');
    expect(html).toContain('href="#standings-prelims"');
    expect(html).toContain('<th scope="col" class="num">TUH</th>');
    expect(html).toContain('<th scope="col" class="num">PPTUH</th>');
    expect(html).toContain('Small School');
    expect(html).toContain('Would advance to Playoffs');
    expect(html).toContain('Unresolved — Tie at the advancement cutoff.');
    expect(html).toContain('href="teamdetail.html#team-1-team-a"');
    expect(html).toContain('Finals &amp; placement results');
    expect(html).toContain('Tiebreaker results');
    expect(html).toContain(`games.html#${standingsGameAnchor('championship/1')}`);
    expect(html).toContain(`games.html#${standingsGameAnchor('tb/1')}`);
    expect(html).not.toContain('Tiebreaker results</h3><ul><li><strong>Championship');

    const sharedRankCells = html.match(/<td class="num">1<\/td>/g) ?? [];
    expect(sharedRankCells.length).toBeGreaterThanOrEqual(2);
  });

  test('adds one stable anchor to each legacy games-table row', () => {
    const page = '<html><body><table><tbody><tr><td>one</td></tr><tr><td>two</td></tr></tbody></table></body></html>';
    const anchored = addGameRowAnchors(page, [
      {
        gameId: 'game/one',
        teamOneId: 'a',
        teamOneName: 'A',
        teamTwoId: 'b',
        teamTwoName: 'B',
        status: 'accepted',
      },
      {
        gameId: 'game two',
        teamOneId: 'c',
        teamOneName: 'C',
        teamTwoId: 'd',
        teamTwoName: 'D',
        status: 'accepted',
      },
    ]);

    expect(anchored).toContain('id="game-game-one"');
    expect(anchored).toContain('id="game-game-two"');
  });
});
