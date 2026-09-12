/**
 * Manifest parsing and project layout: small, strict, and honest about bad input.
 */

import { describe, expect, test } from 'vitest';
import {
  createManifest,
  manifestFileContents,
  openProjectFromManifest,
  parseManifest,
  partitionWrittenGames,
  resolveManifestOnLoad,
  roomDisplayName,
} from './manifest';
import {
  assignmentFileName,
  importFolderName,
  projectDirectories,
  sanitizeFileSegment,
  uniqueFileName,
  validateRoomNames,
} from './project';
import { ROOM_SLOTS } from './schedule';

describe('the manifest', () => {
  test('round-trips through its file bytes', () => {
    const manifest = createManifest({
      tournamentId: 'Tournament_X',
      tournamentName: 'Wildcat',
      tournamentFingerprint: 'abc123',
      rooms: ROOM_SLOTS.map((slot) => ({
        slotId: slot.id,
        displayName: slot.defaultName,
        folderName: slot.defaultName,
      })),
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

  test('a corrupt assignment rejects the project instead of loading half a game', () => {
    const good = {
      matchId: 'm1',
      roundNumber: 1,
      roundId: 'r1',
      slotId: 'slot-gold-1',
      leftTeamId: 'a',
      rightTeamId: 'b',
      fileName: 'R01.qbj',
    };
    const manifest = createManifest({
      tournamentId: 'Tournament_X',
      tournamentName: 'Wildcat',
      tournamentFingerprint: 'abc123',
      rooms: [],
    });
    const withAssignments = (assignments: unknown[]) =>
      parseManifest(
        JSON.stringify({ ...JSON.parse(manifestFileContents(manifest)), assignments }),
      );
    // The whole record parses.
    expect(withAssignments([good]).ok).toBe(true);
    // Each required field, missing or mistyped, names the record and the field.
    const { slotId: _noSlot, ...noSlot } = good;
    const { rightTeamId: _noRight, ...noRight } = good;
    void _noSlot;
    void _noRight;
    const cases: [string, unknown][] = [
      ['matchId', { ...good, matchId: '' }],
      ['roundNumber', { ...good, roundNumber: 0 }],
      ['roundNumber', { ...good, roundNumber: 1.5 }],
      ['roundNumber', { ...good, roundNumber: '1' }],
      ['roundId', { ...good, roundId: '' }],
      ['slotId', noSlot],
      ['leftTeamId', { ...good, leftTeamId: '' }],
      ['rightTeamId', noRight],
      ['fileName', { ...good, fileName: '' }],
      ['source', { ...good, source: 'preset' }],
    ];
    for (const [field, broken] of cases) {
      const parsed = withAssignments([broken]);
      expect(parsed.ok, field).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toMatch(/assignment 1 is corrupt/);
        expect(parsed.error).toMatch(new RegExp(field));
      }
    }
    // The record index points at the bad one, not the first.
    const parsed = withAssignments([good, { ...good, matchId: 'm2', fileName: '' }]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/assignment 2 is corrupt/);
  });

  test('retention needs the event id and the team/seed fingerprint', () => {
    const manifest = createManifest({
      tournamentId: 'Tournament_X',
      tournamentName: 'Wildcat',
      tournamentFingerprint: 'abc123',
      rooms: [],
    });
    manifest.selectedResults['m1'] = 'game-b.qbj';
    const kept = resolveManifestOnLoad(manifest, 'Tournament_X', 'abc123');
    expect(kept.keep).toBe(true);
    if (kept.keep) expect(kept.manifest.selectedResults['m1']).toBe('game-b.qbj');
    // A different tournament never inherits the project.
    expect(resolveManifestOnLoad(manifest, 'Tournament_Other', 'abc123')).toEqual({
      keep: false,
      reason: 'different',
    });
    expect(resolveManifestOnLoad(null, 'Tournament_X', 'abc123')).toEqual({
      keep: false,
      reason: 'different',
    });
    // Same id but changed teams/seeds: the assignments were built for another shape.
    expect(resolveManifestOnLoad(manifest, 'Tournament_X', 'changed')).toEqual({
      keep: false,
      reason: 'drifted',
    });
  });

  test('only written-or-identical games enter the manifest, keyed by Match id', () => {
    const planned = [
      { matchId: 'm1', roundNumber: 1, roundId: 'r1', slotId: 's1', leftTeamId: 'a', rightTeamId: 'b', fileName: 'f1' },
      { matchId: 'm2', roundNumber: 1, roundId: 'r1', slotId: 's2', leftTeamId: 'c', rightTeamId: 'd', fileName: 'f2' },
      { matchId: 'm3', roundNumber: 2, roundId: 'r2', slotId: 's1', leftTeamId: 'a', rightTeamId: 'c', fileName: 'f3' },
    ];
    const { entries, conflicts } = partitionWrittenGames(planned, { m1: 'written', m2: 'identical', m3: 'conflicted' });
    expect(entries.map((entry) => entry.matchId)).toEqual(['m1', 'm2']);
    // Exactly the conflicted game is reported — the rest of round 1 is intact.
    expect(conflicts).toEqual([{ roundNumber: 2, slotId: 's1', matchId: 'm3' }]);
  });

  test('reopening needs no session: matching YFT accepted, others rejected', () => {
    const manifest = createManifest({
      tournamentId: 'Tournament_X',
      tournamentName: 'Wildcat',
      tournamentFingerprint: 'abc123',
      rooms: [{ slotId: 's1', displayName: '319', folderName: '319' }],
    });
    manifest.selectedResults['m1'] = '319/a.qbj#deadbeef';
    manifest.playoffSlots = { F1: 't1' };
    const text = manifestFileContents(manifest);

    const noYft = openProjectFromManifest(text);
    expect(noYft.ok).toBe(true);
    if (noYft.ok) {
      expect(noYft.needsYft).toBe(true);
      expect(noYft.manifest.selectedResults['m1']).toBe('319/a.qbj#deadbeef');
      expect(noYft.manifest.playoffSlots).toEqual({ F1: 't1' });
    }
    expect(openProjectFromManifest(text, 'Tournament_X').ok).toBe(true);
    const wrong = openProjectFromManifest(text, 'Tournament_Other');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toMatch(/different tournament/);
    expect(openProjectFromManifest('not json').ok).toBe(false);
    expect(openProjectFromManifest(JSON.stringify({ version: 999 })).ok).toBe(false);
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

  test('room names are trimmed, safe, and unique as folders', () => {
    const slots = ['s1', 's2', 's3'];
    const good = validateRoomNames({ s1: ' 319 ', s2: '320', s3: 'Library' }, slots);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.value.rooms[0]).toEqual({ slotId: 's1', displayName: '319', folderName: '319' });
    }
    expect(validateRoomNames({ s1: '', s2: '320', s3: '321' }, slots).ok).toBe(false);
    expect(validateRoomNames({ s1: '..', s2: '320', s3: '321' }, slots).ok).toBe(false);
    // Separators cannot nest: both collapse to one folder and collide.
    expect(validateRoomNames({ s1: 'A/B', s2: 'A-B', s3: '321' }, slots).ok).toBe(false);
    expect(validateRoomNames({ s1: '319', s2: '319', s3: '321' }, slots).ok).toBe(false);
    expect(validateRoomNames({ s1: 'Room', s2: 'ROOM', s3: '321' }, slots).ok).toBe(false);
    // Slot ids pass through: identity never depends on the display name.
    const renamed = validateRoomNames({ s1: 'Gym', s2: '320', s3: '321' }, slots);
    if (renamed.ok) expect(renamed.value.rooms[0].slotId).toBe('s1');
  });
});
