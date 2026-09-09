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

  test('the standalone standings download is exactly the canonical bundle page', () => {
    const state = playedTournament();
    const artifact = buildCanonicalStatReport(state, generatedAt);
    const files = unzipSync(artifact.bytes);
    const bundledStandings = strFromU8(files['standings.html']!);

    expect(buildCanonicalStandingsHtml(state, generatedAt)).toBe(bundledStandings);
  });

  test('same state and generated timestamp produce the same deterministic page content', () => {
    const first = buildCanonicalStatReport(playedTournament(), generatedAt);
    const second = buildCanonicalStatReport(playedTournament(), generatedAt);

    // ZIP containers may carry file metadata, so page content — not container bytes — is the
    // determinism contract of the static report serializer.
    expect(second.pages).toEqual(first.pages);
  });
});
