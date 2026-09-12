/**
 * Manifest parsing and project layout: small, strict, and honest about bad input.
 */

import { describe, expect, test } from 'vitest';
import {
  createManifest,
  manifestFileContents,
  parseManifest,
  resolveManifestOnLoad,
  roomDisplayName,
} from './manifest';
import {
  assignmentFileName,
  importFolderName,
  projectDirectories,
  sanitizeFileSegment,
  uniqueFileName,
} from './project';
import { ROOM_SLOTS } from './schedule';

describe('the manifest', () => {
  test('round-trips through its file bytes', () => {
    const manifest = createManifest({
      tournamentId: 'Tournament_X',
      tournamentName: 'Wildcat',
      tournamentFingerprint: 'abc123',
      rooms: ROOM_SLOTS.map((slot) => ({ slotId: slot.id, displayName: slot.defaultName })),
    });
    manifest.assignments.push({
      matchId: 'm1',
      roundNumber: 1,
      roundId: 'r1',
      slotId: 'slot-gold-1',
      leftTeamId: 'a',
      rightTeamId: 'b',
      fileName: 'R01.qbj',
    });
    manifest.selectedResults['m1'] = 'game-b.qbj';
    manifest.preparedRounds.push(1);
    const parsed = parseManifest(manifestFileContents(manifest));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.manifest).toEqual(manifest);
  });

  test('rejects garbage with specific messages', () => {
    expect(parseManifest('nope').ok).toBe(false);
    expect(parseManifest('[]').ok).toBe(false);
    const wrong = parseManifest(JSON.stringify({ version: 999 }));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toMatch(/different version/);
    const empty = parseManifest(JSON.stringify({ version: 1 }));
    expect(empty.ok).toBe(false);
  });

  test('reloading the same tournament keeps the project; a different one starts fresh', () => {
    const manifest = createManifest({
      tournamentId: 'Tournament_X',
      tournamentName: 'Wildcat',
      tournamentFingerprint: 'abc123',
      rooms: [],
    });
    manifest.selectedResults['m1'] = 'game-b.qbj';
    const kept = resolveManifestOnLoad(manifest, 'Tournament_X');
    expect(kept.keep).toBe(true);
    if (kept.keep) expect(kept.manifest.selectedResults['m1']).toBe('game-b.qbj');
    expect(resolveManifestOnLoad(manifest, 'Tournament_Other')).toEqual({ keep: false });
    expect(resolveManifestOnLoad(null, 'Tournament_X')).toEqual({ keep: false });
  });

  test('never carries results, credentials, or browser state', () => {
    const manifest = createManifest({
      tournamentId: 't',
      tournamentName: 'n',
      tournamentFingerprint: 'f',
      rooms: [],
    });
    const text = manifestFileContents(manifest);
    for (const word of ['points', 'token', 'credential', 'standings', 'Bearer']) {
      expect(text.toLowerCase()).not.toContain(word);
    }
    expect(roomDisplayName(manifest, 'slot-gold-1')).toBe('slot-gold-1');
  });
});

describe('project layout', () => {
  test('creates six room folders with IN/OUT plus eight import rounds', () => {
    const dirs = projectDirectories(['315', '317', '318', '319', '320', '321'], [1, 2, 3, 4, 5, 6, 7, 8]);
    expect(dirs).toHaveLength(20);
    expect(dirs).toContain('319/IN');
    expect(dirs).toContain('319/OUT');
    expect(dirs).toContain('YellowFruit Import/Round 1');
    expect(dirs).toContain('YellowFruit Import/Round 8');
    expect(new Set(dirs).size).toBe(20);
  });

  test('works with customized room names', () => {
    const dirs = projectDirectories(['Library', 'Cafeteria'], [1]);
    expect(dirs).toContain('Library/IN');
    expect(dirs).toContain('Cafeteria/OUT');
    expect(importFolderName(3)).toBe('Round 3');
  });

  test('filenames are readable, safe, and never load-bearing', () => {
    expect(
      assignmentFileName({
        roundNumber: 1,
        roomName: '319',
        leftTeamName: 'Clinton',
        rightTeamName: 'Wren B',
      }),
    ).toBe('R01 - 319 - Clinton vs Wren B.qbj');
    // A separator in a team name becomes a hyphen, never a directory.
    const tricky = assignmentFileName({
      roundNumber: 2,
      roomName: '319',
      leftTeamName: 'A/B',
      rightTeamName: 'C:D',
    });
    expect(tricky).not.toContain('/');
    expect(tricky.endsWith('.qbj')).toBe(true);
    expect(sanitizeFileSegment('CON')).toBe('_CON');
    expect(sanitizeFileSegment('  ')).toBe('file');
  });

  test('taken names get a suffix instead of an overwrite', () => {
    expect(uniqueFileName('a.qbj', new Set())).toBe('a.qbj');
    expect(uniqueFileName('a.qbj', new Set(['a.qbj']))).toBe('a (2).qbj');
    expect(uniqueFileName('a.qbj', new Set(['a.qbj', 'a (2).qbj']))).toBe('a (3).qbj');
  });
});
