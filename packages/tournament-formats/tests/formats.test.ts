import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import sampleTournament from './fixtures/sample-tournament.json';
import {
  directorArchiveDataPath,
  directorArchiveManifestPath,
  directorArchiveVersion,
  exportDirectorArchiveReport,
  importDirectorArchive,
} from '../src/archive';
import {
  exportQbjDocument,
  exportQbjTextReport,
  importQbj,
  importQbjResults,
  qbjSerializationVersion,
} from '../src/qbj';
import { exportSqbsTeams, importSqbsTeams, importTeamsCsv, parseCsvTable, serializeCsv } from '../src/csv';
import {
  buildStatsSnapshot,
  exportPlayerStatsCsv,
  exportStatsHtml,
  exportStatsJson,
  exportTeamStandingsCsv,
} from '../src/stats';
import type { DirectorTournamentInput, JsonObject } from '../src/types';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

const tournament = sampleTournament as unknown as DirectorTournamentInput;

describe('portable Director archives', () => {
  test('round-trips structured tournament JSON and optional assets', () => {
    const exported = exportDirectorArchiveReport(tournament, {
      createdAt: '2026-04-11T15:00:00.000Z',
      generator: { name: 'QBSheet Director', version: '0.1.0' },
      assets: [
        { path: 'assets/packet-1.pdf', data: new Uint8Array([37, 80, 68, 70]), mediaType: 'application/pdf' },
      ],
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value.manifest.version).toBe(directorArchiveVersion);
    const files = unzipSync(exported.value.bytes);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([directorArchiveManifestPath, directorArchiveDataPath, 'assets/packet-1.pdf']),
    );
    expect(JSON.parse(strFromU8(files[directorArchiveManifestPath])).format).toBe('qbsheet-director-archive');
    expect(JSON.parse(strFromU8(files[directorArchiveDataPath])).games[0].result.teams[0].points).toBe(315);

    const imported = importDirectorArchive(exported.value.bytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.tournament.tournament.name).toBe('Spring, Invitational');
    expect(imported.value.tournament.extensions?.futureDirectorField).toEqual({ kept: true });
    expect(imported.value.tournament.games[0].result?.teams[0].points).toBe(315);
    expect(imported.value.assets[0].mediaType).toBe('application/pdf');
    expect([...imported.value.assets[0].data]).toEqual([37, 80, 68, 70]);
  });

  test('rejects a future archive version before opening data', () => {
    const exported = exportDirectorArchiveReport(tournament);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const files = unzipSync(exported.value.bytes);
    const manifest = JSON.parse(strFromU8(files[directorArchiveManifestPath])) as { version: number };
    manifest.version = directorArchiveVersion + 1;
    const invalid = zipSync({
      ...files,
      [directorArchiveManifestPath]: strToU8(`${JSON.stringify(manifest)}\n`),
    });
    const imported = importDirectorArchive(invalid);
    expect(imported.ok).toBe(false);
    if (imported.ok) return;
    expect(imported.errors.some((entry) => entry.code === 'unsupported-future-version')).toBe(true);
  });

  test('rejects non-archives and preserves unknown archive entries when present', () => {
    const notAnArchive = importDirectorArchive(new Uint8Array([1, 2, 3]));
    expect(notAnArchive.ok).toBe(false);
    const exported = exportDirectorArchiveReport(tournament);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const files = unzipSync(exported.value.bytes);
    const withExtra = zipSync({ ...files, 'future/data.bin': new Uint8Array([9, 8, 7]) });
    const imported = importDirectorArchive(withExtra);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect([...imported.value.extraFiles['future/data.bin']]).toEqual([9, 8, 7]);
    expect(imported.warnings.some((entry) => entry.code === 'unsupported-file-preserved')).toBe(true);
  });
});

