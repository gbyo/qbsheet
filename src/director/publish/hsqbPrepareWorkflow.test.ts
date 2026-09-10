/**
 * Prepare-for-HSQuizbowl workflow helpers (issue #766).
 *
 * The upload-field mapping is generated from each file's semantic role, never
 * by parsing filenames; preflight diagnostics link at a fix only where an
 * operator-side fix exists.
 */
import { describe, expect, test } from 'vitest';
import type { ResourceCenterReportFile } from '@qbsheet/tournament-formats';
import { hsqbFixDestination, hsqbSetStatus, hsqbUploadFieldMapping } from './hsqbPrepareWorkflow';

function file(kind: ResourceCenterReportFile['kind'], fileName: string): ResourceCenterReportFile {
  return { kind, requiredForResourceCenter: kind !== 'statKey', fileName, content: '<html></html>' };
}

describe('hsqbUploadFieldMapping', () => {
  test('maps every required role to its upload field in form order', () => {
    const files = [
      file('statKey', 'tourney_statkey.html'),
      file('rounds', 'tourney_rounds.html'),
      file('standings', 'tourney_standings.html'),
      file('playerDetail', 'tourney_playerdetail.html'),
      file('teamDetail', 'tourney_teamdetail.html'),
      file('individuals', 'tourney_individuals.html'),
      file('scoreboard', 'tourney_games.html'),
    ];
    const mapping = hsqbUploadFieldMapping(files);
    expect(mapping.map((row) => row.field)).toEqual([
      'Standings',
      'Individuals',
      'Scoreboard',
      'Team Detail',
      'Player Detail',
      'Round Report',
    ]);
    expect(mapping.map((row) => row.fileName)).toEqual([
      'tourney_standings.html',
      'tourney_individuals.html',
      'tourney_games.html',
      'tourney_teamdetail.html',
      'tourney_playerdetail.html',
      'tourney_rounds.html',
    ]);
    // Only the Scoreboard mapping is attested by a public walkthrough.
    expect(mapping.find((row) => row.kind === 'scoreboard')!.attested).toBe(true);
    expect(mapping.filter((row) => row.kind !== 'scoreboard').every((row) => !row.attested)).toBe(true);
  });

  test('mapping follows file roles, not filename substrings', () => {
    // Deliberately misleading names: the Scoreboard role must still map to
    // the Scoreboard field even though its filename suggests standings.
    const files = [
      file('standings', 'tourney_games.html'),
      file('individuals', 'tourney_individuals.html'),
      file('scoreboard', 'tourney_standings.html'),
      file('teamDetail', 'tourney_teamdetail.html'),
      file('playerDetail', 'tourney_playerdetail.html'),
      file('rounds', 'tourney_rounds.html'),
    ];
    const mapping = hsqbUploadFieldMapping(files);
    expect(mapping.find((row) => row.field === 'Scoreboard')!.fileName).toBe('tourney_standings.html');
    expect(mapping.find((row) => row.field === 'Standings')!.fileName).toBe('tourney_games.html');
  });

  test('the optional Stat Key companion never becomes an upload field', () => {
    const files = [file('standings', 't_stat.html'), file('statKey', 't_statkey.html')];
    expect(hsqbUploadFieldMapping(files).map((row) => row.kind)).toEqual(['standings']);
  });
});

describe('hsqbFixDestination', () => {
  test('result problems link at Results, identity at Settings, rules at Format', () => {
    expect(hsqbFixDestination('no-accepted-games')).toMatchObject({ section: 'results' });
    expect(hsqbFixDestination('unresolved-game-winner')).toMatchObject({ section: 'results' });
    expect(hsqbFixDestination('team-total-mismatch')).toMatchObject({ section: 'results' });
    expect(hsqbFixDestination('missing-tournament-identity')).toMatchObject({ section: 'settings' });
    expect(hsqbFixDestination('mixed-scoring-definitions')).toMatchObject({ section: 'format' });
  });

  test('structural generator diagnostics offer no operator fix', () => {
    for (const code of [
      'missing-required-report',
      'duplicate-report-role',
      'report-filename-mismatch',
      'malformed-document',
      'dangling-report-link',
      'statkey-missing-column',
      'not-a-real-code',
    ]) {
      expect(hsqbFixDestination(code)).toBeNull();
    }
  });
});

describe('hsqbSetStatus', () => {
  test('blockers veto, warnings ride along', () => {
    expect(hsqbSetStatus(0, 0)).toBe('ready');
    expect(hsqbSetStatus(0, 2)).toBe('warnings');
    expect(hsqbSetStatus(1, 0)).toBe('blocked');
    expect(hsqbSetStatus(1, 3)).toBe('blocked');
  });
});
