/**
 * Scenario I (incomplete stats stay honest), Scenario J (final placement
 * feeds reports), and Scenario M (static bundle structure and links).
 *
 * Every assertion runs against the canonical adapter, so passing here means
 * Director tables, CSV, and HTML agree by construction.
 */

import { describe, expect, test } from 'vitest';
import { defaultRules, emptyDirectorState, type DirectorState } from '../domain';
import {
  buildStatReportBundle,
  exportGameResultsCsv,
  exportPlayerStatsCsv,
  exportTeamStandingsCsv,
} from '@qbsheet/tournament-formats';
import { buildCanonicalSnapshot } from './canonicalReports';

function reportState(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-reports',
    name: 'Saturday Event',
    date: '2026-09-05',
    venue: '',
    organizer: '',
    status: 'running',
    timeZone: 'America/New_York',
    rules: structuredClone(defaultRules),
    formatId: null,
    currentPhaseId: null,
    currentPacketId: null,
    currentRoundId: null,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
  };
  state.teams = [
    {
      id: 'team-a',
      organizationId: null,
      displayName: '<Aiken> & Co.',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      classifications: ['small-school'],
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:00:00.000Z',
    },
    {
      id: 'team-b',
      organizationId: null,
      displayName: 'Wren',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:00:00.000Z',
    },
  ];
  state.players = [
    { id: 'player-a1', teamId: 'team-a', name: 'A. Player', captain: true, active: true },
    { id: 'player-b1', teamId: 'team-b', name: 'B. Player', captain: true, active: true },
  ];
  state.rounds = [
    {
      id: 'round-1',
      phaseId: 'phase-1',
      name: 'Round 1',
      number: 1,
      revision: 1,
      status: 'closed',
      packetId: null,
      scheduledGameIds: [],
      dayOrder: 0,
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
    },
    {
      id: 'round-2',
      phaseId: 'phase-1',
      name: 'Round 2',
      number: 2,
      revision: 1,
      status: 'closed',
      packetId: null,
      scheduledGameIds: [],
      dayOrder: 1,
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
    },
  ];
  const teamScore = (teamId: string, score: number) => ({
    teamId,
    score,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonuses: 0,
    bonusPoints: 0,
    bouncebacks: 0,
  });
  state.games = [
    {
      id: 'game-1',
      scheduledGameId: 'scheduled-1',
      roundId: 'round-1',
      packetId: null,
      status: 'accepted',
      scores: [teamScore('team-a', 320), teamScore('team-b', 110)],
      playerStats: [
        {
          playerId: 'player-a1',
          teamId: 'team-a',
          superpowers: 0,
          powers: 2,
          gets: 5,
          negs: 1,
          bonusPoints: 60,
          tossupsHeard: 20,
        },
      ],
      source: 'manual',
      detailedStats: 'complete',
    },
    // Score-only paper result: no tossups-heard, no player lines at all.
    {
      id: 'game-2',
      scheduledGameId: 'scheduled-2',
      roundId: 'round-2',
      packetId: null,
      status: 'accepted',
      scores: [teamScore('team-b', 200), teamScore('team-a', 150)],
      playerStats: [],
      source: 'paper',
      detailedStats: 'unknown',
    },
  ];
  return state;
}

const generatedAt = '2026-09-05T18:00:00.000Z';

