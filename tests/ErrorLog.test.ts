/**
 * Writing down what broke, without changing what the room sees.
 *
 * Two properties. Whatever was thrown has to become a readable sentence — including the cases that are
 * not `Error` objects, because those are exactly the ones that would otherwise become `[object Object]`
 * in the one file somebody was hoping to debug from. And nothing recorded here may reach the scoresheet:
 * an exception inside some effect on question fourteen is a thing to know about on Monday, not a reason
 * to interrupt a game.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { ErrorLog, describeThrown, errorLogLimit, messageLimit, watchForErrors } from '../src/app/ErrorLog';

const stop: Array<() => void> = [];
afterEach(() => {
  while (stop.length > 0) stop.pop()?.();
});

describe('describing what was thrown', () => {
  test('an Error becomes its name and message', () => {
    expect(describeThrown(new TypeError('x is not a function'))).toBe('TypeError: x is not a function');
  });

  test('an Error with no message is still identified', () => {
    expect(describeThrown(new RangeError(''))).toBe('RangeError');
  });

  test('a thrown string is itself', () => {
    expect(describeThrown('the packet was not there')).toBe('the packet was not there');
  });

  test('a thrown object is serialized rather than becoming [object Object]', () => {
    expect(describeThrown({ status: 500 })).toBe('{"status":500}');
  });

  test('a value JSON.stringify cannot represent is still described', () => {
    expect(describeThrown(Symbol('broken'))).toBe('An unserializable value was thrown');
  });

  test('a thrown nothing is still a line', () => {
    expect(describeThrown(undefined)).toContain('Nothing was thrown');
    expect(describeThrown(null)).toContain('Nothing was thrown');
  });

  test('a circular object does not throw on its way into the log', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(describeThrown(circular)).toBe('An unserializable value was thrown');
  });
});

describe('what the log keeps', () => {
  test('a message is redacted, because a stack trace is exactly where a token hides', () => {
    const log = new ErrorLog();

    log.record('uncaught', new Error('POST http://control:8787/session?t=Q7xR2secret failed'));

    expect(log.entries()[0].message).not.toContain('Q7xR2secret');
  });

  test('the same error four hundred times is one line with a count', () => {
    const log = new ErrorLog();

    for (let index = 0; index < 400; index += 1) log.record('uncaught', new Error('same'));

    expect(log.entries()).toHaveLength(1);
    expect(log.entries()[0].count).toBe(400);
  });

  test('different errors are kept apart', () => {
    const log = new ErrorLog();

    log.record('uncaught', new Error('first'));
    log.record('unhandled-rejection', new Error('second'));

    expect(log.entries().map((entry) => entry.source)).toEqual(['uncaught', 'unhandled-rejection']);
  });

  test('the buffer is bounded and drops the oldest', () => {
    const log = new ErrorLog();

    for (let index = 0; index < errorLogLimit + 10; index += 1)
      log.record('uncaught', new Error(`e${index}`));

    const entries = log.entries();
    expect(entries).toHaveLength(errorLogLimit);
    expect(entries[entries.length - 1].message).toBe(`Error: e${errorLogLimit + 9}`);
  });

  test('a very long message is truncated', () => {
    const log = new ErrorLog();

    log.record('uncaught', new Error('x'.repeat(10_000)));

    expect(log.entries()[0].message.length).toBeLessThanOrEqual(messageLimit);
  });

  test('entries handed out cannot be edited from outside', () => {
    const log = new ErrorLog();
    log.record('uncaught', new Error('one'));

    log.entries()[0].count = 99;

    expect(log.entries()[0].count).toBe(1);
  });
});

describe('catching what nobody else caught', () => {
  test('an uncaught error is recorded with where it came from', () => {
    const log = new ErrorLog();
    stop.push(watchForErrors(log));

    window.dispatchEvent(
      new ErrorEvent('error', {
        error: new Error('boom'),
        message: 'boom',
        filename: 'https://example.org/scoresheet/assets/index-abc.js',
        lineno: 12,
        colno: 7,
      }),
    );

    const entry = log.entries()[0];
    expect(entry.message).toBe('Error: boom');
    expect(entry.where).toContain(':12:7');
  });

  test('an unhandled rejection is recorded', () => {
    const log = new ErrorLog();
    stop.push(watchForErrors(log));

    // Constructed rather than caused, so the test does not depend on when the browser decides a
    // rejection was unhandled.
    const event = new Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = new Error('control never answered');
    window.dispatchEvent(event);

    expect(log.entries()[0]).toMatchObject({
      source: 'unhandled-rejection',
      message: 'Error: control never answered',
    });
  });

  test('removing the watcher stops the recording', () => {
    const log = new ErrorLog();
    watchForErrors(log)();

    // With our listener gone nothing is handling this, and jsdom reports an unhandled error to the test
    // runner. Swallowing it here keeps the run clean without weakening what is being asserted.
    const swallow = (event: Event) => event.preventDefault();
    window.addEventListener('error', swallow);
    try {
      window.dispatchEvent(new ErrorEvent('error', { error: new Error('after'), cancelable: true }));
    } finally {
      window.removeEventListener('error', swallow);
    }

    expect(log.entries()).toEqual([]);
  });
});
