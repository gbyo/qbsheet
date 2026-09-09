import { describe, expect, test } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { playedTournament } from '../../../tests/directorFixtures';
import { buildCanonicalStandingsHtml, buildCanonicalStatReport } from './statReportExport';

const generatedAt = '2026-09-09T18:00:00.000Z';

describe('canonical stat report export', () => {
  test('packages every linked static report page into one zip', () => {
    const artifact = buildCanonicalStatReport(playedTournament(), generatedAt);
    expect(artifact.fileName).toBe('Ninety-Six-Invitational-stat-report.zip');

    const files = unzipSync(artifact.bytes);
    expect(Object.keys(files).sort()).toEqual(
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

    const index = strFromU8(files['index.html']!);
    for (const target of [
      'standings.html',
      'individuals.html',
      'games.html',
      'rounds.html',
      'teamdetail.html',
      'playerdetail.html',
    ]) {
      expect(index).toContain(`href="${target}"`);
    }
    expect(index).toContain('Ninety Six Invitational');
    expect(index).not.toContain('<script');
  });

  test('every standings team link resolves to a teamdetail section anchor', () => {
    const files = unzipSync(buildCanonicalStatReport(playedTournament(), generatedAt).bytes);
    const standings = strFromU8(files['standings.html']!);
    const teamdetail = strFromU8(files['teamdetail.html']!);

    const linked = [...standings.matchAll(/href="teamdetail\.html#([^"]+)"/g)].map((m) => m[1]);
    expect(linked.length).toBeGreaterThan(0);
    for (const anchor of linked) {
      expect(teamdetail).toContain(`id="${anchor}"`);
    }
  });

  test('the standalone standings download is exactly the canonical bundle page', () => {
    const state = playedTournament();
    const artifact = buildCanonicalStatReport(state, generatedAt);
    const files = unzipSync(artifact.bytes);
    const bundledStandings = strFromU8(files['standings.html']!);

    expect(buildCanonicalStandingsHtml(state, generatedAt)).toBe(bundledStandings);
  });

  test('the exported page contains stage composition, advancement, rich columns, and exact game anchors', () => {
    const state = playedTournament();
    state.phases[0]!.name = 'Prelims';
    state.phases[0]!.advancementRule = {
      qualifiersPerPool: 1,
      wildcards: 0,
      tiebreakers: [...state.tournament!.rules.tiebreakers],
      manualOverrideAllowed: true,
    };
    state.phases.push({
      id: 'phase-2',
      name: 'Playoffs',
      kind: 'playoff',
      order: 2,
      formatId: 'format-1',
      teamIds: ['team-a'],
      poolIds: [],
      roundIds: [],
      advancementRule: null,
      carryover: false,
      status: 'planned',
    });

    const artifact = buildCanonicalStatReport(state, generatedAt);
    const files = unzipSync(artifact.bytes);
    const standings = strFromU8(files['standings.html']!);
    const games = strFromU8(files['games.html']!);

    expect(standings).toContain('Prelims');
    expect(standings).toContain('Playoffs');
    expect(standings).toContain('All Games');
    expect(standings).toContain('Would advance to Playoffs');
    expect(standings).toContain('<th scope="col" class="num">TUH</th>');
    expect(standings).toContain('<th scope="col" class="num">PPTUH</th>');
    expect(standings).toContain('href="teamdetail.html#team-team-a"');
    expect(games).toContain('id="game-game-1"');
  });

  test('same state and generated timestamp produce the same deterministic page content', () => {
    const first = buildCanonicalStatReport(playedTournament(), generatedAt);
    const second = buildCanonicalStatReport(playedTournament(), generatedAt);

    // ZIP containers may carry file metadata, so page content — not container bytes — is the
    // determinism contract of the static report serializer.
    expect(second.pages).toEqual(first.pages);
  });
});
