import { describe, expect, test } from 'vitest';
import { buildExtendedStatReportBundle } from '../src/printableStatReport';
import { buildReportPresentation } from '../src/reportPresentation';
import type { StatsSnapshot } from '../src/stats';

function team(rank: number, teamId: string, teamName: string): StatsSnapshot['teams'][number] {
  return {
    rank,
    teamId,
    teamName,
    classifications: rank === 1 ? ['Small School'] : undefined,
    gamesPlayed: 3,
    wins: rank === 1 ? 3 : 0,
    losses: rank === 1 ? 0 : 3,
    ties: 0,
    winPercentage: rank === 1 ? 1 : 0,
    pointsFor: rank === 1 ? 700 : 260,
    pointsAgainst: rank === 1 ? 260 : 700,
    ppg: rank === 1 ? 700 / 3 : 260 / 3,
    papg: rank === 1 ? 260 / 3 : 700 / 3,
    margin: rank === 1 ? 440 : -440,
    superpowers: rank === 1 ? 1 : 0,
    powers: rank === 1 ? 4 : 1,
    gets: rank === 1 ? 8 : 5,
    negs: rank === 1 ? 1 : 2,
    tossupsHeard: 40,
    tossupsHeardKnown: false,
    pptuh: null,
    bonusPoints: rank === 1 ? 240 : 80,
    bonusesHeard: rank === 1 ? 10 : 6,
    ppb: rank === 1 ? 24 : 80 / 6,
  };
}

function snapshot(): StatsSnapshot {
  return {
    format: 'qbsheet-stats',
    version: 1,
    generatedAt: '2026-09-09T20:00:00.000Z',
    tournament: { id: 'tournament', name: 'Team Detail Test' },
    teams: [team(1, 'team-a', 'Aiken & Sons'), team(2, 'team-b', 'Wren')],
    players: [
      {
        rank: 1,
        playerId: 'alice',
        playerName: 'Alice',
        teamId: 'team-a',
        teamName: 'Aiken & Sons',
        schoolYear: 12,
        gamesPlayed: 2,
        tossupsHeard: 40,
        superpowers: 1,
        powers: 3,
        gets: 5,
        negs: 1,
        points: 120,
        ppg: 60,
        pptuh: 3,
        bonusesHeard: 0,
        bonusPoints: 0,
        ppb: null,
      },
      {
        rank: 2,
        playerId: 'bob',
        playerName: 'Bob',
        teamId: 'team-b',
        teamName: 'Wren',
        gamesPlayed: 2,
        tossupsHeard: 40,
        superpowers: 0,
        powers: 1,
        gets: 5,
        negs: 2,
        points: 55,
        ppg: 27.5,
        pptuh: 1.375,
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
        packetName: 'Packet <One>',
        teamOneId: 'team-a',
        teamOneName: 'Aiken & Sons',
        teamOnePoints: 400,
        teamTwoId: 'team-b',
        teamTwoName: 'Wren',
        teamTwoPoints: 160,
        winnerId: 'team-a',
        status: 'accepted',
        detail: 'complete',
        teamStats: [
          {
            teamId: 'team-a',
            teamName: 'Aiken & Sons',
            points: 400,
            superpowers: 1,
            powers: 3,
            gets: 5,
            negs: 1,
            tossupsHeard: 20,
            bonusesHeard: 8,
            bonusPoints: 200,
            ppb: 25,
            bouncebacks: 0,
          },
          {
            teamId: 'team-b',
            teamName: 'Wren',
            points: 160,
            superpowers: 0,
            powers: 1,
            gets: 3,
            negs: 1,
            tossupsHeard: 20,
            bonusesHeard: 4,
            bonusPoints: 60,
            ppb: 15,
            bouncebacks: 0,
          },
        ],
      },
      {
        gameId: 'g2',
        phaseId: 'prelims',
        roundId: 'r2',
        roundName: 'Round 2',
        packetName: 'Packet Two',
        teamOneId: 'team-a',
        teamOneName: 'Aiken & Sons',
        teamOnePoints: 300,
        teamTwoId: 'team-b',
        teamTwoName: 'Wren',
        teamTwoPoints: 100,
        winnerId: 'team-a',
        status: 'accepted',
        detail: 'partial',
      },
      {
        gameId: 'g3',
        phaseId: 'playoffs',
        roundId: 'r3',
        roundName: 'Round 3',
        teamOneId: 'team-a',
        teamOneName: 'Aiken & Sons',
        teamOnePoints: 0,
        teamTwoId: 'team-b',
        teamTwoName: 'Wren',
        teamTwoPoints: 0,
        status: 'forfeit',
        forfeitedTeamId: 'team-b',
        detail: 'complete',
        teamStats: [
          {
            teamId: 'team-a',
            teamName: 'Aiken & Sons',
            points: 0,
            superpowers: null,
            powers: null,
            gets: null,
            negs: null,
            tossupsHeard: null,
            bonusesHeard: null,
            bonusPoints: null,
            ppb: null,
            bouncebacks: null,
          },
          {
            teamId: 'team-b',
            teamName: 'Wren',
            points: 0,
            superpowers: null,
            powers: null,
            gets: null,
            negs: null,
            tossupsHeard: null,
            bonusesHeard: null,
            bonusPoints: null,
            ppb: null,
            bouncebacks: null,
          },
        ],
      },
    ],
    extensions: { scopeLabel: 'Overall' },
  };
}

