/**
 * The tournament timezone.
 *
 * A tournament happens in a place, and QBSheet Live publishes times to people standing in that
 * place. The arithmetic below decides what a spectator's phone says, so it is tested against real
 * zones, real daylight-saving transitions, and the half-hour offsets that catch a naive
 * implementation.
 */

import { describe, expect, test } from 'vitest';
import {
  fallbackTimeZone,
  hostTimeZone,
  isoToZonedDateTimeInput,
  isValidTimeZone,
  normalizeTimeZone,
  toZonedIso,
  utcOffsetAt,
  zonedDateTimeInputToIso,
  zonedIsoOrNull,
} from '../src/timezone.js';

describe('validation', () => {
  test.each([
    'America/New_York',
    'America/Chicago',
    'UTC',
    'Europe/London',
    'Asia/Kolkata',
    'Australia/Eucla',
  ])('accepts %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });

  test.each([
    'Not/AZone',
    '',
    'America/New_York; DROP TABLE',
    'x'.repeat(100),
    // Not strings.
    undefined,
    null,
    42,
    {},
  ])('refuses %o', (value) => {
    expect(isValidTimeZone(value)).toBe(false);
  });

  test('normalizing an unusable value gives the unambiguous zone, not the host', () => {
    // UTC rather than the machine's zone: an obviously wrong offset is easier for a Director to
    // notice and correct than a plausible one that is silently off by an hour.
    expect(normalizeTimeZone('Not/AZone')).toBe('UTC');
    expect(normalizeTimeZone(undefined)).toBe('UTC');
    expect(fallbackTimeZone).toBe('UTC');
  });

  test('the host zone is offered, and is always usable', () => {
    expect(isValidTimeZone(hostTimeZone())).toBe(true);
  });
});

describe('offsets', () => {
  test('a whole-hour zone in and out of daylight saving', () => {
    // 2026-09-05 is daylight time in New York; 2026-01-05 is standard time.
    expect(utcOffsetAt('America/New_York', new Date('2026-09-05T16:00:00Z'))).toBe('-04:00');
    expect(utcOffsetAt('America/New_York', new Date('2026-01-05T16:00:00Z'))).toBe('-05:00');
  });

  test('a tournament that crosses a transition has two correct answers on the same weekend', () => {
    // US daylight saving ends 2026-11-01. A Saturday tournament and a Sunday one are an hour apart.
    expect(utcOffsetAt('America/New_York', new Date('2026-10-31T16:00:00Z'))).toBe('-04:00');
    expect(utcOffsetAt('America/New_York', new Date('2026-11-02T16:00:00Z'))).toBe('-05:00');
  });

  test('UTC is +00:00', () => {
    expect(utcOffsetAt('UTC', new Date('2026-09-05T16:00:00Z'))).toBe('+00:00');
  });

  test('a positive offset is signed', () => {
    expect(utcOffsetAt('Europe/Berlin', new Date('2026-09-05T16:00:00Z'))).toBe('+02:00');
  });

  test('a half-hour offset is not rounded to the hour', () => {
    // The case a naive implementation gets wrong. India is +05:30 year round.
    expect(utcOffsetAt('Asia/Kolkata', new Date('2026-09-05T16:00:00Z'))).toBe('+05:30');
  });

  test('a three-quarter-hour offset survives too', () => {
    expect(utcOffsetAt('Australia/Eucla', new Date('2026-09-05T16:00:00Z'))).toBe('+08:45');
  });

  test('an unusable zone falls back rather than throwing', () => {
    expect(utcOffsetAt('Not/AZone', new Date('2026-09-05T16:00:00Z'))).toBe('+00:00');
  });
});

describe('published timestamps', () => {
  test('carry the tournament offset rather than Z', () => {
    // What a spectator's phone reads. 16:00 UTC is 12:00 in New York in September.
    expect(toZonedIso(new Date('2026-09-05T16:00:00Z'), 'America/New_York')).toBe(
      '2026-09-05T12:00:00-04:00',
    );
  });

  test('use Z only when the tournament really is at UTC', () => {
    expect(toZonedIso(new Date('2026-09-05T16:00:00Z'), 'UTC')).toBe('2026-09-05T16:00:00Z');
  });

  test('cross a date boundary correctly', () => {
    // Late evening in Los Angeles is the next day in UTC. Getting this wrong would put a game on
    // the wrong day on a spectator's phone.
    expect(toZonedIso(new Date('2026-09-06T04:30:00Z'), 'America/Los_Angeles')).toBe(
      '2026-09-05T21:30:00-07:00',
    );
  });

  test('a half-hour zone renders its own offset', () => {
    expect(toZonedIso(new Date('2026-09-05T16:00:00Z'), 'Asia/Kolkata')).toBe('2026-09-05T21:30:00+05:30');
  });

  test('are parseable back to the same instant', () => {
    for (const zone of ['America/New_York', 'Asia/Kolkata', 'Australia/Eucla', 'UTC']) {
      const instant = new Date('2026-09-05T16:00:00Z');
      expect(new Date(toZonedIso(instant, zone)).getTime()).toBe(instant.getTime());
    }
  });

  test('pad a single-digit month, day, hour, minute and second', () => {
    expect(toZonedIso(new Date('2026-01-02T08:03:04Z'), 'UTC')).toBe('2026-01-02T08:03:04Z');
  });
});

describe('optional timestamps', () => {
  test('an absent value stays absent rather than becoming a guess', () => {
    // The rule QBSheet Live is built on: a time the tournament did not state is not published.
    expect(zonedIsoOrNull(null, 'America/New_York')).toBeNull();
    expect(zonedIsoOrNull(undefined, 'America/New_York')).toBeNull();
    expect(zonedIsoOrNull('', 'America/New_York')).toBeNull();
  });

  test('an unparseable value is dropped rather than published wrong', () => {
    expect(zonedIsoOrNull('not a date', 'America/New_York')).toBeNull();
    expect(zonedIsoOrNull('2026-13-45T99:99:99Z', 'America/New_York')).toBeNull();
  });

  test('a real value is re-expressed in the tournament zone', () => {
    expect(zonedIsoOrNull('2026-09-05T16:00:00.000Z', 'America/New_York')).toBe('2026-09-05T12:00:00-04:00');
  });
});

describe('datetime-local editing', () => {
  test('interprets a Director wall-clock value in the tournament zone, not the host zone', () => {
    const iso = zonedDateTimeInputToIso('2026-09-05T12:00', 'America/New_York');
    expect(iso).toBe('2026-09-05T16:00:00.000Z');
    expect(isoToZonedDateTimeInput(iso, 'America/New_York')).toBe('2026-09-05T12:00');
  });

  test('rejects a local time removed by the spring-forward DST transition', () => {
    expect(zonedDateTimeInputToIso('2026-03-08T02:30', 'America/New_York')).toBeNull();
  });

  test('uses the earlier occurrence for an ambiguous fall-back wall-clock value', () => {
    // The policy is deterministic: 01:30 on the fall-back day means the first 01:30 (-04:00).
    expect(zonedDateTimeInputToIso('2026-11-01T01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
    expect(isoToZonedDateTimeInput('2026-11-01T06:30:00.000Z', 'America/New_York')).toBe('2026-11-01T01:30');
  });

  test('rejects malformed or nonexistent values instead of silently changing their date', () => {
    expect(zonedDateTimeInputToIso('2026-02-31T12:00', 'UTC')).toBeNull();
    expect(zonedDateTimeInputToIso('not-a-local-time', 'UTC')).toBeNull();
  });
});
