import { describe, expect, test } from 'vitest';
import {
  normalizeScorerBuildPin,
  parseBuildManifest,
  roomScorerBuilds,
  roomScorerBuildStatus,
  scorerBuildFromResult,
  scorerBuildLabel,
  scorerBuildWarnings,
} from './scorerBuilds';
import type { StoredResult } from './persistence';

function stampedResult(matchId: string, version: string, commit: string, receivedAt: string): StoredResult {
  return {
    resultId: `result-${matchId}`,
    receivedAt,
    qbj: {
      version: '2.1.1',
      objects: [
        {
          type: 'Match',
          id: matchId,
          _qbtcp: { version: 1, scorer_build: { version, commit } },
        },
      ],
    },
  };
}

describe('build manifests', () => {
  test('a production manifest parses to a pin', () => {
    const parsed = parseBuildManifest('{"version":"0.1.0","commit":"a1b2c3d","builtAt":"2026-09-01"}');
    expect(parsed).toEqual({ ok: true, build: { version: '0.1.0', commit: 'a1b2c3d' } });
  });

  test('garbage manifests are refused, not pinned', () => {
    expect(parseBuildManifest('not json').ok).toBe(false);
    expect(parseBuildManifest('{"version":"","commit":"a1b2c3d"}').ok).toBe(false);
    expect(parseBuildManifest('{"version":"0.1.0"}').ok).toBe(false);
    expect(parseBuildManifest('x'.repeat(9000)).ok).toBe(false);
  });

  test('stored pins normalize strictly', () => {
    expect(
      normalizeScorerBuildPin({ version: '0.1.0', commit: 'a1b2c3d', pinnedAt: '2026-09-11T18:00:00Z' }),
    ).toEqual({ version: '0.1.0', commit: 'a1b2c3d', pinnedAt: '2026-09-11T18:00:00Z' });
    expect(normalizeScorerBuildPin({ version: '0.1.0', commit: 'a1b2c3d' })).toBeNull();
    expect(normalizeScorerBuildPin(null)).toBeNull();
  });

  test('labels match the scorer’s own one-line identifier', () => {
    expect(scorerBuildLabel({ version: '0.1.0', commit: 'a1b2c3d' })).toBe('0.1.0 · a1b2c3d');
    expect(scorerBuildLabel({ version: '0.1.0', commit: 'dev' })).toBe('0.1.0');
  });
});

