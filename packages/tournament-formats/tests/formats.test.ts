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
  maxDirectorArchiveEntryBytes,
  maxDirectorArchiveEntryCount,
  maxDirectorArchiveTotalUncompressedBytes,
} from '../src/archive';
import {
  exportQbjDocument,
  exportQbjTextReport,
  importQbj,
  importQbjResults,
  qbjSerializationVersion,
} from '../src/qbj';
import {
  csvCell,
  exportSqbsTeams,
  importSqbsTeams,
  importTeamsCsv,
  parseCsvTable,
  serializeCsv,
} from '../src/csv';
import {
  buildStatsSnapshot,
  exportPlayerStatsCsv,
  exportStatsHtml,
  exportStatsJson,
  exportTeamStandingsCsv,
} from '../src/stats';
import type { DirectorTournamentInput, JsonObject, JsonValue } from '../src/types';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  );
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

interface CentralEntry {
  offset: number;
  length: number;
  name: string;
}

function centralEntries(bytes: Uint8Array): { eocd: number; centralSize: number; entries: CentralEntry[] } {
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65558); offset -= 1) {
    if (readU32(bytes, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record not found.');
  const entries: CentralEntry[] = [];
  let offset = readU32(bytes, eocd + 16);
  const count = readU16(bytes, eocd + 8);
  for (let index = 0; index < count; index += 1) {
    if (readU32(bytes, offset) !== 0x02014b50) throw new Error('ZIP central-directory record not found.');
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const length = 46 + nameLength + extraLength + commentLength;
    entries.push({
      offset,
      length,
      name: strFromU8(
        bytes.subarray(offset + 46, offset + 46 + nameLength),
        !(readU16(bytes, offset + 8) & 0x800),
      ),
    });
    offset += length;
  }
  return { eocd, centralSize: readU32(bytes, eocd + 12), entries };
}

function duplicateCentralEntry(bytes: Uint8Array, name: string): Uint8Array {
  const central = centralEntries(bytes);
  const entry = central.entries.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`ZIP entry ${name} not found.`);
  const copy = bytes.slice(entry.offset, entry.offset + entry.length);
  const duplicate = new Uint8Array(bytes.length + copy.length);
  duplicate.set(bytes.subarray(0, central.eocd));
  duplicate.set(copy, central.eocd);
  duplicate.set(bytes.subarray(central.eocd), central.eocd + copy.length);
  const duplicateEocd = central.eocd + copy.length;
  writeU16(duplicate, duplicateEocd + 8, readU16(duplicate, duplicateEocd + 8) + 1);
  writeU16(duplicate, duplicateEocd + 10, readU16(duplicate, duplicateEocd + 10) + 1);
  writeU32(duplicate, duplicateEocd + 12, central.centralSize + copy.length);
  return duplicate;
}

function rewriteCentralUncompressedSizes(bytes: Uint8Array, size: number): Uint8Array {
  const rewritten = bytes.slice();
  const central = centralEntries(rewritten);
  central.entries.forEach((entry) => writeU32(rewritten, entry.offset + 24, size));
  return rewritten;
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

  test('rejects a highly compressible oversized entry before inflating it', () => {
    const oversized = zipSync({
      'future/oversized.bin': new Uint8Array(maxDirectorArchiveEntryBytes + 1),
    });
    expect(oversized.byteLength).toBeLessThan(maxDirectorArchiveEntryBytes);
    const imported = importDirectorArchive(oversized);
    expect(imported.ok).toBe(false);
    if (imported.ok) return;
    expect(imported.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'entry-too-large', path: 'future/oversized.bin' }),
      ]),
    );

    // Leave the local payload tiny but advertise the hostile size only in the central directory.
    // An importer that inflates before checking metadata sees a corrupt stream instead of the
    // specific safety error below.
    const metadataOnlyOversized = rewriteCentralUncompressedSizes(
      zipSync({ 'future/metadata-only.bin': new Uint8Array([1]) }),
      maxDirectorArchiveEntryBytes + 1,
    );
    const metadataImport = importDirectorArchive(metadataOnlyOversized);
    expect(metadataImport.ok).toBe(false);
    if (!metadataImport.ok)
      expect(metadataImport.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'entry-too-large', path: 'future/metadata-only.bin' }),
        ]),
      );
  });

  test('rejects excessive entry counts and aggregate uncompressed size from metadata', () => {
    const manyEntries = Object.fromEntries(
      Array.from({ length: maxDirectorArchiveEntryCount + 1 }, (_, index) => [
        `future/${index}.bin`,
        new Uint8Array(),
      ]),
    );
    const tooMany = importDirectorArchive(zipSync(manyEntries));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.errors[0].code).toBe('archive-too-many-entries');

    const smallArchive = zipSync({
      'future/one.bin': new Uint8Array([1]),
      'future/two.bin': new Uint8Array([2]),
      'future/three.bin': new Uint8Array([3]),
    });
    const tooMuch = importDirectorArchive(
      rewriteCentralUncompressedSizes(smallArchive, Math.floor(maxDirectorArchiveTotalUncompressedBytes / 2)),
    );
    expect(tooMuch.ok).toBe(false);
    if (!tooMuch.ok) expect(tooMuch.errors[0].code).toBe('archive-uncompressed-too-large');
  });

  test('rejects unsafe and duplicate ZIP paths and reserved manifest declarations', () => {
    const unsafe = importDirectorArchive(zipSync({ '../escape.bin': new Uint8Array([1]) }));
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) expect(unsafe.errors[0].code).toBe('unsafe-entry-path');

    const exported = exportDirectorArchiveReport(tournament);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const duplicate = importDirectorArchive(
      duplicateCentralEntry(exported.value.bytes, directorArchiveManifestPath),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.errors[0].code).toBe('duplicate-entry');

    const files = unzipSync(exported.value.bytes);
    const manifest = JSON.parse(strFromU8(files[directorArchiveManifestPath])) as {
      files: Array<Record<string, unknown>>;
    };
    manifest.files.push({
      path: directorArchiveManifestPath,
      kind: 'asset',
      required: false,
      mediaType: 'application/octet-stream',
      bytes: 0,
    });
    const reserved = importDirectorArchive(
      zipSync({ ...files, [directorArchiveManifestPath]: strToU8(`${JSON.stringify(manifest)}\n`) }),
    );
    expect(reserved.ok).toBe(false);
    if (!reserved.ok)
      expect(reserved.errors.some((entry) => entry.code === 'reserved-archive-path')).toBe(true);
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

  test('uses stable string player references even when display names collide', () => {
    const input = {
      version: qbjSerializationVersion,
      objects: [
        {
          type: 'Tournament',
          id: 't-identity',
          name: 'Identity Invitational',
          phases: [
            {
              type: 'Phase',
              id: 'phase-identity',
              name: 'Prelims',
              rounds: [
                { type: 'Round', id: 'round-identity', name: '1', matches: [{ $ref: 'match-identity' }] },
              ],
            },
          ],
        },
        { type: 'Player', id: 'player-one', name: 'Alex Morgan' },
        { type: 'Player', id: 'player-two', name: 'Alex Morgan' },
        { type: 'Team', id: 'team-one', name: 'Alpha A', players: [{ $ref: 'player-one' }] },
        { type: 'Team', id: 'team-two', name: 'Beta A', players: [{ $ref: 'player-two' }] },
        { type: 'AnswerType', id: 'answer-power', value: 15, label: 'Power', short_label: 'P' },
        {
          type: 'Match',
          id: 'match-identity',
          match_teams: [
            {
              team: { $ref: 'team-one' },
              points: 115,
              match_players: [
                {
                  player: 'player-one',
                  tossups_heard: 10,
                  answer_counts: [{ number: 2, answer_type: { $ref: 'answer-power' } }],
                },
              ],
            },
            {
              team: { $ref: 'team-two' },
              points: 100,
              match_players: [
                {
                  player: 'player-two',
                  tossups_heard: 10,
                  answer_counts: [{ number: 1, answer_type: { $ref: 'answer-power' } }],
                },
              ],
            },
          ],
        },
      ],
    } as unknown as JsonObject;
    const imported = importQbj(input);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.tournament.games[0].result?.players?.map((player) => player.playerId)).toEqual([
      'player-one',
      'player-two',
    ]);
    expect(imported.value.tournament.games[0].result?.teams.map((team) => team.powers)).toEqual([2, 1]);
  });

  test('uses a unique name fallback but never silently selects an ambiguous player', () => {
    const input = {
      version: qbjSerializationVersion,
      objects: [
        { type: 'Tournament', id: 't-name', name: 'Name Invitational' },
        { type: 'Player', id: 'player-known', name: 'Renamed Player' },
        { type: 'Team', id: 'team-known', name: 'Known A', players: [{ $ref: 'player-known' }] },
        {
          type: 'Match',
          id: 'match-name',
          match_teams: [
            {
              team: { $ref: 'team-known' },
              points: 10,
              match_players: [{ player: { name: 'Renamed Player' }, tossups_heard: 1 }],
            },
            { team: { name: 'Other B' }, points: 0 },
          ],
        },
      ],
    } as unknown as JsonObject;
    const imported = importQbj(input);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.tournament.games[0].result?.players?.[0].playerId).toBe('player-known');
    expect(imported.warnings.some((entry) => entry.code === 'name-fallback')).toBe(true);

    const ambiguous = {
      ...input,
      objects: [
        ...(input.objects as JsonValue[]),
        { type: 'Player', id: 'player-other', name: 'Renamed Player' },
      ],
    } as unknown as JsonObject;
    const ambiguousImport = importQbj(ambiguous);
    expect(ambiguousImport.ok).toBe(true);
    if (!ambiguousImport.ok) return;
    const ambiguousId = ambiguousImport.value.tournament.games[0].result?.players?.[0].playerId;
    expect(ambiguousId).not.toBe('player-known');
    expect(ambiguousId).not.toBe('player-other');
    expect(ambiguousImport.warnings.some((entry) => entry.code === 'ambiguous-player-name')).toBe(true);
  });

  test('does not fabricate tossups-heard or answer statistics when QBJ omits them', () => {
    const input = {
      version: qbjSerializationVersion,
      objects: [
        { type: 'Tournament', id: 't-incomplete', name: 'Incomplete Invitational' },
        { type: 'Player', id: 'player-incomplete', name: 'Incomplete Player' },
        {
          type: 'Team',
          id: 'team-incomplete',
          name: 'Incomplete A',
          players: [{ $ref: 'player-incomplete' }],
        },
        {
          type: 'Match',
          id: 'match-incomplete',
          tossups_read: 20,
          match_teams: [
            {
              team: { $ref: 'team-incomplete' },
              points: 25,
              match_players: [
                {
                  player: { $ref: 'player-incomplete' },
                  answer_counts: [{ number: 2, answer_type: { label: 'Mystery' } }],
                },
              ],
            },
            { team: { name: 'Other B' }, points: 0 },
          ],
        },
      ],
    } as unknown as JsonObject;
    const imported = importQbj(input);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const result = imported.value.tournament.games[0].result;
    expect(result?.statisticsIncomplete).toBe(true);
    expect(result?.teams[0].tossupsHeard).toBeUndefined();
    expect(result?.teams[0].powers).toBeUndefined();
    expect(result?.players?.[0].tossupsHeard).toBeUndefined();
    expect(result?.players?.[0].powers).toBeUndefined();
    expect(imported.warnings.some((entry) => entry.code === 'missing-tossups-heard')).toBe(true);
    expect(imported.warnings.some((entry) => entry.code === 'incomplete-answer-counts')).toBe(true);
  });

  test('retains pool membership for matches nested in a phase round', () => {
    const input = {
      version: qbjSerializationVersion,
      objects: [
        {
          type: 'Tournament',
          id: 't-pool-context',
          name: 'Pool Context Invitational',
          phases: [
            {
              type: 'Phase',
              id: 'phase-pools',
              kind: 'preliminary',
              pools: [
                {
                  type: 'Pool',
                  id: 'pool-a',
                  teams: [{ $ref: 'team-a' }, { $ref: 'team-b' }],
                },
              ],
              rounds: [
                {
                  type: 'Round',
                  id: 'round-pools',
                  matches: [{ $ref: 'match-pools' }],
                },
              ],
            },
          ],
        },
        { type: 'Team', id: 'team-a', name: 'Alpha A' },
        { type: 'Team', id: 'team-b', name: 'Beta A' },
        {
          type: 'Match',
          id: 'match-pools',
          match_teams: [
            { team: { $ref: 'team-a' }, points: 100 },
            { team: { $ref: 'team-b' }, points: 90 },
          ],
        },
      ],
    } as unknown as JsonObject;

    const imported = importQbj(input);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.tournament.games[0]?.poolId).toBe('pool-a');
    expect(imported.value.tournament.scheduledGames[0]?.poolId).toBe('pool-a');
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
  test('protects string formula cells without changing numeric scores', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('  @lookup')).toBe("'  @lookup");
    expect(csvCell(-5)).toBe('-5');
  });

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
