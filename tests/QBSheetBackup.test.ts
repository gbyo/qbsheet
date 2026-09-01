import { describe, expect, test } from 'vitest';
import { openGameText, openGameValue } from '../src/game/OpenGameDefinition';
import { createQbsheetBackup, readQbsheetBackup, serializeQbsheetBackup } from '../src/scorer/QBSheetBackup';
import { roomClockVersion } from '../src/scorer/RoomClock';
import { validPackage } from './packages';
import { assignmentDocument } from './qbjDocuments';

const gamePackage = validPackage({ producer: 'QBSheet' });
const setup = {
  left: {
    name: gamePackage.left.name,
    players: gamePackage.left.players.map((player) => player.name),
  },
  right: {
    name: gamePackage.right.name,
    players: gamePackage.right.players.map((player) => player.name),
  },
};
const power = gamePackage.scorekeeperFormat.answerTypes.find((answerType) => answerType.value === 15)!;
const neg = gamePackage.scorekeeperFormat.answerTypes.find((answerType) => answerType.value === -5)!;
const buzz = {
  id: 'buzz-1',
  type: 'tossup-buzz' as const,
  questionNumber: 1,
  team: 'left' as const,
  playerName: gamePackage.left.players[0].name,
  answerTypeIndex: power.index,
};

