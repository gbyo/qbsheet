import { describe, expect, test } from 'vitest';
import {
  normalizeScorerBuildPin,
  parseBuildManifest,
  roomScorerBuilds,
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
    // No result for room 2, no match for room 3: both unverified, never assumed.
    expect(builds.find((entry) => entry.roomId === 'room-2')?.build).toBeNull();
    expect(builds.find((entry) => entry.roomId === 'room-3')?.build).toBeNull();
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
          build: { version: '0.1.0', commit: 'a1b2c3d' },
        },
        {
          roomId: 'room-2',
          roomName: 'Room 102',
          matchId: 'Match_2',
          build: { version: '0.1.0', commit: 'e5f6a7b' },
        },
        {
          roomId: 'room-3',
          roomName: 'Room 103',
          matchId: 'Match_3',
          build: { version: '0.0.0', commit: 'dev' },
        },
        { roomId: 'room-4', roomName: 'Room 104', matchId: 'Match_4', build: null },
      ],
    });
    expect(
      warnings.some((warning) => /Room 102.*0\.1\.0 · e5f6a7b.*pinned 0\.1\.0 · a1b2c3d/.test(warning)),
    ).toBe(true);
    expect(warnings.some((warning) => /Room 103.*non-release/.test(warning))).toBe(true);
    expect(warnings.some((warning) => /Room 104.*cannot be verified/.test(warning))).toBe(true);
    expect(warnings.some((warning) => /2 different Scorer builds/.test(warning))).toBe(true);
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
            build: { version: '0.1.0', commit: 'a1b2c3d' },
          },
        ],
      }),
    ).toEqual([]);
  });
});