function sectionFor(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('<section id="team-', start + 1);
  return html.slice(start, next === -1 ? html.length : next);
}

describe('printable team detail', () => {
  test('renders one chronological row for every accepted team game', () => {
    const page = buildExtendedStatReportBundle(snapshot()).find(
      (entry) => entry.name === 'teamdetail.html',
    )!.content;
    const aiken = sectionFor(page, 'team-team-a');

    expect(aiken.indexOf('Round 1')).toBeLessThan(aiken.indexOf('Round 2'));
    expect(aiken.indexOf('Round 2')).toBeLessThan(aiken.indexOf('Round 3'));
    expect(aiken).toContain('games.html#game-g1');
    expect(aiken).toContain('games.html#game-g2');
    expect(aiken).toContain('games.html#game-g3');
    expect(aiken).toContain('W (forfeit)');
  });

  test('keeps score-only and forfeit detail unknown instead of fabricating zeroes', () => {
    const page = buildExtendedStatReportBundle(snapshot()).find(
      (entry) => entry.name === 'teamdetail.html',
    )!.content;
    const aiken = sectionFor(page, 'team-team-a');
    const roundTwo = aiken.slice(aiken.indexOf('Round 2'), aiken.indexOf('Round 3'));

    expect(roundTwo).toContain('300–100');
    expect(roundTwo).toContain('>—</td>');
    expect(aiken).toContain('0–0');
  });

  test('shows cumulative reconciliation, packet context, classifications, and roster links', () => {
    const page = buildExtendedStatReportBundle(snapshot()).find(
      (entry) => entry.name === 'teamdetail.html',
    )!.content;
    const aiken = sectionFor(page, 'team-team-a');

    expect(aiken).toContain('Tournament total');
    expect(aiken).toContain('PF 700');
    expect(aiken).toContain('24.00');
    expect(aiken).toContain('Packet &lt;One&gt;');
    expect(aiken).toContain('Classifications: Small School');
    expect(aiken).toContain('playerdetail.html#player-alice');
    expect(aiken).toContain('teamdetail.html#team-team-b');
    expect(aiken).toContain('<th scope="col">Stage</th>');
  });
});

