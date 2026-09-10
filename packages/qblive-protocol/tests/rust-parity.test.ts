/**
 * The Rust core must enforce the same bounds as the TypeScript validators.
 *
 * `crates/qblive-server/src/protocol.rs` mirrors `qbliveLimits` from
 * `../src/validate.ts`. A number changed on one side and not the other is a
 * validator/limit drift that fixtures alone would not catch, so this test
 * reads the Rust source and asserts every bound matches.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { qbliveLimits } from '../src/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const rust = readFileSync(
  resolve(here, '..', '..', '..', 'crates', 'qblive-server', 'src', 'protocol.rs'),
  'utf8',
);

function rustConst(name: string): number {
  const match = new RegExp(`pub const ${name}:\\s*usize\\s*=\\s*([^;]+);`).exec(rust);
  if (!match) throw new Error(`missing Rust constant ${name}`);
  const expression = match[1].trim();
  // The Rust source writes `8 * 1024 * 1024` for the body limit.
  const value = Function(`"use strict"; return (${expression});`)() as number;
  if (!Number.isInteger(value)) throw new Error(`non-integer Rust constant ${name}`);
  return value;
}

describe('the Rust core enforces the same bounds', () => {
  test.each([
    ['MAX_TEAMS', qbliveLimits.maxTeams],
    ['MAX_PLAYERS_PER_TEAM', qbliveLimits.maxPlayersPerTeam],
    ['MAX_ROOMS', qbliveLimits.maxRooms],
    ['MAX_SCHEDULE_ENTRIES', qbliveLimits.maxScheduleEntries],
    ['MAX_RESULTS', qbliveLimits.maxResults],
    ['MAX_LIVE_GAMES', qbliveLimits.maxLiveGames],
    ['MAX_TIMELINE_EVENTS', qbliveLimits.maxTimelineEvents],
    ['MAX_TABLES', qbliveLimits.maxTables],
    ['MAX_TABLE_ROWS', qbliveLimits.maxTableRows],
    ['MAX_TABLE_COLUMNS', qbliveLimits.maxTableColumns],
    ['MAX_ANNOUNCEMENTS', qbliveLimits.maxAnnouncements],
    ['MAX_STRING_LENGTH', qbliveLimits.maxStringLength],
    ['MAX_BODY_BYTES', qbliveLimits.maxBodyBytes],
    ['MAX_EVENTS_PER_PAGE', qbliveLimits.maxEventsPerPage],
  ] as const)('%s matches qbliveLimits', (name, expected) => {
    expect(rustConst(name)).toBe(expected);
  });

  test('the protocol version matches', () => {
    expect(/pub const PROTOCOL_VERSION:\s*i64\s*=\s*1;/.test(rust)).toBe(true);
  });

  test('the section names match', () => {
    for (const section of [
      'tournament',
      'teams',
      'rooms',
      'timeline',
      'schedule',
      'results',
      'liveGames',
      'standings',
      'statistics',
      'announcements',
    ]) {
      expect(rust).toContain(`"${section}"`);
    }
  });
});
