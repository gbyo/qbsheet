/**
 * The diagnostics bundle, and the promise that it is safe to send.
 *
 * The feature is a file with facts in it, and testing that is easy. The part worth writing carefully is
 * the guarantee: this file gets emailed to whoever is helping debug a tournament, forwarded twice, and
 * left in a downloads folder on a shared laptop. A room token in it is a stranger's ability to write
 * scores into a live event. So most of what is below is an attempt to get a credential into the bundle by
 * every route somebody plausibly would, and to confirm the download refuses rather than produces one.
 */
import { describe, expect, test } from 'vitest';
import {
  buildDiagnostics,
  diagnosticsFilename,
  downloadDiagnostics,
  findLeaks,
  safeAddress,
  serializeDiagnostics,
} from '../src/app/Diagnostics';
import { ConnectionTimeline } from '../src/app/ConnectionTimeline';
import { ErrorLog } from '../src/app/ErrorLog';

const at = new Date('2026-04-11T14:32:07.000Z');

describe('what the bundle contains', () => {
  test('the build, so the first question about a misbehaving room has an answer', () => {
    const bundle = buildDiagnostics({
      now: at,
      build: { version: '0.4.1', commit: 'a1b2c3d', builtAt: '2026-04-01T09:00:00Z' },
    });

    expect(bundle.build).toEqual({ version: '0.4.1', commit: 'a1b2c3d', builtAt: '2026-04-01T09:00:00Z' });
    expect(bundle.generatedAt).toBe('2026-04-11T14:32:07.000Z');
    expect(bundle.diagnosticsVersion).toBe(1);
  });

  test('the browser and the screen', () => {
    const bundle = buildDiagnostics({ now: at });

    expect(bundle.browser.userAgent).toBeTruthy();
    expect(bundle.browser).toHaveProperty('online');
  });

  test('the worker build separately from the running build, because they can disagree', () => {
    // A page reloaded while online runs new code off the network while the old worker still owns the
    // cache. That is the answer to "this device is behaving like it is running last week's build".
    const bundle = buildDiagnostics({
      now: at,
      build: { version: '0.4.1', commit: 'newcode', builtAt: '' },
      worker: { version: '0.4.0', commit: 'oldshel', builtAt: '', cache: 'qbsheet-shell-ba0f64fe8df2' },
    });

    expect(bundle.build.commit).toBe('newcode');
    expect(bundle.worker?.commit).toBe('oldshel');
  });

  test('the readiness results, exactly as the screen rendered them', () => {
    const bundle = buildDiagnostics({
      now: at,
      checks: [
        { id: 'game-storage', title: 'Game storage', state: 'pass', kind: 'required', detail: 'IndexedDB is writable.' },
        { id: 'local-network', title: 'Local network access', state: 'fail', kind: 'connected', detail: 'Denied.' },
      ],
    });

    expect(bundle.checks).toHaveLength(2);
    expect(bundle.checks[1].state).toBe('fail');
  });

  test('what tournament control announced, including the fallback case', () => {
    const bundle = buildDiagnostics({
      now: at,
      server: {
        address: 'http://192.168.1.24:8787',
        protocol: 'QBTCP',
        version: 1,
        qbjVersion: '2.1.1',
        capabilities: ['pairing', 'assignment', 'progress', 'result'],
      },
    });

    expect(bundle.server.protocol).toBe('QBTCP');
    expect(bundle.server.capabilities).toContain('progress');
  });

  test('persistence health and how many games are on the device', () => {
    const bundle = buildDiagnostics({
      now: at,
      persistence: { recordStoreDurable: false, localStorageWorks: true, persistentStorage: false, storageUsage: 2048 },
      games: { saved: 11, unfinished: 1, unreadable: [{ id: 'r5', readability: 'too-new', storedVersion: 2 }] },
    });

    expect(bundle.persistence.recordStoreDurable).toBe(false);
    expect(bundle.games.unfinished).toBe(1);
    expect(bundle.games.unreadable).toHaveLength(1);
  });

  test('the connection history, as readable lines and as raw entries', () => {
    let clock = new Date(2026, 3, 11, 10, 32, 14).getTime();
    const timeline = new ConnectionTimeline({ now: () => clock });
    timeline.record('progress-sent');
    clock += 48_000;
    timeline.record('offline');
    clock += 7_000;
    timeline.record('connected');
    clock += 1_000;
    timeline.record('session-reopened');

    const bundle = buildDiagnostics({ now: at, timeline: timeline.entries() });

    expect(bundle.connectionTimeline).toEqual([
      '10:32:14  progress sent',
      '10:33:02  network unavailable',
      '10:33:09  connected',
      '10:33:10  session reopened',
    ]);
    // The raw entries follow, so something other than a person can read the file too.
    expect(bundle.connectionEntries).toHaveLength(4);
  });

  test('recent errors', () => {
    const log = new ErrorLog({ now: () => at.getTime() });
    log.record('uncaught', new TypeError('Cannot read properties of null'));

    const bundle = buildDiagnostics({ now: at, errors: log.entries() });

    expect(bundle.errors[0].message).toBe('TypeError: Cannot read properties of null');
  });

  test('the timezone offset, because a device with the wrong clock reads as the wrong hour', () => {
    expect(buildDiagnostics({ now: at })).toHaveProperty('timezoneOffsetMinutes');
  });

  test('the filename carries the build and the minute, and not the room', () => {
    const bundle = buildDiagnostics({
      now: at,
      roomName: 'Room 204',
      build: { version: '0.4.1', commit: 'a1b2c3d', builtAt: '' },
    });

    const name = diagnosticsFilename(bundle);
    expect(name).toBe('qbsheet-diagnostics-a1b2c3d-2026-04-11T14-32-07-000.json');
    expect(name).not.toContain('204');
  });
});

