/**
 * The connection history, and the promise that makes it safe to export.
 *
 * Two things are being tested and only one of them is a feature. The history itself has to be readable
 * and correctly ordered. The redaction has to be *right*, because this buffer is designed to end up in
 * a file attached to a support email, and a room token in that file is somebody else's ability to write
 * scores into a live tournament. So the redaction cases below are deliberately adversarial and the bar
 * is over-redaction, not elegance.
 */
import { describe, expect, test } from 'vitest';
import {
  ConnectionTimeline,
  detailLimit,
  redact,
  timelineClock,
  timelineLimit,
  timelineLine,
} from '../src/app/ConnectionTimeline';

describe('redacting text somebody else wrote', () => {
  test.each([
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
    ['token=abc123def456ghi789jkl', 'abc123def456ghi789jkl'],
    ['access_token: 9f8e7d6c5b4a39281706', '9f8e7d6c5b4a39281706'],
    ['pairing code=884213', '884213'],
    ['session: sess_01HQ2X3Y4Z5A6B7C8D9E', 'sess_01HQ2X3Y4Z5A6B7C8D9E'],
    ['secret=hunter2hunter2hunter2', 'hunter2hunter2hunter2'],
    ['?auth=Zm9vYmFyYmF6cXV1eA', 'Zm9vYmFyYmF6cXV1eA'],
  ])('%s does not survive', (input, secret) => {
    expect(redact(input)).not.toContain(secret);
  });

  test('a query string is removed wholesale, whatever is in it', () => {
    // The case that matters most: nobody has to have anticipated the parameter name.
    const cleaned = redact('POST http://192.168.1.24:8787/qbtcp/v1/session?t=Q7xR2&room=204 failed');

    expect(cleaned).not.toContain('Q7xR2');
    expect(cleaned).toContain('http://192.168.1.24:8787/qbtcp/v1/session');
  });

  test('a long unbroken run of token characters goes even with no label at all', () => {
    expect(redact('unexpected value 4f8a2b9c1d7e3f5a6b8c9d0e')).toBe('unexpected value [redacted]');
  });

  test('ordinary server text survives, so the history stays useful', () => {
    expect(redact('Room is not the writer for this session')).toBe('Room is not the writer for this session');
    expect(redact('HTTP 503 from tournament control')).toBe('HTTP 503 from tournament control');
    expect(redact('Timed out after 4000 ms')).toBe('Timed out after 4000 ms');
  });

  test('a stack trace cannot fill the file', () => {
    const long = redact('x'.repeat(5000));

    expect(long.length).toBeLessThanOrEqual(detailLimit + 1);
  });

  test('detail written into an entry is redacted, not merely redactable', () => {
    const timeline = new ConnectionTimeline();

    timeline.record('progress-refused', 'refused: token=abcdefghijklmnopqrstuv');

    expect(timeline.entries()[0].detail).not.toContain('abcdefghijklmnopqrstuv');
  });

  test('what a scorekeeper typed never reaches the history', () => {
    // `requestControl` records the category and not the message; this is the assertion that keeps it
    // that way. A free-text field is the one place a person might type a name or a phone number.
    const timeline = new ConnectionTimeline();

    timeline.record('control-requested', 'wrong-packet');

    expect(timeline.entries()[0].detail).toBe('wrong-packet');
  });
});

