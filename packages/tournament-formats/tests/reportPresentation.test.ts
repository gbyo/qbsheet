import { describe, expect, test } from 'vitest';
import {
  buildReportPresentation,
  pointsPerX,
  type ReportOptions,
  type ReportPresentationCapabilities,
  type ReportScoringDefinition,
} from '../src/reportPresentation';
import { buildExtendedStatReportBundle } from '../src/printableStatReport';
import type { StatsSnapshot } from '../src/stats';

const baseDefinition: ReportScoringDefinition = {
  tossupValue: 10,
  superpowerValue: 30,
  powerValue: 20,
  negValue: -5,
  useBonuses: false,
  tossupCount: 24,
  bouncebacks: false,
  lightning: false,
  overtime: false,
};

function presentation(
  definitions: ReportScoringDefinition[] = [baseDefinition],
  options?: ReportOptions,
  capabilities: ReportPresentationCapabilities = {
    packetRecorded: true,
    stageRecorded: true,
    lightningRecorded: false,
  },
) {
  return buildReportPresentation({
    metadata: {
      tournamentName: 'Rules & <Reports>',
      startDate: '2026-09-12',
      endDate: '2026-09-13',
      venue: 'Hall <A>',
      questionSet: 'Set & Stuff',
      organizer: 'A & B',
      scopeLabel: 'Overall',
      generatedAt: '2026-09-09T21:00:00.000Z',
    },
    definitions,
    ...(options ? { options } : {}),
    capabilities,
  });
}

function snapshot(): StatsSnapshot {
  const report = presentation();
  return {
    format: 'qbsheet-stats',
    version: 1,
    generatedAt: report.metadata.generatedAt,
    tournament: { id: 't', name: report.metadata.tournamentName },
    teams: [
      {
        rank: 1,
        teamId: 'a',
        teamName: 'A',
        gamesPlayed: 1,
        wins: 1,
        losses: 0,
        ties: 0,
        winPercentage: 1,
        pointsFor: 300,
        pointsAgainst: 100,
        ppg: 300,
        papg: 100,
        margin: 200,
        superpowers: 0,
        powers: 0,
        gets: 10,
        negs: 0,
        tossupsHeard: 24,
        tossupsHeardKnown: true,
        pptuh: 12.5,
        bonusPoints: 0,
        bonusesHeard: 0,
        ppb: null,
        answerCounts: { superpower: 0, power: 0, get: 10, neg: 0 },
        pointsPerX: 300,
      },
    ],
    players: [],
    games: [],
    extensions: { scopeLabel: 'Overall' },
    presentation: report,
  };
}

