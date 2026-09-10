/**
 * Cross-surface statistics parity, seeding Deliverable 5/6 of #754.
 *
 * One reference tournament must produce the same statistics in every QBSheet
 * surface: the canonical domain, Director Stats cells, the printable snapshot
 * and its HTML, the standings CSV, and the QBLive projection. A column that
 * exists on one surface but drifts (or fabricates) on another fails here.
 *
 * Scope is the main-model stat set: record, win %, GP, PPG, answer counts,
 * TUH, PPTUH, bonuses heard/points, and PPB. Foundation-gated statistics
 * (bounceback conversion, lightning, fractional GP, eligibility metadata)
 * extend this matrix when #746-#749 land, as do the QBLive TUH/games columns
 * from #753/PR8; unknowns already propagate as null/— on every surface below.
 */

import { describe, expect, test } from 'vitest';
import {
  buildStandingsTable,
  buildTeamStatisticsTable,
} from '@qbsheet/qblive-projection';
import { parseCsvTable } from '@qbsheet/tournament-formats';
import { renderStageAwareStandingsReport } from '@qbsheet/tournament-formats';
import { derivePlayerStandings, deriveTeamStandings } from '../src/director/domain';
import { buildCanonicalSnapshot } from '../src/director/reports/canonicalReports';
import { buildCanonicalStandingsReport } from '../src/director/reports/standingsReport';
import { teamStandingsCsv } from '../src/director/format/standingsCsv';
import {
  formatAverage,
  formatPpb,
  formatPptuh,
  formatRecord,
  formatTuh,
  formatWinPct,
} from '../src/director/standings/statsDisplay';
import { playedTournament, team } from './directorFixtures';

const generatedAt = '2026-09-09T20:00:00.000Z';
const naming = {
  teamName: (teamId: string) => teamId,
  playerName: () => null,
};
const overall = { id: 'overall', label: 'Overall' };

function teamStanding(teamId = 'team-a') {
  const standing = deriveTeamStandings(playedTournament()).find(
    (entry) => entry.teamId === teamId,
  );
  if (!standing) throw new Error(`missing standing for ${teamId}`);
  return standing;
}

function csvRow(csv: string, teamName: string): Record<string, string> {
  const parsed = parseCsvTable(csv);
  if (!parsed.ok) throw new Error(parsed.errors.map((entry) => entry.message).join(' '));
  const index = parsed.value.rows.findIndex((cells) => cells[2] === teamName);
  if (index < 0) throw new Error(`missing CSV row for ${teamName}`);
  const headers = parsed.value.headers;
  return Object.fromEntries(
    headers.map((header, position) => [header, parsed.value.rows[index]![position] ?? '']),
  );
}

function qbliveCell(
  table: { columns: { id: string }[]; rows: { teamId?: string; cells: { value: unknown; display?: string }[] }[] },
  teamId: string,
  columnId: string,
) {
  const position = table.columns.findIndex((column) => column.id === columnId);
  expect(position).toBeGreaterThanOrEqual(0);
  const row = table.rows.find((entry) => entry.teamId === teamId);
  expect(row).toBeDefined();
  return row!.cells[position]!;
}