describe('what the history keeps', () => {
  test('the sequence a bad round actually produces reads in order', () => {
    let clock = Date.parse('2026-04-11T10:32:14.000Z');
    const timeline = new ConnectionTimeline({ now: () => clock });

    timeline.record('connected');
    timeline.record('progress-sent');
    clock += 48_000;
    timeline.record('offline');
    clock += 7_000;
    timeline.record('connected');
    clock += 1_000;
    timeline.record('session-reopened');
    timeline.record('progress-sent');

    expect(timeline.entries().map((entry) => entry.kind)).toEqual([
      'connected',
      'progress-sent',
      'offline',
      'connected',
      'session-reopened',
      'progress-sent',
    ]);
  });

  test('a connection state that has not changed is not recorded again', () => {
    const timeline = new ConnectionTimeline();

    // The assignment poll every ten seconds, all morning.
    for (let poll = 0; poll < 200; poll += 1) timeline.record('connected');

    expect(timeline.entries()).toHaveLength(1);
  });

  test('a state that changes and comes back is recorded both times', () => {
    const timeline = new ConnectionTimeline();

    timeline.record('connected');
    timeline.record('connected');
    timeline.record('offline');
    timeline.record('connected');

    expect(timeline.entries().map((entry) => entry.kind)).toEqual(['connected', 'offline', 'connected']);
  });

  test('a state repeat is still suppressed when other events happened in between', () => {
    const timeline = new ConnectionTimeline();

    timeline.record('connected');
    timeline.record('progress-sent');
    timeline.record('connected');

    expect(timeline.entries().map((entry) => entry.kind)).toEqual(['connected', 'progress-sent']);
  });

  test('repeated snapshots collapse into a count rather than a wall of lines', () => {
    let clock = 1_000_000;
    const timeline = new ConnectionTimeline({ now: () => clock });

    for (let sent = 0; sent < 40; sent += 1) {
      clock += 5_000;
      timeline.record('progress-sent');
    }

    const entries = timeline.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(40);
    // The first and last occurrence are both kept, which is what makes a collapsed line legible.
    expect(entries[0].lastAt - entries[0].at).toBe(39 * 5_000);
  });

  test('the buffer is bounded, and it is the oldest lines that go', () => {
    const timeline = new ConnectionTimeline();

    // Alternating so nothing collapses.
    for (let index = 0; index < timelineLimit + 50; index += 1) {
      timeline.record('progress-sent', `attempt ${index}`);
    }

    const entries = timeline.entries();
    expect(entries).toHaveLength(timelineLimit);
    // The last twenty minutes are what somebody debugging needs; the 8am snapshots are not.
    expect(entries[entries.length - 1].detail).toBe(`attempt ${timelineLimit + 49}`);
  });

  test('order survives a clock that jumps backwards', () => {
    // A Chromebook that syncs its clock mid-morning. Sorting a timeline by wall time would silently
    // reorder it; `seq` is why it does not.
    let clock = Date.parse('2026-04-11T10:00:00.000Z');
    const timeline = new ConnectionTimeline({ now: () => clock });

    timeline.record('offline');
    clock -= 45 * 60 * 1000;
    timeline.record('connected');

    const entries = timeline.entries();
    expect(entries.map((entry) => entry.kind)).toEqual(['offline', 'connected']);
    expect(entries[0].seq).toBeLessThan(entries[1].seq);
  });

  test('entries handed out cannot be edited from outside', () => {
    const timeline = new ConnectionTimeline();
    timeline.record('progress-sent');

    timeline.entries()[0].count = 99;

    expect(timeline.entries()[0].count).toBe(1);
  });

  test('clearing empties it', () => {
    const timeline = new ConnectionTimeline();
    timeline.record('offline');

    timeline.clear();

    expect(timeline.entries()).toEqual([]);
  });
});

describe('reading it', () => {
  test('a line names the time and what happened, in that order', () => {
    const at = new Date(2026, 3, 11, 10, 33, 9).getTime();

    expect(timelineLine({ seq: 1, at, lastAt: at, count: 1, kind: 'session-reopened' })).toBe(
      '10:33:09  session reopened',
    );
  });

  test('a collapsed line says how many times', () => {
    const at = new Date(2026, 3, 11, 10, 33, 9).getTime();

    expect(timelineLine({ seq: 1, at, lastAt: at + 5000, count: 34, kind: 'progress-sent' })).toBe(
      '10:33:09  progress sent ×34',
    );
  });

  test('detail is appended after a dash', () => {
    const at = new Date(2026, 3, 11, 10, 33, 9).getTime();

    expect(
      timelineLine({ seq: 1, at, lastAt: at, count: 1, kind: 'final-refused', detail: 'HTTP 409' }),
    ).toBe('10:33:09  result refused — HTTP 409');
  });

  test('a broken timestamp does not produce a broken line', () => {
    expect(timelineClock(Number.NaN)).toBe('--:--:--');
  });
});