describe('rules-aware report presentation', () => {
  test('enabled answer tiers remain columns even when every recorded count is zero', () => {
    const report = presentation();
    expect(report.answerColumns.map((column) => column.key)).toEqual([
      'superpower',
      'power',
      'get',
      'neg',
    ]);
    expect(report.answerColumns.find((column) => column.key === 'superpower')?.pointValue).toBe(30);

    const standings = buildExtendedStatReportBundle(snapshot()).find(
      (page) => page.name === 'standings.html',
    )!.content;
    expect(standings).toContain('>Super (30)</th>');
    expect(standings).toContain('>Power (20)</th>');
    expect(standings).toContain('>Neg (-5)</th>');
    expect(standings).toContain('title="Superpower · 30 pts"');
  });

  test('standings keeps games played as a core competitive column', () => {
    const standings = buildExtendedStatReportBundle(snapshot()).find(
      (page) => page.name === 'standings.html',
    )!.content;
    expect(standings).toContain('<th scope="col" class="num">GP</th>');
  });

  test('tossup-only formats omit bonus columns rather than printing permanent zeroes', () => {
    const pages = buildExtendedStatReportBundle(snapshot());
    const standings = pages.find((page) => page.name === 'standings.html')!.content;
    const teams = pages.find((page) => page.name === 'teamdetail.html')!.content;
    expect(standings).not.toContain('>PPB</th>');
    expect(standings).not.toContain('>BH</th>');
    expect(teams).not.toContain('>Bonus pts</th>');
  });

  test('individual PPB appears only when a real player bonuses-heard denominator exists', () => {
    const snap = snapshot();
    snap.presentation = presentation([{ ...baseDefinition, useBonuses: true }]);
    snap.players = [
      {
        rank: 1,
        playerId: 'p',
        playerName: 'Player',
        teamId: 'a',
        teamName: 'A',
        gamesPlayed: 1,
        tossupsHeard: 24,
        superpowers: 0,
        powers: 0,
        gets: 10,
        negs: 0,
        points: 100,
        ppg: 100,
        pptuh: 100 / 24,
        bonusesHeard: 0,
        bonusPoints: 30,
        ppb: null,
        answerCounts: { superpower: 0, power: 0, get: 10, neg: 0 },
      },
    ];
    let individuals = buildExtendedStatReportBundle(snap).find(
      (page) => page.name === 'individuals.html',
    )!.content;
    expect(individuals).toContain('>Bonus pts</th>');
    expect(individuals).not.toContain('>PPB</th>');

    snap.players[0] = { ...snap.players[0], bonusesHeard: 2, ppb: 15 };
    individuals = buildExtendedStatReportBundle(snap).find(
      (page) => page.name === 'individuals.html',
    )!.content;
    expect(individuals).toContain('>PPB</th>');
  });

  test('bounceback and lightning applicability requires both configured rules and canonical recorded data', () => {
    const rules = [{ ...baseDefinition, useBonuses: true, bouncebacks: true, lightning: true }];
    const unavailable = presentation(rules);
    expect(unavailable.applicability.bouncebacks).toBe(false);
    expect(unavailable.applicability.lightning).toBe(false);

    const recorded = presentation(rules, undefined, {
      bouncebacksRecorded: true,
      lightningRecorded: true,
      packetRecorded: true,
      stageRecorded: true,
    });
    expect(recorded.applicability.bouncebacks).toBe(true);
    expect(recorded.applicability.lightning).toBe(true);
  });

  test('Round Report uses stage context and labels canonical bouncebacks as points', () => {
    const snap = snapshot();
    snap.presentation = presentation(
      [{ ...baseDefinition, useBonuses: true, bouncebacks: true }],
      undefined,
      { bouncebacksRecorded: true, packetRecorded: false, stageRecorded: true },
    );
    snap.games = [
      {
        gameId: 'g',
        phaseId: 'prelims',
        roundId: 'r1',
        roundName: 'Round 1',
        teamOneId: 'a',
        teamOneName: 'A',
        teamOnePoints: 300,
        teamTwoId: 'b',
        teamTwoName: 'B',
        teamTwoPoints: 100,
        winnerId: 'a',
        status: 'accepted',
        teamStats: [
          {
            teamId: 'a',
            teamName: 'A',
            points: 300,
            superpowers: 0,
            powers: 0,
            gets: 10,
            negs: 0,
            tossupsHeard: 24,
            bonusesHeard: 10,
            bonusPoints: 170,
            ppb: 17,
            bouncebacks: 30,
            answerCounts: { superpower: 0, power: 0, get: 10, neg: 0 },
          },
        ],
      },
    ];
    const rounds = buildExtendedStatReportBundle(snap).find(
      (page) => page.name === 'rounds.html',
    )!.content;
    expect(rounds).toContain('<th scope="col">Stage</th>');
    expect(rounds).toContain('prelims');
    expect(rounds).toContain('>Bounceback pts</th>');
    expect(rounds).toContain('<td class="num">30</td>');
  });

  test('mixed historical definitions keep semantic identities and decline incompatible normalization', () => {
    const report = presentation([
      { ...baseDefinition, id: 'old', powerValue: 15, tossupCount: 20 },
      { ...baseDefinition, id: 'new', powerValue: 20, tossupCount: 24 },
    ]);
    const power = report.answerColumns.find((column) => column.key === 'power')!;
    expect(power.pointValue).toBeNull();
    expect(power.pointValues).toEqual([20, 15]);
    expect(report.pointsNormalization).toBeNull();
    expect(report.mixedDefinitionNote).toContain('stable semantic category');

    const snap = snapshot();
    snap.presentation = report;
    const standings = buildExtendedStatReportBundle(snap).find(
      (page) => page.name === 'standings.html',
    )!.content;
    expect(standings).toContain('>Power (20/15)</th>');
    expect(standings).toContain('mixed values: 20, 15');
    expect(standings).toContain('Scoring definitions vary within this report.');
  });

  test('points-per-X uses the configured regulation count and refuses unknown denominators', () => {
    expect(pointsPerX(12.5, 24)).toBe(300);
    expect(pointsPerX(null, 24)).toBeNull();
    expect(pointsPerX(12.5, 0)).toBeNull();
  });

  test('page options filter the artifact and public metadata is escaped', () => {
    const snap = snapshot();
    snap.presentation = presentation([baseDefinition], {
      ...snap.presentation!.options,
      pages: ['standings', 'games'],
    });
    const pages = buildExtendedStatReportBundle(snap);
    expect(pages.map((page) => page.name).sort()).toEqual(['games.html', 'index.html', 'standings.html']);
    const standings = pages.find((page) => page.name === 'standings.html')!.content;
    expect(standings).toContain('Rules &amp; &lt;Reports&gt;');
    expect(standings).toContain('Site: Hall &lt;A&gt;');
    expect(standings).toContain('Question set: Set &amp; Stuff');
    expect(standings).toContain('September 12, 2026 – September 13, 2026');
    expect(standings).not.toContain('individuals.html');
  });
});
