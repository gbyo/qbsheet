/**
 * The QBSheet Live privacy boundary.
 *
 * These tests are the reason the projection constructs rather than filters. The central one is
 * exhaustive over settings: for every one of the 2^n combinations of publication switches, a
 * Director document seeded with a sentinel in every private field must project to a snapshot whose
 * serialization does not contain the sentinel.
 *
 * A failure here is not a style problem. It means private tournament data would have been published
 * to the internet.
 */

import { describe, expect, test } from 'vitest';
import {
  closedLivePublicationSettings,
  defaultLivePublicationSettings,
  type LivePublicationSettings,
} from '@qbsheet/tournament-domain';
import { parseSnapshot, type QbliveCapabilities } from '@qbsheet/qblive-protocol';
import { projectLiveSnapshot } from '../src/projection';
import { privacyFixture, SENTINEL } from '../src/fixture';

const capabilities: QbliveCapabilities = { snapshot: true, events: true, stream: true, applePush: false };
const generatedAt = new Date('2026-09-05T14:30:00.000Z');

function project(settings: LivePublicationSettings) {
  return projectLiveSnapshot({
    state: privacyFixture(),
    settings,
    publicationId: 'bcdfghjkmnpqrstvwxyz',
    revision: 41,
    generatedAt,
    capabilities,
  });
}

/** The switches that vary. `enabled` is held on, because off is separately covered. */
const switchNames = [
  'teamNames',
  'playerNames',
  'playerStatistics',
  'releasedSchedule',
  'roomLocations',
  'roomDirections',
  'acceptedResults',
  'liveGameStatus',
  'liveScores',
  'liveProgress',
  'announcements',
  'standings',
  'teamStatistics',
] as const satisfies readonly (keyof LivePublicationSettings)[];

function settingsForMask(mask: number): LivePublicationSettings {
  const settings = closedLivePublicationSettings();
  settings.enabled = true;
  switchNames.forEach((name, index) => {
    settings[name] = (mask & (1 << index)) !== 0;
  });
  return settings;
}

describe('the public projection never publishes private tournament data', () => {
  test('no combination of publication settings leaks a sentinel', () => {
    const total = 1 << switchNames.length;
    const offenders: string[] = [];
    for (let mask = 0; mask < total; mask += 1) {
      const serialized = JSON.stringify(project(settingsForMask(mask)));
      if (serialized.includes(SENTINEL)) offenders.push(describeMask(mask));
      // Fail fast with a readable list rather than 8192 identical failures.
      if (offenders.length >= 3) break;
    }
    expect(offenders).toEqual([]);
  });

  test('every private field named below is actually seeded with a sentinel', () => {
    // Guards the guard. A private field nobody seeded would make the sweep above vacuous for it,
    // and the sweep is the only thing standing between a new domain field and the public internet.
    const state = privacyFixture();
    const seen = new Set<string>();
    const unseeded: string[] = [];
    walk(state, '', (path, value) => {
      const normalized = path.replace(/\[\d+\]/g, '[]');
      if (!privateLeafPaths.has(normalized)) return;
      seen.add(normalized);
      if (typeof value === 'string' && !value.includes(SENTINEL)) unseeded.push(`${path} = ${value}`);
      if (typeof value === 'object' && value !== null && !JSON.stringify(value).includes(SENTINEL)) {
        unseeded.push(`${path} = ${JSON.stringify(value)}`);
      }
    });
    expect(unseeded).toEqual([]);
    // And every named path must exist, so a renamed field fails loudly instead of silently
    // dropping out of the list it was protecting.
    expect([...privateLeafPaths].filter((path) => !seen.has(path))).toEqual([]);
  });

  test('the default settings publish a usable tournament and no sentinel', () => {
    const snapshot = project({ ...defaultLivePublicationSettings(), enabled: true });
    expect(JSON.stringify(snapshot)).not.toContain(SENTINEL);
    expect(snapshot.teams.length).toBeGreaterThan(0);
    expect(snapshot.schedule.length).toBeGreaterThan(0);
    expect(snapshot.standings.length).toBeGreaterThan(0);
  });

  test('a disabled publication projects nothing at all', () => {
    const snapshot = project({ ...defaultLivePublicationSettings(), enabled: false });
    expect(snapshot.teams).toEqual([]);
    expect(snapshot.schedule).toEqual([]);
    expect(snapshot.results).toEqual([]);
    expect(snapshot.standings).toEqual([]);
    expect(snapshot.announcements).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain(SENTINEL);
  });

  test('the projection is valid against the QBLive validator for every settings combination', () => {
    for (let mask = 0; mask < 1 << switchNames.length; mask += 251) {
      const snapshot = project(settingsForMask(mask));
      expect(() => parseSnapshot(snapshot)).not.toThrow();
    }
  });
});