describe('QBSheet backup format', () => {
  test('round-trips exact scoring state and freezes a running clock', () => {
    const backup = createQbsheetBackup({
      gamePackage,
      setup,
      events: [buzz],
      history: { undo: [1], redo: [] },
      clocks: {
        'half-1': {
          version: roomClockVersion,
          durationMs: 30 * 60 * 1000,
          status: 'running',
          accumulatedMs: 12_345,
          runningSince: 1,
        },
      },
      display: {
        mapping: { left: 'right', right: 'left' },
        seating: {
          left: [gamePackage.left.players[1].name, gamePackage.left.players[0].name],
          right: [gamePackage.right.players[0].name],
        },
      },
    });

    const serialized = serializeQbsheetBackup(backup);
    const parsed = readQbsheetBackup(JSON.parse(serialized));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.package).toEqual(gamePackage);
    expect(parsed.value.setup).toEqual(setup);
    expect(parsed.value.events).toEqual([buzz]);
    expect(parsed.value.history).toEqual({ undo: [1], redo: [] });
    expect(parsed.value.clocks?.['half-1']).toEqual({
      version: roomClockVersion,
      durationMs: 30 * 60 * 1000,
      status: 'paused',
      accumulatedMs: 12_345,
      pauseReason: 'manual',
    });
    expect(parsed.value.displaySideMapping).toEqual({
      version: 1,
      mapping: { left: 'right', right: 'left' },
    });
    expect(parsed.value.playerSeating).toEqual({
      left: [gamePackage.left.players[1].name, gamePackage.left.players[0].name],
      right: [gamePackage.right.players[0].name],
    });
  });

  test('the allowlist strips credentials and unrelated fields', () => {
    const unsafePackage = {
      ...gamePackage,
      room: { ...gamePackage.room, secretToken: 'room-token', serverAddress: 'https://private.invalid' },
      sessionToken: 'session-token',
    } as typeof gamePackage & Record<string, unknown>;
    const unsafeEvent = { ...buzz, deviceId: 'browser-id', authorization: 'Bearer secret' };
    const serialized = serializeQbsheetBackup(
      createQbsheetBackup({
        gamePackage: unsafePackage,
        setup,
        events: [unsafeEvent],
      }),
    );

    expect(serialized).not.toMatch(
      /token|authorization|device|serverAddress|sessionToken|gameKey|localStorage/i,
    );
    expect(serialized).toContain('qbsheet-backup');
    expect(serialized).toContain('"version": 1');
  });

  test('the ordinary open-file reader routes a backup without a second import mode', () => {
    const text = serializeQbsheetBackup(createQbsheetBackup({ gamePackage, setup, events: [buzz] }));
    const opened = openGameText(text);
    expect(opened).toMatchObject({ ok: true, kind: 'backup' });
    expect(openGameValue(JSON.parse(text))).toMatchObject({ ok: true, kind: 'backup' });
    // A normal QBJ document still takes the established QBJ path; adding the backup discriminator
    // does not make the ordinary assignment parser disappear.
    expect(openGameValue(assignmentDocument())).toMatchObject({ ok: true, kind: 'game' });
  });

  test('recovers legacy reading markers without dropping the actual rulings', () => {
    const legacyEvents = [
      {
        id: 'legacy-neg',
        type: 'tossup-buzz' as const,
        questionNumber: 1,
        team: 'left' as const,
        playerName: gamePackage.left.players[0].name,
        answerTypeIndex: neg.index,
      },
      { id: 'legacy-resume', type: 'tossup-reading-resumed' as const, questionNumber: 1 },
      {
        id: 'legacy-rebound',
        type: 'tossup-buzz' as const,
        questionNumber: 1,
        team: 'right' as const,
        playerName: gamePackage.right.players[0].name,
        answerTypeIndex: power.index,
      },
    ];
    const parsed = readQbsheetBackup(
      JSON.parse(serializeQbsheetBackup(createQbsheetBackup({ gamePackage, setup, events: legacyEvents }))),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.events).toEqual(legacyEvents);
  });

  test('newer versions fail closed and corrupt JSON is rejected', () => {
    const backup = createQbsheetBackup({ gamePackage, setup, events: [] });
    expect(readQbsheetBackup({ ...backup, version: backup.version + 1 })).toEqual({
      ok: false,
      errors: [expect.stringContaining('newer version')],
    });
    expect(openGameText('{not json')).toEqual({ ok: false, errors: ['That file is not readable as JSON.'] });
  });

  test('missing or malformed auxiliary metadata does not hide usable events', () => {
    const backup = createQbsheetBackup({ gamePackage, setup, events: [buzz] });
    const parsed = readQbsheetBackup({
      ...backup,
      history: { undo: ['bad'], redo: [] },
      clocks: { 'half-1': { status: 'running', durationMs: 'bad' } },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.events).toEqual([buzz]);
    expect(parsed.value.history).toBeUndefined();
    expect(parsed.value.clocks).toBeUndefined();
  });

  test('drops malformed active clocks without discarding a valid idle clock', () => {
    const backup = createQbsheetBackup({ gamePackage, setup, events: [buzz] });
    const parsed = readQbsheetBackup({
      ...backup,
      clocks: {
        'half-1': {
          version: roomClockVersion - 1,
          durationMs: 60_000,
          status: 'running',
          accumulatedMs: 5_000,
          runningSince: 1,
        },
        'half-2': {
          version: roomClockVersion,
          durationMs: 60_000,
          status: 'idle',
          accumulatedMs: 0,
        },
      },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.clocks).toEqual({
      'half-2': {
        version: roomClockVersion,
        durationMs: 60_000,
        status: 'idle',
        accumulatedMs: 0,
      },
    });
  });

  test('preserves seating for a player added locally during the game', () => {
    const events = [
      { id: 'dead-1', type: 'tossup-dead' as const, questionNumber: 1 },
      {
        id: 'added-player',
        type: 'roster-add' as const,
        questionNumber: 2,
        team: 'left' as const,
        playerName: 'Taylor Morgan',
      },
    ];
    const backup = createQbsheetBackup({
      gamePackage,
      setup,
      events,
      display: {
        seating: {
          left: ['Taylor Morgan', gamePackage.left.players[0].name],
          right: [],
        },
      },
    });

    const parsed = readQbsheetBackup(JSON.parse(serializeQbsheetBackup(backup)));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.playerSeating?.left).toEqual(['Taylor Morgan', gamePackage.left.players[0].name]);
  });

  test('accepts roster-only edits made before the starting lineup is chosen', () => {
    const lineupPackage = {
      ...gamePackage,
      scorekeeperFormat: {
        ...gamePackage.scorekeeperFormat,
        players: { ...gamePackage.scorekeeperFormat.players, maximumActive: 2 },
      },
    };
    const preLineup = createQbsheetBackup({
      gamePackage: lineupPackage,
      setup,
      events: [
        {
          id: 'late-arrival',
          type: 'roster-add' as const,
          questionNumber: 1,
          team: 'left' as const,
          playerName: 'Taylor Morgan',
        },
      ],
    });

    const parsed = readQbsheetBackup(preLineup);

    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.events).toEqual(preLineup.events);
  });

  test('wrong kind and malformed or impossible event histories are refused', () => {
    const backup = createQbsheetBackup({ gamePackage, setup, events: [buzz] });
    expect(readQbsheetBackup({ ...backup, kind: 'not-qbsheet' })).toEqual({
      ok: false,
      errors: ['This is not a QBSheet backup.'],
    });
    expect(readQbsheetBackup({ ...backup, events: [{ ...buzz, type: 'unknown' }] })).toEqual({
      ok: false,
      errors: ['The QBSheet backup has a malformed event history. No scoring history was imported.'],
    });
    expect(
      readQbsheetBackup({
        ...backup,
        events: [buzz, { ...buzz, id: 'buzz-2' }],
      }),
    ).toEqual({
      ok: false,
      errors: ['The QBSheet backup contains an impossible event history. No scoring history was imported.'],
    });
  });
});
