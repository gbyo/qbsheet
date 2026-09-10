import { describe, expect, test } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { defaultReportOptions } from '@qbsheet/tournament-formats';
import { playedTournament } from '../../../tests/directorFixtures';
import { buildCanonicalResourceCenterReport } from './resourceCenterExport';

const generatedAt = '2026-09-09T18:00:00.000Z';

describe('canonical resource center export', () => {
  test('zips the six required roles plus the optional stat key under one base name', () => {
    const artifact = buildCanonicalResourceCenterReport(playedTournament(), generatedAt);
    expect(artifact.baseName).toBe('Ninety-Six-Invitational');
    expect(artifact.fileName).toBe('Ninety-Six-Invitational-resource-center.zip');
    expect(artifact.scopeLabel).toBe('Overall');
    expect(artifact.files.map((file) => file.kind)).toEqual([
      'standings',
      'individuals',
      'scoreboard',
      'teamDetail',
      'playerDetail',
      'rounds',
      'statKey',
    ]);
    for (const file of artifact.files) {
      expect(file.requiredForResourceCenter).toBe(file.kind !== 'statKey');
      expect(file.fileName.startsWith(`${artifact.baseName}_`)).toBe(true);
    }

    const files = unzipSync(artifact.bytes);
    expect(Object.keys(files).sort()).toEqual(artifact.files.map((file) => file.fileName).sort());
    const standings = strFromU8(files[`${artifact.baseName}_standings.html`]!);
    expect(standings).toContain('Ninety Six Invitational');
    expect(standings).toContain('Team standings');
    expect(standings).not.toContain('<script');
  });

  test('forces the full six-view set even when printable options narrow the pages', () => {
    const artifact = buildCanonicalResourceCenterReport(playedTournament(), generatedAt, {
      ...defaultReportOptions,
      pages: ['standings'],
    });
    expect(artifact.files).toHaveLength(7);
    const names = new Set(artifact.files.map((file) => file.fileName));
    for (const suffix of [
      '_standings.html',
      '_individuals.html',
      '_games.html',
      '_teamdetail.html',
      '_playerdetail.html',
      '_rounds.html',
      '_statkey.html',
    ]) {
      expect([...names].some((name) => name.endsWith(suffix))).toBe(true);
    }
  });

  test('same state and generated timestamp produce the same page content', () => {
    const first = buildCanonicalResourceCenterReport(playedTournament(), generatedAt);
    const second = buildCanonicalResourceCenterReport(playedTournament(), generatedAt);
    expect(second.files).toEqual(first.files);
  });
});