function paritySnapshot(): StatsSnapshot {
  return {
    format: 'qbsheet-stats',
    version: 1,
    generatedAt: '2026-09-09T20:00:00.000Z',
    tournament: { id: 'tournament', name: 'Parity Detail Test' },
    presentation: buildReportPresentation({
      metadata: {
        tournamentName: 'Parity Detail Test',
        scopeLabel: 'Overall',
        generatedAt: '2026-09-09T20:00:00.000Z',
      },
      definitions: [
        {
          tossupValue: 10,
          superpowerValue: null,
          powerValue: 15,
          negValue: -5,
          useBonuses: true,
          tossupCount: 20,
          bouncebacks: true,
          lightning: true,
          overtime: false,
        },
      ],
      capabilities: { bouncebacksRecorded: true, lightningRecorded: true },
    }),
    teams: [
      {
        rank: 1,
        teamId: 'team-a',
        teamName: 'Aiken',
        gamesPlayed: 1,
        wins: 1,
        losses: 0,
        ties: 0,
        winPercentage: 1,
        pointsFor: 400,
        pointsAgainst: 160,
        ppg: 400,
        papg: 160,
        margin: 240,
        superpowers: 0,
        powers: 3,
        gets: 5,
        negs: 1,
        tossupsHeard: 20,
        tossupsHeardKnown: true,
        pptuh: 20,
        bonusPoints: 200,
        bonusesHeard: 8,
        ppb: 25,
        bouncebackPoints: 30,
        bouncebacksKnown: true,
        bouncebackPartsHeard: 6,
        bouncebackPartsConverted: 3,
        bouncebackConversion: 0.5,
        totalBonusConversion: 0.7,
        lightningPoints: 40,
        lightningKnown: true,
      },
      {
        rank: 2,
        teamId: 'team-b',
        teamName: 'Wren',
        gamesPlayed: 1,
        wins: 0,
        losses: 1,
        ties: 0,
        winPercentage: 0,
        pointsFor: 160,
        pointsAgainst: 400,
        ppg: 160,
        papg: 400,
        margin: -240,
        superpowers: 0,
        powers: 1,
        gets: 3,
        negs: 1,
        tossupsHeard: 20,
        tossupsHeardKnown: true,
        pptuh: 8,
        bonusPoints: 60,
        bonusesHeard: 4,
        ppb: 15,
        bouncebackPoints: 0,
        bouncebacksKnown: false,
        bouncebackPartsHeard: null,
        bouncebackPartsConverted: null,
        bouncebackConversion: null,
        totalBonusConversion: null,
        lightningPoints: null,
        lightningKnown: false,
      },
    ],
    players: [],
    games: [
      {
        gameId: 'g1',
        phaseId: 'prelims',
        roundId: 'r1',
        roundName: 'Round 1',
        teamOneId: 'team-a',
        teamOneName: 'Aiken',
        teamOnePoints: 400,
        teamTwoId: 'team-b',
        teamTwoName: 'Wren',
        teamTwoPoints: 160,
        winnerId: 'team-a',
        status: 'accepted',
        detail: 'complete',
        teamStats: [
          {
            teamId: 'team-a',
            teamName: 'Aiken',
            points: 400,
            superpowers: 0,
            powers: 3,
            gets: 5,
            negs: 1,
            tossupsHeard: 20,
            bonusesHeard: 8,
            bonusPoints: 200,
            ppb: 25,
            bouncebacks: 30,
            lightningPoints: 40,
            bouncebackPartsHeard: 6,
            bouncebackPartsConverted: 3,
            bonusPartsConverted: 20,
            bonusPartsHeard: 24,
          },
          {
            teamId: 'team-b',
            teamName: 'Wren',
            points: 160,
            superpowers: 0,
            powers: 1,
            gets: 3,
            negs: 1,
            tossupsHeard: 20,
            bonusesHeard: 4,
            bonusPoints: 60,
            ppb: 15,
            bouncebacks: null,
            lightningPoints: null,
            bouncebackPartsHeard: null,
            bouncebackPartsConverted: null,
            bonusPartsConverted: null,
            bonusPartsHeard: null,
          },
        ],
      },
    ],
    extensions: { scopeLabel: 'Overall' },
  };
}

function parityPage(): string {
  return buildExtendedStatReportBundle(paritySnapshot()).find((entry) => entry.name === 'teamdetail.html')!
    .content;
}

describe('printable team detail parity (#751)', () => {
  test('renders bounceback-parts and lightning columns with per-game conversion', () => {
    const aiken = sectionFor(parityPage(), 'team-team-a');

    expect(aiken).toContain('<th scope="col" class="num">BB parts heard</th>');
    expect(aiken).toContain('<th scope="col" class="num">BB conv %</th>');
    expect(aiken).toContain('<th scope="col" class="num">Lightning pts</th>');
    // 3 converted of 6 heard in the game row, from the row's own parts.
    expect(aiken).toContain('<td class="num">50.0%</td>');
    expect(aiken).toContain('<td class="num">40</td>');
  });

  test('totals come from the canonical aggregates, never re-summed from rows', () => {
    const aiken = sectionFor(parityPage(), 'team-team-a');
    const foot = aiken.slice(aiken.indexOf('<tfoot>'));

    expect(aiken).toContain('30 BB pts');
    expect(aiken).toContain('50.0% BB conv');
    expect(aiken).toContain('40 lightning pts');
    expect(foot).toContain('<td class="num">30</td>');
  });

  test('unknown aggregates render as unknown, never zero', () => {
    const wren = sectionFor(parityPage(), 'team-team-b');

    expect(wren).toContain('BB pts —');
    expect(wren).toContain('Lightning —');
  });
});