describe('addresses', () => {
  test('a query string never survives, whatever is in it', () => {
    expect(safeAddress('http://192.168.1.24:8787/qbtcp/v1?token=Q7xR2secretvalue')).toBe(
      'http://192.168.1.24:8787/qbtcp/v1',
    );
  });

  test('credentials embedded in a URL never survive', () => {
    expect(safeAddress('http://room:hunter2@192.168.1.24:8787')).not.toContain('hunter2');
  });

  test('a fragment never survives', () => {
    expect(safeAddress('http://192.168.1.24:8787#tokenvaluehere')).toBe('http://192.168.1.24:8787');
  });

  test('an ordinary address survives intact, because a wrong address is a real fault', () => {
    expect(safeAddress('http://192.168.1.24:8787')).toBe('http://192.168.1.24:8787');
  });

  test('something unparseable is redacted rather than passed through', () => {
    expect(safeAddress('not a url at all abcdefghijklmnopqrstuvwxyz')).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  test('nothing in, nothing out', () => {
    expect(safeAddress(undefined)).toBeUndefined();
    expect(safeAddress('   ')).toBeUndefined();
  });
});

describe('refusing to write a file with a credential in it', () => {
  test('a clean bundle has nothing to report', () => {
    const bundle = buildDiagnostics({
      now: at,
      build: { version: '0.4.1', commit: 'a1b2c3d', builtAt: '2026-04-01T09:00:00Z' },
      worker: { version: '0.4.1', commit: 'a1b2c3d', builtAt: '', cache: 'qbsheet-shell-ba0f64fe8df2f006' },
      roomName: 'Room 204',
      server: {
        // A hyphenated hostname and a worker cache name are the two false positives an earlier,
        // sloppier check produced. Both must pass.
        address: 'http://tournament-control-server-1.local:8787/qbtcp/v1',
        protocol: 'QBTCP',
        version: 1,
        capabilities: ['pairing', 'assignment', 'progress', 'result'],
      },
    });

    expect(findLeaks(bundle)).toEqual([]);
  });

  test('the live room token is caught wherever it ended up', () => {
    const token = 'rt_7Kq2Xb9Mn4Pl6Vz8Wc3Ha5Jd';
    const bundle = buildDiagnostics({ now: at, roomName: `Room 204 (${token})` });

    expect(findLeaks(bundle, [token]).length).toBeGreaterThan(0);
  });

  test('a token that reached the bundle inside a timeline detail is caught', () => {
    const token = 'sess_01HQ2X3Y4Z5A6B7C8D9EFGHJ';
    // Bypassing `redact` on purpose. The timeline redacts on the way in, so this is the belt-and-braces
    // check: it catches a future code path that builds an entry some other way and forgets to.
    const entries = [{ seq: 1, at: 1, lastAt: 1, count: 1, kind: 'final-refused' as const, detail: token }];

    const bundle = buildDiagnostics({ now: at, timeline: entries });

    expect(findLeaks(bundle, [token]).length).toBeGreaterThan(0);
  });

  test('a forbidden field name is refused even when it is empty', () => {
    // The commit six months from now that spreads a connection object into the bundle. The field being
    // empty today is not a defence; its existence means the next credential added to that object arrives
    // here without anybody thinking about it.
    const bundle = { ...buildDiagnostics({ now: at }), roomToken: '' } as unknown as ReturnType<
      typeof buildDiagnostics
    >;

    expect(findLeaks(bundle)).toEqual(['diagnostics.roomToken is a field name that must never be exported']);
  });

  test.each(['roomToken', 'sessionToken', 'pairingCode', 'deviceId', 'roomId', 'sessionId', 'authorization'])(
    'a field called %s is refused',
    (field) => {
      const bundle = { ...buildDiagnostics({ now: at }), [field]: 'x' } as unknown as ReturnType<
        typeof buildDiagnostics
      >;

      expect(findLeaks(bundle).length).toBeGreaterThan(0);
    },
  );

  test('an unlabelled token-shaped value is caught even with no secret list', () => {
    const bundle = { ...buildDiagnostics({ now: at }), note: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' } as unknown as ReturnType<
      typeof buildDiagnostics
    >;

    expect(findLeaks(bundle).length).toBeGreaterThan(0);
  });

  test('a short value is not treated as a secret worth failing over', () => {
    // Otherwise a two-character room id would match half the file and no download would ever succeed.
    const bundle = buildDiagnostics({ now: at });

    expect(findLeaks(bundle, ['4'])).toEqual([]);
  });

  test('no file is written when the check fails', () => {
    const token = 'rt_7Kq2Xb9Mn4Pl6Vz8Wc3Ha5Jd';
    const written: string[] = [];

    const outcome = downloadDiagnostics({ now: at, roomName: token }, [token], (_contents, fileName) => {
      written.push(fileName);
      return true;
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'unsafe' });
    // The assertion that matters: the writer was never reached.
    expect(written).toEqual([]);
  });
});

describe('writing the file', () => {
  test('a clean bundle is written, and the outcome names the file', () => {
    let contents = '';
    const outcome = downloadDiagnostics({ now: at }, [], (written) => {
      contents = written;
      return true;
    });

    expect(outcome.ok).toBe(true);
    expect(JSON.parse(contents)).toHaveProperty('diagnosticsVersion', 1);
  });

  test('a browser that will not write a file says so rather than appearing to have saved one', () => {
    expect(downloadDiagnostics({ now: at }, [], () => false)).toEqual({ ok: false, reason: 'no-download' });
  });

  test('the file is indented JSON ending in a newline, because people open it in an editor', () => {
    const text = serializeDiagnostics(buildDiagnostics({ now: at }));

    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "diagnosticsVersion"');
  });
});