describe('canonical snapshot', () => {
  test('standings stay correct when a result has no detail', () => {
    const snapshot = buildCanonicalSnapshot(reportState(), { label: 'Overall' }, generatedAt);
    expect(snapshot.teams.map((row) => row.teamId)).toEqual(['team-a', 'team-b']);
    expect(snapshot.teams[0]).toMatchObject({ wins: 1, losses: 1, pointsFor: 470 });
    expect(snapshot.teams[1]).toMatchObject({ wins: 1, losses: 1, pointsFor: 310 });
    // Team B's paper game carries no tossups-heard: PPTUH is null, not zero.
    const teamB = snapshot.teams[1]!;
    expect(teamB.tossupsHeardKnown).toBe(false);
    expect(teamB.pptuh).toBeNull();
    // No bonuses were ever heard, so PPB is null rather than 0.00.
    expect(snapshot.teams[0]!.ppb).toBeNull();
  });

  test('player unknowns are null and classifications travel with teams', () => {
    const snapshot = buildCanonicalSnapshot(reportState(), { label: 'Overall' }, generatedAt);
    expect(snapshot.players).toHaveLength(1);
    expect(snapshot.players[0]).toMatchObject({ playerId: 'player-a1', points: 135 });
    expect(snapshot.teams[0]!.classifications).toEqual(['Small School']);
    expect(snapshot.games).toHaveLength(2);
    expect(snapshot.games[0]).toMatchObject({ roundName: 'Round 1', detail: 'complete' });
    expect(snapshot.games[1]).toMatchObject({ roundName: 'Round 2', detail: 'partial' });
  });

  test('final placement reorders ranks and keeps calculated ranks', () => {
    const state = reportState();
    state.tournament!.finalPlacement = {
      order: ['team-b', 'team-a'],
      actor: 'Director',
      at: generatedAt,
      reason: 'Final.',
    };
    const snapshot = buildCanonicalSnapshot(state, { label: 'Overall' }, generatedAt);
    expect(snapshot.teams.map((row) => [row.rank, row.teamId])).toEqual([
      [1, 'team-b'],
      [2, 'team-a'],
    ]);
    expect(snapshot.teams[0]!.calculatedRank).toBe(2);
    expect(snapshot.extensions?.finalPlacementApplied).toBe(true);
  });
});

describe('CSV trio', () => {
  test('headers cover the canonical columns and unknowns stay empty', () => {
    const snapshot = buildCanonicalSnapshot(reportState(), { label: 'Overall' }, generatedAt);
    const teams = exportTeamStandingsCsv(snapshot);
    expect(teams).toContain('calculated_rank');
    expect(teams).toContain('superpowers');
    expect(teams).toContain('classifications');
    const teamB = teams.split('\r\n').find((line) => line.includes('Wren'))!;
    // Unknown PPTUH and PPB serialize as empty fields, never zeroes.
    expect(teamB).toMatch(/,,/);
    const players = exportPlayerStatsCsv(snapshot);
    expect(players).toContain('school_year');
    expect(players).toContain('superpowers');
    const games = exportGameResultsCsv(snapshot);
    expect(games).toContain('round_name');
    expect(games).toContain('partial');
  });
});

describe('static report bundle', () => {
  test('all seven pages exist, link each other, and escape names', () => {
    const state = reportState();
    state.tournament!.finalPlacement = {
      order: ['team-b', 'team-a'],
      actor: 'Director',
      at: generatedAt,
    };
    const snapshot = buildCanonicalSnapshot(state, { label: 'Overall' }, generatedAt);
    const pages = buildStatReportBundle(snapshot);
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
    for (const page of pages) {
      for (const target of [
        'index.html',
        'standings.html',
        'individuals.html',
        'games.html',
        'rounds.html',
        'teamdetail.html',
        'playerdetail.html',
      ]) {
        expect(page.content).toContain(`href="${target}"`);
      }
      expect(page.content).not.toContain('<script');
    }
    const standings = pages.find((page) => page.name === 'standings.html')!.content;
    // The team name is escaped everywhere it appears…
    expect(standings).toContain('&lt;Aiken&gt; &amp; Co.');
    expect(standings).not.toContain('<Aiken>');
    // …and the final order leads with Wren while keeping the calculated rank.
    const wrenAt = standings.indexOf('>Wren<');
    const aikenAt = standings.indexOf('Aiken&gt;');
    expect(wrenAt).toBeGreaterThan(-1);
    expect(wrenAt).toBeLessThan(aikenAt);
    expect(standings).toContain('explicit final order');
  });

  test('bundle output is deterministic', () => {
    const snapshot = buildCanonicalSnapshot(reportState(), { label: 'Overall' }, generatedAt);
    const first = buildStatReportBundle(snapshot);
    const second = buildStatReportBundle(snapshot);
    expect(second).toEqual(first);
  });
});