describe('QBJ compatibility adapters', () => {
  test('imports current QBSheet-style tournament/result objects and preserves extensions', () => {
    const imported = importQbj(fixture('sample.qbj'));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.document.version).toBe(qbjSerializationVersion);
    expect(imported.value.tournament.tournament.name).toBe('Fixture Invitational');
    expect(imported.value.tournament.teams.map((team) => team.name)).toEqual(['Alpha A', 'Beta A']);
    expect(imported.value.tournament.games).toHaveLength(1);
    expect(imported.value.tournament.games[0].result?.teams[0].points).toBe(315);
    expect(imported.value.tournament.games[0].source?.custom_match_extension).toEqual({ source: 'fixture' });
    expect(imported.value.tournament.qbj?.unknownObjects?.[0].type).toBe('FutureObject');
    expect(imported.warnings.some((entry) => entry.code === 'unsupported-field-preserved')).toBe(true);
    expect(imported.warnings.some((entry) => entry.code === 'unsupported-object-type')).toBe(true);

    const exported = exportQbjTextReport(imported.value.tournament, { mode: 'results' });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const reparsed = importQbj(exported.value);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const match = reparsed.value.document.objects.find((object) => object.type === 'Match');
    expect(match?._qbtcp).toEqual(expect.objectContaining({ room_id: 'room-101', custom: { keep: 'yes' } }));
    expect(match?.custom_match_extension).toEqual({ source: 'fixture' });
    expect(
      reparsed.value.tournament.qbj?.unknownObjects?.some((object) => object.type === 'FutureObject'),
    ).toBe(true);
  });

  test('accepts a bare Match for legacy compatibility and can export a scoped result', () => {
    const document = JSON.parse(fixture('sample.qbj')) as { objects: Array<Record<string, unknown>> };
    const match = document.objects.find((object) => object.type === 'Match');
    expect(match).toBeDefined();
    const imported = importQbj(match as JsonObject);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.matchOnly).toBe(true);
    expect(imported.value.tournament.games).toHaveLength(1);
    expect(importQbjResults(fixture('sample.qbj')).ok).toBe(true);
    const output = exportQbjDocument(imported.value.tournament, { mode: 'results' });
    expect(output.version).toBe(qbjSerializationVersion);
    expect(output.objects.some((object) => object.type === 'Match')).toBe(true);
  });

  test('refuses an unsupported QBJ serialization version', () => {
    const invalid = fixture('sample.qbj').replace('"version": "2.1.1"', '"version": "9.9.9"');
    const imported = importQbj(invalid);
    expect(imported.ok).toBe(false);
    if (imported.ok) return;
    expect(imported.errors[0].code).toBe('unsupported-version');
  });
});

describe('CSV and SQBS team adapters', () => {
  test('quotes commas, quotes, and newlines without changing cell values', () => {
    const text = serializeCsv(
      ['team_name', 'player_name', 'notes'],
      [['Alpha, A', 'Alice "Ace"', 'line one\nline two']],
    );
    expect(text).toContain('"Alpha, A"');
    expect(text).toContain('"Alice ""Ace"""');
    const parsed = parseCsvTable(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.rows[0]).toEqual(['Alpha, A', 'Alice "Ace"', 'line one\nline two']);
  });

  test('imports the practical team CSV shape and groups roster rows', () => {
    const imported = importTeamsCsv(fixture('sample-teams.csv'));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value).toHaveLength(1);
    expect(imported.value[0].name).toBe('Alpha, A');
    expect(imported.value[0].players?.map((player) => player.name)).toEqual(['Alice "Ace"', 'Arun\\nSingh']);
    expect(imported.value[0].players?.[0].rosterNumber).toBe('12');
  });

  test('reads and writes the positional SQBS roster format', () => {
    const imported = importSqbsTeams(fixture('sample.sqbs'));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.map((team) => team.name)).toEqual(['Alpha A', 'Beta A']);
    expect(imported.value[0].players?.[0].name).toBe('Alice');
    expect(imported.value[0].players?.[0].rosterNumber).toBe(12);
    const exported = exportSqbsTeams(imported.value);
    expect(exported).toContain('Alice (12)');
    const reparsed = importSqbsTeams(exported);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value[1].players?.[0].name).toBe('Bea');
  });
});

describe('derived statistics exports', () => {
  test('derives standings and player metrics from accepted games', () => {
    const stats = buildStatsSnapshot(tournament, { generatedAt: '2026-04-11T16:00:00.000Z' });
    expect(stats.ok).toBe(true);
    if (!stats.ok) return;
    expect(stats.value.teams[0]).toEqual(
      expect.objectContaining({
        teamName: 'Ninety Six A',
        wins: 1,
        losses: 0,
        pointsFor: 315,
        pointsAgainst: 240,
      }),
    );
    expect(stats.value.teams[1]).toEqual(
      expect.objectContaining({ teamName: 'Greenwood A', wins: 0, losses: 1 }),
    );
    expect(stats.value.players[0]).toEqual(
      expect.objectContaining({ playerName: "Sarah O'Brien", powers: 2, points: 115 }),
    );
    expect(stats.value.games[0].winnerId).toBe('team-ninety-six');
    expect(exportStatsJson(stats.value)).toContain('"qbsheet-stats"');
    expect(exportTeamStandingsCsv(stats.value)).toContain('team_name');
    expect(exportPlayerStatsCsv(stats.value)).toContain('player_name');
    expect(exportStatsHtml(stats.value)).toContain('<h2>Team standings</h2>');
    expect(
      exportStatsHtml({ ...stats.value, tournament: { ...stats.value.tournament, name: '<Unsafe>' } }),
    ).toContain('&lt;Unsafe&gt;');
  });
});