describe('room build verification', () => {
  const rooms = [
    { id: 'room-1', name: 'Room 101', publishedMatchId: 'Match_1' },
    { id: 'room-2', name: 'Room 102', publishedMatchId: 'Match_2' },
    { id: 'room-3', name: 'Room 103', publishedMatchId: null },
  ];

  test('rooms map to their latest result’s stamp; rooms without results stay unverified', () => {
    const builds = roomScorerBuilds(
      [
        stampedResult('Match_1', '0.1.0', 'a1b2c3d', '2026-09-11T18:00:00Z'),
        stampedResult('Match_1', '0.1.0', 'e5f6a7b', '2026-09-11T18:05:00Z'),
      ],
      rooms,
    );
    expect(builds.find((entry) => entry.roomId === 'room-1')?.build).toEqual({
      version: '0.1.0',
      commit: 'e5f6a7b',
    });
    expect(builds.find((entry) => entry.roomId === 'room-1')?.hasResult).toBe(true);
    // No result for room 2, no match for room 3: both unverified, never assumed — and room 2
    // records that it has no result, so warnings cannot mistake it for a scored legacy game.
    expect(builds.find((entry) => entry.roomId === 'room-2')?.build).toBeNull();
    expect(builds.find((entry) => entry.roomId === 'room-2')?.hasResult).toBe(false);
    expect(builds.find((entry) => entry.roomId === 'room-3')?.build).toBeNull();
    expect(builds.find((entry) => entry.roomId === 'room-3')?.hasResult).toBe(false);
  });

  test('pre-stamp results read as unverified, not mismatched', () => {
    expect(scorerBuildFromResult({ version: '2.1.1', objects: [{ type: 'Match', id: 'm' }] })).toBeNull();
  });

  test('off-pin rooms, placeholders, and mixed fleets each warn distinctly', () => {
    const pin = { version: '0.1.0', commit: 'a1b2c3d', pinnedAt: '2026-09-11T18:00:00Z' };
    const warnings = scorerBuildWarnings({
      pin,
      rooms: [
        {
          roomId: 'room-1',
          roomName: 'Room 101',
          matchId: 'Match_1',
          hasResult: true,
          build: { version: '0.1.0', commit: 'a1b2c3d' },
        },
        {
          roomId: 'room-2',
          roomName: 'Room 102',
          matchId: 'Match_2',
          hasResult: true,
          build: { version: '0.1.0', commit: 'e5f6a7b' },
        },
        {
          roomId: 'room-3',
          roomName: 'Room 103',
          matchId: 'Match_3',
          hasResult: true,
          build: { version: '0.0.0', commit: 'dev' },
        },
        { roomId: 'room-4', roomName: 'Room 104', matchId: 'Match_4', hasResult: true, build: null },
        // Assigned but nothing scored yet: not-yet-observed, never a legacy warning.
        { roomId: 'room-5', roomName: 'Room 105', matchId: 'Match_5', hasResult: false, build: null },
      ],
    });
    expect(
      warnings.some((warning) => /Room 102.*0\.1\.0 · e5f6a7b.*pinned 0\.1\.0 · a1b2c3d/.test(warning)),
    ).toBe(true);
    expect(warnings.some((warning) => /Room 103.*non-release/.test(warning))).toBe(true);
    expect(warnings.some((warning) => /Room 104.*cannot be verified/.test(warning))).toBe(true);
    expect(warnings.some((warning) => /Room 105/.test(warning))).toBe(false);
    expect(warnings.some((warning) => /2 different Scorer builds/.test(warning))).toBe(true);
  });

  test('live heartbeats warn pre-game and on reload, never twice for the same build', () => {
    const pin = { version: '0.1.0', commit: 'a1b2c3d', pinnedAt: '2026-09-11T18:00:00Z' };
    const offPin = { version: '0.1.0', commit: 'e5f6a7b' };
    const onPin = { version: '0.1.0', commit: 'a1b2c3d' };
    const rooms = [
      // Assigned, nothing scored: the heartbeat is the only signal.
      { roomId: 'pre', roomName: 'Pre Game', matchId: 'Match_pre', hasResult: false, build: null },
      // Submitted on the pin, then reloaded onto the wrong build mid-tournament.
      { roomId: 'reloaded', roomName: 'Reloaded', matchId: 'Match_rel', hasResult: true, build: onPin },
      // Submitted off-pin and still live on it: the result warning already speaks.
      { roomId: 'same', roomName: 'Same', matchId: 'Match_same', hasResult: true, build: offPin },
      // Live on the pin: quiet.
      { roomId: 'quiet', roomName: 'Quiet', matchId: 'Match_q', hasResult: false, build: null },
    ] as const;
    const warnings = scorerBuildWarnings({
      pin,
      rooms: [...rooms],
      liveBuilds: new Map([
        ['pre', offPin],
        ['reloaded', offPin],
        ['same', offPin],
        ['quiet', onPin],
      ]),
    });
    expect(warnings.some((warning) => /Pre Game.*currently runs 0\.1\.0 · e5f6a7b/.test(warning))).toBe(true);
    expect(warnings.some((warning) => /Reloaded.*currently runs 0\.1\.0 · e5f6a7b/.test(warning))).toBe(true);
    // The already-known off-pin result warns once (plus the fleet line); the live heartbeat
    // saying the same thing adds no second per-room warning.
    expect(warnings.filter((warning) => /Same.*pinned 0\.1\.0/.test(warning))).toHaveLength(1);
    expect(warnings.some((warning) => /Same.*currently runs/.test(warning))).toBe(false);
    expect(warnings.some((warning) => /Quiet/.test(warning))).toBe(false);

    // A live placeholder build is named even though it can never equal a pin.
    const placeholder = scorerBuildWarnings({
      pin,
      rooms: [{ roomId: 'dev', roomName: 'Dev Room', matchId: 'Match_dev', hasResult: false, build: null }],
      liveBuilds: new Map([['dev', { version: '0.0.0', commit: 'dev' }]]),
    });
    expect(placeholder.some((warning) => /Dev Room.*non-release/.test(warning))).toBe(true);

    // Without a pin there is nothing to compare a heartbeat against.
    expect(
      scorerBuildWarnings({
        pin: null,
        rooms: [{ roomId: 'pre', roomName: 'Pre Game', matchId: 'Match_pre', hasResult: false, build: null }],
        liveBuilds: new Map([['pre', offPin]]),
      }),
    ).toEqual([]);
  });

  test('per-room status names stamped, legacy, and not-yet-observed states', () => {
    expect(
      roomScorerBuildStatus({
        roomId: 'r1',
        roomName: 'Room 101',
        matchId: 'Match_1',
        hasResult: true,
        build: { version: '0.1.0', commit: 'a1b2c3d' },
      }),
    ).toBe('0.1.0 · a1b2c3d');
    expect(
      roomScorerBuildStatus({
        roomId: 'r4',
        roomName: 'Room 104',
        matchId: 'Match_4',
        hasResult: true,
        build: null,
      }),
    ).toMatch(/no build stamp/);
    expect(
      roomScorerBuildStatus({
        roomId: 'r5',
        roomName: 'Room 105',
        matchId: 'Match_5',
        hasResult: false,
        build: null,
      }),
    ).toMatch(/not yet observed/);
  });

  test('a clean pinned fleet is quiet', () => {
    const pin = { version: '0.1.0', commit: 'a1b2c3d', pinnedAt: '2026-09-11T18:00:00Z' };
    expect(
      scorerBuildWarnings({
        pin,
        rooms: [
          {
            roomId: 'room-1',
            roomName: 'Room 101',
            matchId: 'Match_1',
            hasResult: true,
            build: { version: '0.1.0', commit: 'a1b2c3d' },
          },
          // Assigned but unscored rooms stay quiet too: not-yet-observed is display, not alarm.
          { roomId: 'room-2', roomName: 'Room 102', matchId: 'Match_2', hasResult: false, build: null },
        ],
      }),
    ).toEqual([]);
  });
});