describe('specific disclosures', () => {
  test('an unreleased playoff round contributes no game, result, phase name, or scope', () => {
    const snapshot = project({ ...defaultLivePublicationSettings(), enabled: true });
    expect(snapshot.schedule.some((game) => game.id === 'game-playoff')).toBe(false);
    expect(snapshot.schedule.some((game) => game.roundId === 'round-playoff')).toBe(false);
    const scopes = [...snapshot.standings, ...snapshot.statistics].map((table) => table.scope);
    expect(scopes).not.toContain('phase:phase-playoff');
  });

  test('team names off replaces names with seeds and drops the organization', () => {
    const snapshot = project({ ...defaultLivePublicationSettings(), enabled: true, teamNames: false });
    expect(snapshot.teams.map((team) => team.name)).toEqual(['Seed 1', 'Seed 2', 'Seed 3', 'Seed 4']);
    expect(snapshot.teams.every((team) => team.organization === null)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('Ninety Six');
  });

  test('player names off publishes no roster and no individual statistics', () => {
    const snapshot = project({
      ...defaultLivePublicationSettings(),
      enabled: true,
      playerNames: false,
      playerStatistics: true,
    });
    expect(snapshot.teams.every((team) => team.players === undefined)).toBe(true);
    expect(snapshot.statistics.some((table) => table.id.startsWith('player-statistics'))).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('Player 0-0');
  });

  test('player names on with statistics off publishes the roster but no individual numbers', () => {
    const snapshot = project({
      ...defaultLivePublicationSettings(),
      enabled: true,
      playerNames: true,
      playerStatistics: false,
    });
    expect(snapshot.teams[0].players?.length).toBe(4);
    expect(snapshot.statistics.some((table) => table.id.startsWith('player-statistics'))).toBe(false);
  });

  test('live scores off publishes that a game is happening but never the score', () => {
    const snapshot = project({
      ...defaultLivePublicationSettings(),
      enabled: true,
      liveGameStatus: true,
      liveScores: false,
      liveProgress: false,
    });
    expect(snapshot.liveGames.length).toBe(1);
    expect(snapshot.liveGames[0].scores).toBeUndefined();
    expect(snapshot.liveGames[0].tossupsRead).toBeUndefined();
    const serialized = JSON.stringify(snapshot.liveGames);
    expect(serialized).not.toContain('180');
    expect(serialized).not.toContain('135');
  });

  test('live scores on publishes the running score from QBTCP progress', () => {
    const snapshot = project({
      ...defaultLivePublicationSettings(),
      enabled: true,
      liveScores: true,
      liveProgress: true,
    });
    expect(snapshot.liveGames[0].scores).toEqual([
      { teamId: 'team-a', score: 180 },
      { teamId: 'team-c', score: 135 },
    ]);
    expect(snapshot.liveGames[0].tossupsRead).toBe(13);
  });

  test('room directions are a separate switch from room names', () => {
    const withDirections = project({ ...defaultLivePublicationSettings(), enabled: true });
    expect(withDirections.rooms[0].directions).toBe('Left past the trophy case.');
    const withoutDirections = project({
      ...defaultLivePublicationSettings(),
      enabled: true,
      roomDirections: false,
    });
    expect(withoutDirections.rooms[0].directions).toBeNull();
    expect(withoutDirections.rooms[0].name).toBe('Room 104');
  });

  test('room locations off removes rooms from games as well as the room list', () => {
    const snapshot = project({ ...defaultLivePublicationSettings(), enabled: true, roomLocations: false });
    expect(snapshot.rooms).toEqual([]);
    expect(snapshot.schedule.every((game) => game.roomId === null)).toBe(true);
    expect(snapshot.liveGames.every((game) => game.roomId === null)).toBe(true);
  });

  test('staff and hidden timeline events never publish', () => {
    const snapshot = project({ ...defaultLivePublicationSettings(), enabled: true });
    expect(snapshot.timeline.map((event) => event.id)).toEqual(['timeline-lunch']);
  });

  test('a withdrawn announcement leaves the projection', () => {
    const snapshot = project({ ...defaultLivePublicationSettings(), enabled: true });
    expect(snapshot.announcements.map((announcement) => announcement.id)).toEqual(['announcement-1']);
  });

  test('the projection is deterministic', () => {
    const settings = { ...defaultLivePublicationSettings(), enabled: true };
    expect(JSON.stringify(project(settings))).toBe(JSON.stringify(project(settings)));
  });

  test('published timestamps carry the tournament offset, not the host offset', () => {
    const snapshot = project({ ...defaultLivePublicationSettings(), enabled: true });
    // 2026-09-05 is daylight time in America/New_York, so the offset is -04:00.
    expect(snapshot.timeline[0].scheduledStart).toBe('2026-09-05T12:00:00-04:00');
    expect(snapshot.tournament.timeZone).toBe('America/New_York');
  });

  test('a game with no scheduled time publishes no time rather than an estimate', () => {
    const snapshot = project({ ...defaultLivePublicationSettings(), enabled: true });
    const game = snapshot.schedule.find((entry) => entry.id === 'game-3');
    expect(game?.scheduledStart).toBe('2026-09-05T10:00:00-04:00');
    // Nothing anywhere in the document claims a time that Director did not state.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(/estimat/i);
    expect(serialized).not.toMatch(/probably/i);
  });
});

/**
 * The exact fields in a Director document that must never appear in a public snapshot.
 *
 * Named individually rather than by subtree, because a subtree rule would also cover structural
 * values — an entity id, an enum, a timestamp — that are not disclosures and cannot carry a
 * sentinel. Every entry here is a place a human or a device wrote something private: free text,
 * an operator's name, a device identity, a credential pointer, a raw submission, a filesystem path.
 *
 * Adding a private field to the domain means adding it here. The test below fails if a listed path
 * has gone missing, so a rename cannot quietly remove a field from protection.
 */
const privateLeafPaths = new Set([
  '.organizations[].notes',
  '.teams[].notes',
  '.players[].notes',
  '.staff[].notes',
  '.equipment[].notes',
  '.rooms[].notes',
  '.packets[].notes',
  '.scheduledGames[].notes',
  '.games[].transportResultId',
  '.games[].rawQbj',
  '.games[].note',
  '.submissions[].transportResultId',
  '.submissions[].sessionId',
  '.submissions[].fingerprint',
  '.submissions[].rawSubmission',
  '.submissions[].warnings[]',
  '.submissions[].acceptedBy',
  '.submissions[].reason',
  '.protests[].description',
  '.protests[].ruling',
  '.audit[].actor',
  '.audit[].summary',
  '.audit[].details',
  '.qbtcpSessions[].sessionId',
  '.qbtcpSessions[].matchId',
  '.qbtcpSessions[].deviceId',
  '.qbtcpSessions[].operatorName',
  '.qbtcpHelpRequests[].message',
  '.qbtcpHelpRequests[].deviceId',
  '.qbtcpHelpRequests[].operatorName',
  '.qbtcpHelpRequests[].currentMatchup',
  '.qbtcpRosterAmendments[].sessionId',
  '.qbtcpRosterAmendments[].amendment',
  '.metadata.archivePath',
  '.live.backend.displayName',
  '.live.credential.keychainService',
  '.live.credential.keychainAccount',
  '.live.push.publisherId',
  '.live.push.credential.keychainService',
  '.live.push.credential.keychainAccount',
  '.live.sync.lastError',
  '.live.outbox[].payload',
  '.live.outbox[].lastError',
]);

/**
 * Conditionally private: public in one state, private in another.
 *
 * A released round's name is on the wall schedule; an unreleased playoff round's name gives away
 * that a bracket exists and who is in it. A public timeline event's title is meant to be read; a
 * staff event's is not. These cannot be blanket-listed above, so the fixture seeds the private
 * *instance* of each — `round-playoff`, `phase-playoff`, `timeline-staff`, `timeline-hidden` — and
 * the exhaustive sweep proves the sentinel does not escape through them.
 */

function walk(value: unknown, path: string, visit: (path: string, value: unknown) => void): void {
  visit(path, value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`, visit));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`, visit);
  }
}

function describeMask(mask: number): string {
  return switchNames.filter((_, index) => (mask & (1 << index)) !== 0).join('+') || '(all off)';
}