describe('one tournament, every surface (#754)', () => {
  test('canonical team facts agree across Director, print, CSV, and QBLive', () => {
    const state = playedTournament();
    const standing = teamStanding();
    expect(standing).toMatchObject({
      gamesPlayed: 1,
      wins: 1,
      pointsFor: 300,
      bonuses: 12,
      bonusPoints: 130,
      tossupsHeard: 20,
      tossupsHeardKnown: true,
    });

    // Director Stats cells (shared formatters; the schema cell mappings from #750 extend this).
    expect(formatRecord(standing)).toBe('1–0');
    expect(formatWinPct(standing)).toBe('100.0%');
    expect(formatAverage(standing.pointsFor, standing.gamesPlayed)).toBe('300.0');
    expect(formatTuh(standing)).toBe('20');
    expect(formatPptuh(standing.pointsFor, standing)).toBe('15.00');
    expect(formatPpb(standing)).toBe('10.83');

    // Printable snapshot rows carry the same numerators for the HTML pages.
    const snapshot = buildCanonicalSnapshot(state, undefined, generatedAt);
    const snapRow = snapshot.teams.find((row) => row.teamId === 'team-a')!;
    expect(snapRow.bonusesHeard).toBe(12);
    expect(snapRow.bonusPoints).toBe(130);
    expect(snapRow.ppb).toBeCloseTo(130 / 12, 10);
    expect(snapRow.tossupsHeard).toBe(20);
    expect(snapRow.pptuh).toBe(15);

    // The rendered standings page prints those exact display strings.
    const html = renderStageAwareStandingsReport(buildCanonicalStandingsReport(state, generatedAt));
    expect(html).toContain('<td class="num">10.83</td>');
    expect(html).toContain('<td class="num">15.00</td>');

    // The CSV carries the exact canonical numerics.
    const csv = csvRow(teamStandingsCsv(state), 'Ninety Six');
    expect(csv['bonuses_heard']).toBe('12');
    expect(csv['bonus_points']).toBe('130');
    expect(csv['ppb']).toBe('10.83');

    // QBLive publishes the same values with stable column ids.
    const standings = buildStandingsTable(state, overall, naming);
    expect(qbliveCell(standings, 'team-a', 'record')).toEqual({ value: '1-0', display: '1-0' });
    expect(qbliveCell(standings, 'team-a', 'ppg')).toEqual({ value: 300, display: '300.0' });
    const teamStats = buildTeamStatisticsTable(state, overall, naming);
    expect(qbliveCell(teamStats, 'team-a', 'games')).toEqual({ value: 1, display: '1' });
    expect(qbliveCell(teamStats, 'team-a', 'ppb')).toEqual({ value: 130 / 12, display: '10.83' });
  });

  test('player facts agree between the domain, Director, and printable rows', () => {
    const state = playedTournament();
    const standing = derivePlayerStandings(state).find(
      (entry) => entry.playerId === 'player-a',
    )!;
    expect(standing.gamesPlayed).toBe(1);
    expect(standing.tossupsHeard).toBe(20);

    expect(formatTuh(standing)).toBe('20');
    expect(formatPptuh(standing.points, standing)).toBe((standing.points / 20).toFixed(2));

    const snapshot = buildCanonicalSnapshot(state, undefined, generatedAt);
    const snapRow = snapshot.players.find((row) => row.playerId === 'player-a')!;
    expect(snapRow.tossupsHeard).toBe(20);
    expect(snapRow.pptuh).toBeCloseTo(standing.points / 20, 10);
  });

  test('an unknown TUH is null/— on every surface, never a zero', () => {
    const state = playedTournament();
    for (const line of state.games[0]!.playerStats) line.tossupsHeard = null;

    const standing = deriveTeamStandings(state).find((entry) => entry.teamId === 'team-a')!;
    expect(standing.tossupsHeardKnown).toBe(false);
    expect(formatTuh(standing)).toBe('—');
    expect(formatPptuh(standing.pointsFor, standing)).toBe('—');

    const snapshot = buildCanonicalSnapshot(state, undefined, generatedAt);
    const snapRow = snapshot.teams.find((row) => row.teamId === 'team-a')!;
    expect(snapRow.tossupsHeard).toBeNull();
    expect(snapRow.pptuh).toBeNull();

    const html = renderStageAwareStandingsReport(buildCanonicalStandingsReport(state, generatedAt));
    expect(html).not.toContain('<td class="num">20</td>');
    // QBLive TUH/PPTUH columns arrive with #753/PR8; the null contract above is what they consume.
  });

  test('a team that has not played is blank/unknown everywhere, never winless', () => {
    const state = playedTournament();
    state.teams.push(team('team-c', 'Abbeville'));

    const standing = deriveTeamStandings(state).find((entry) => entry.teamId === 'team-c')!;
    expect(standing.gamesPlayed).toBe(0);
    expect(formatWinPct(standing)).toBe('—');

    const csv = csvRow(teamStandingsCsv(state), 'Abbeville');
    expect(csv['win_percentage']).toBe('');
    // QBLive win-rate unknown arrives with #753/PR8.
  });

  test('a known zero renders as zero on every surface', () => {
    const state = playedTournament();
    state.teams.push(team('team-c', 'Abbeville'));

    const standing = deriveTeamStandings(state).find((entry) => entry.teamId === 'team-c')!;
    expect(standing.gamesPlayed).toBe(0);
    expect(String(standing.gamesPlayed)).toBe('0');

    const snapshot = buildCanonicalSnapshot(state, undefined, generatedAt);
    expect(snapshot.teams.find((row) => row.teamId === 'team-c')!.gamesPlayed).toBe(0);

    const csv = csvRow(teamStandingsCsv(state), 'Abbeville');
    expect(csv['games_played']).toBe('0');
  });
});
