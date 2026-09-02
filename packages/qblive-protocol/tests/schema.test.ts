/**
 * The three descriptions of QBLive must agree.
 *
 * QBLive exists in three places: the TypeScript types and validators in `../src`, the JSON Schema
 * in `../schemas`, and the Swift `Codable` types in `ios/QBSheetLiveKit`. Nothing stops those from
 * drifting except tests that read the same fixtures. This file is the TypeScript half; the Swift
 * package's `QBLiveFixtureTests` is the other, and both read `../fixtures`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  applyEvent,
  parseEventPage,
  parseManifest,
  parseSnapshot,
  QbliveValidationError,
  qbliveSectionNames,
} from '../src/index.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const schema = JSON.parse(readFileSync(resolve(fixtures, '..', 'schemas', 'qblive-v1.schema.json'), 'utf8'));

function load(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixtures, name), 'utf8'));
}

// `allowUnionTypes` because a table cell really is a string, a number, or null: the whole point of
// a dynamic table is that the server decides the type per column.
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
ajv.addSchema(schema);

/** The schema is one document with several roots; each endpoint validates against one of them. */
function validatorFor(definition: string) {
  return ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
}

const validateSnapshot = validatorFor('snapshot');
const validateManifest = validatorFor('manifest');
const validateEventPage = validatorFor('eventPage');
const validateError = validatorFor('error');

const snapshotFixtures = readdirSync(fixtures).filter((name) => name.startsWith('snapshot-'));

describe('QBLive fixtures satisfy both descriptions of the protocol', () => {
  test('there is at least one snapshot fixture', () => {
    expect(snapshotFixtures.length).toBeGreaterThan(0);
  });

  test.each(snapshotFixtures)('%s validates against the JSON Schema', (name) => {
    const valid = validateSnapshot(load(name));
    expect(validateSnapshot.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  test.each(snapshotFixtures)('%s validates against the TypeScript validator', (name) => {
    expect(() => parseSnapshot(load(name))).not.toThrow();
  });

  test('the manifest fixture validates against both', () => {
    expect(validateManifest(load('manifest.json'))).toBe(true);
    expect(() => parseManifest(load('manifest.json'))).not.toThrow();
  });

  test('the event page fixture validates against both', () => {
    const valid = validateEventPage(load('events.json'));
    expect(validateEventPage.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
    expect(() => parseEventPage(load('events.json'))).not.toThrow();
  });

  test('the error fixture validates against both', () => {
    expect(validateError(load('error.json'))).toBe(true);
  });

  test('every protocol section appears in a snapshot fixture', () => {
    // A section nobody exercises is a section the Swift side could get wrong unnoticed.
    const snapshot = load('snapshot-maximal.json') as Record<string, unknown>;
    for (const name of qbliveSectionNames) expect(snapshot[name]).toBeDefined();
  });
});

describe('the validator rejects what the schema rejects', () => {
  test('a bare local timestamp is refused', () => {
    const snapshot = load('snapshot-default.json') as Record<string, unknown>;
    const broken = { ...snapshot, generatedAt: '2026-09-05T14:30:00' };
    expect(validateSnapshot(broken)).toBe(false);
    expect(() => parseSnapshot(broken)).toThrow(QbliveValidationError);
  });

  test('a future protocol version is refused', () => {
    const snapshot = load('snapshot-default.json') as Record<string, unknown>;
    const broken = { ...snapshot, protocolVersion: 2 };
    expect(validateSnapshot(broken)).toBe(false);
    expect(() => parseSnapshot(broken)).toThrow(/unsupported QBLive protocol version/);
  });

  test('a ragged table row is refused by the validator', () => {
    const snapshot = parseSnapshot(load('snapshot-default.json'));
    const broken = structuredClone(snapshot) as unknown as Record<string, unknown>;
    const standings = broken.standings as { rows: { cells: unknown[] }[] }[];
    standings[0].rows[0].cells.pop();
    expect(() => parseSnapshot(broken)).toThrow(/does not match the column count/);
  });

  test('an oversized table is refused', () => {
    const snapshot = parseSnapshot(load('snapshot-default.json'));
    const broken = structuredClone(snapshot);
    broken.standings[0].rows = Array.from({ length: 5000 }, () => broken.standings[0].rows[0]);
    expect(() => parseSnapshot(broken)).toThrow(/more than 2048 entries/);
  });
});

describe('event application', () => {
  test('applying an event replaces exactly the sections it names', () => {
    const snapshot = parseSnapshot(load('snapshot-default.json'));
    const page = parseEventPage(load('events.json'));
    const applied = page.events.reduce(applyEvent, snapshot);
    expect(applied.revision).toBe(43);
    expect(applied.teams).toEqual(snapshot.teams);
    expect(applied.results).toEqual(page.events[1].sections.results);
  });

  test('an unknown column kind survives a round trip', () => {
    // The point of dynamic tables: a Director that gains a statistic must not need a client release.
    const snapshot = parseSnapshot(load('snapshot-default.json'));
    const withFuture = structuredClone(snapshot);
    withFuture.standings[0].columns.push({ id: 'future', label: 'Zing', kind: 'quantum-flux' as never });
    for (const row of withFuture.standings[0].rows) row.cells.push({ value: 1, display: 'one' });
    const reparsed = parseSnapshot(withFuture);
    expect(reparsed.standings[0].columns.at(-1)?.kind).toBe('quantum-flux');
  });
});
