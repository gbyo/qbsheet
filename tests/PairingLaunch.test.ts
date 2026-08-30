/**
 * @vitest-environment jsdom
 */

/**
 * The one URL this application will read, treated as what it is: untrusted input carrying a secret.
 *
 * Two properties are being defended here and they pull in opposite directions. The parser has to be
 * strict, because everything in a QR code came from outside and a payload that half-parses is worse
 * than one that does not parse at all. And the scrub has to be generous about *what* it recognises,
 * because a malformed pairing link is exactly as likely to carry a real pairing code as a well-formed
 * one, and leaving it in the address bar because it failed validation would be the wrong way round.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  capturePairingLaunch,
  consumePairingLaunch,
  invalidPairingLaunchMessage,
  parsePairingLaunch,
  parsePairingLaunchUrl,
  readScannedPairingCode,
  takePairingLaunch,
  unsupportedPairingLaunchMessage,
} from '../src/app/PairingLaunch';

const code = '48213906';
const server = 'http://192.168.1.24:3000';
const encodedServer = encodeURIComponent(server);

function fragment(query: string): string {
  return `#qbtcp-pair?${query}`;
}

const validQuery = `v=1&server=${encodedServer}&code=${code}`;

/** Put the page back where the suite expects it, whatever a test did to the URL. */
const homePath = '/scoresheet/';

beforeEach(() => {
  window.history.replaceState(null, '', homePath);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', homePath);
  // Nothing in this file may leave a captured launch behind for the next one.
  takePairingLaunch();
});

describe('reading a pairing launch fragment', () => {
  test('a valid version 1 link becomes an intent', () => {
    const result = parsePairingLaunch(fragment(validQuery));

    expect(result).toEqual({
      kind: 'intent',
      intent: { version: 1, server, code },
    });
  });

  test('the optional room identifier is carried through', () => {
    const result = parsePairingLaunch(fragment(`${validQuery}&room=room-204`));

    expect(result).toMatchObject({ kind: 'intent', intent: { roomId: 'room-204' } });
  });

  test('a percent-encoded local HTTP address survives normalization', () => {
    const result = parsePairingLaunch(
      fragment(`v=1&server=${encodeURIComponent('http://tournament.local:8787/control/')}&code=${code}`),
    );

    // Normalized the same way a typed address is: the path prefix kept, the trailing slash dropped.
    expect(result).toMatchObject({
      kind: 'intent',
      intent: { server: 'http://tournament.local:8787/control' },
    });
  });

  test('an unknown future parameter is ignored rather than obeyed', () => {
    const result = parsePairingLaunch(fragment(`${validQuery}&token=not-a-capability&hint=x`));

    expect(result).toEqual({ kind: 'intent', intent: { version: 1, server, code } });
  });

  test('a fragment belonging to some other application is not ours', () => {
    expect(parsePairingLaunch('#settings')).toEqual({ kind: 'none' });
    expect(parsePairingLaunch('')).toEqual({ kind: 'none' });
    expect(parsePairingLaunch('#qbtcp-pairing?v=1')).toEqual({ kind: 'none' });
  });
});

describe('refusing a pairing launch fragment', () => {
  const refusals: [string, string, string][] = [
    [
      'an unsupported launch version',
      `v=2&server=${encodedServer}&code=${code}`,
      unsupportedPairingLaunchMessage,
    ],
    [
      'a version that is not a number',
      `v=one&server=${encodedServer}&code=${code}`,
      unsupportedPairingLaunchMessage,
    ],
    ['no version at all', `server=${encodedServer}&code=${code}`, invalidPairingLaunchMessage],
    ['a missing server', `v=1&code=${code}`, invalidPairingLaunchMessage],
    ['an empty server', `v=1&server=&code=${code}`, invalidPairingLaunchMessage],
    ['a missing code', `v=1&server=${encodedServer}`, invalidPairingLaunchMessage],
    ['an empty code', `v=1&server=${encodedServer}&code=`, invalidPairingLaunchMessage],
    [
      'a code that is only whitespace',
      `v=1&server=${encodedServer}&code=%20%20`,
      invalidPairingLaunchMessage,
    ],
    ['malformed percent encoding', `v=1&server=%E0%A4%A&code=${code}`, invalidPairingLaunchMessage],
    [
      'a duplicated code',
      `v=1&server=${encodedServer}&code=${code}&code=99999999`,
      invalidPairingLaunchMessage,
    ],
    [
      'a duplicated server',
      `v=1&server=${encodedServer}&server=${encodedServer}&code=${code}`,
      invalidPairingLaunchMessage,
    ],
    ['a duplicated version', `v=1&v=1&server=${encodedServer}&code=${code}`, invalidPairingLaunchMessage],
    [
      'a server scheme this application does not speak',
      `v=1&server=${encodeURIComponent('ftp://192.168.1.24')}&code=${code}`,
      invalidPairingLaunchMessage,
    ],
    [
      'a server with no scheme, which a generator has no excuse for',
      `v=1&server=${encodeURIComponent('192.168.1.24:3000')}&code=${code}`,
      invalidPairingLaunchMessage,
    ],
    [
      'a javascript: address dressed up as a server',
      `v=1&server=${encodeURIComponent('javascript:alert(1)')}&code=${code}`,
      invalidPairingLaunchMessage,
    ],
    [
      'an empty room, which is ambiguous rather than absent',
      `${validQuery}&room=`,
      invalidPairingLaunchMessage,
    ],
    ['an over-long code', `v=1&server=${encodedServer}&code=${'9'.repeat(65)}`, invalidPairingLaunchMessage],
  ];

  test.each(refusals)('%s is refused', (_name, query, message) => {
    expect(parsePairingLaunch(fragment(query))).toEqual({ kind: 'problem', message });
  });

  test('a refusal never repeats any part of the link', () => {
    const result = parsePairingLaunch(fragment(`v=2&server=${encodedServer}&code=${code}`));

    expect(result.kind).toBe('problem');
    const message = result.kind === 'problem' ? result.message : '';
    expect(message).not.toContain(code);
    expect(message).not.toContain('192.168.1.24');
  });

  test('a payload far too long to be a launch link is refused without being parsed', () => {
    const result = parsePairingLaunch(`${fragment(validQuery)}&pad=${'a'.repeat(4096)}`);

    expect(result).toEqual({ kind: 'problem', message: invalidPairingLaunchMessage });
  });
});

describe('reading a scanned URL', () => {
  test('the origin in the QR code is the deployment’s business and not the parser’s', () => {
    expect(parsePairingLaunchUrl(`https://scores.example.school/qbsheet/${fragment(validQuery)}`)).toEqual({
      kind: 'intent',
      intent: { version: 1, server, code },
    });
  });

  test('an ordinary QR code is simply not a pairing link', () => {
    expect(parsePairingLaunchUrl('WIFI:S=Venue;T=WPA;P=hunter2;;')).toEqual({ kind: 'none' });
    expect(parsePairingLaunchUrl('https://example.org/')).toEqual({ kind: 'none' });
  });

  test('a pairing link that is broken is still recognised as one', () => {
    expect(parsePairingLaunchUrl(`https://qbsheet.com/${fragment('v=1&code=' + code)}`)).toEqual({
      kind: 'problem',
      message: invalidPairingLaunchMessage,
    });
  });

  test('the shared scan handoff closes the scanner and forwards a valid intent', () => {
    const setScanning = vi.fn();
    const onPairingLaunch = vi.fn();

    expect(
      readScannedPairingCode(`https://qbsheet.com/${fragment(validQuery)}`, setScanning, onPairingLaunch),
    ).toBeNull();
    expect(setScanning).toHaveBeenCalledWith(false);
    expect(onPairingLaunch).toHaveBeenCalledWith({ version: 1, server, code });
  });

  test('the shared scan handoff keeps the scanner open for an ordinary QR code', () => {
    const setScanning = vi.fn();
    const onPairingLaunch = vi.fn();

    expect(readScannedPairingCode('WIFI:S=Venue;T=WPA;P=hunter2;;', setScanning, onPairingLaunch)).toBe(
      'That is not a QBSheet pairing code. Look for the QR code tournament control is showing.',
    );
    expect(setScanning).not.toHaveBeenCalled();
    expect(onPairingLaunch).not.toHaveBeenCalled();
  });
});

describe('consuming the fragment from the address bar', () => {
  test('a recognised link is removed immediately, in place, with no reload', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    window.history.replaceState(null, '', `${homePath}${fragment(validQuery)}`);
    replaceState.mockClear();
    const before = window.document;

    const result = consumePairingLaunch();

    expect(result.kind).toBe('intent');
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe(homePath);
    expect(replaceState).toHaveBeenCalledTimes(1);
    // A reload replaces the document. Same document object means the page never went anywhere.
    expect(window.document).toBe(before);
  });

  test('a deployment under a project base path keeps its base and its query', () => {
    window.history.replaceState(null, '', `/qbsheet/index.html?kiosk=1${fragment(validQuery)}`);

    consumePairingLaunch();

    expect(window.location.pathname).toBe('/qbsheet/index.html');
    expect(window.location.search).toBe('?kiosk=1');
    expect(window.location.hash).toBe('');
  });

  test('a malformed pairing link is scrubbed too, because it may still carry a real code', () => {
    window.history.replaceState(null, '', `${homePath}${fragment(`v=1&server=${encodedServer}`)}`);

    const result = consumePairingLaunch();

    expect(result).toEqual({ kind: 'problem', message: invalidPairingLaunchMessage });
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('qbtcp-pair');
  });

  test('an unsupported launch version is scrubbed, and says so without the code', () => {
    window.history.replaceState(
      null,
      '',
      `${homePath}${fragment(`v=9&server=${encodedServer}&code=${code}`)}`,
    );

    const result = consumePairingLaunch();

    expect(result).toEqual({ kind: 'problem', message: unsupportedPairingLaunchMessage });
    expect(window.location.href).not.toContain(code);
  });

  test('a fragment that is not ours is left exactly where it was', () => {
    window.history.replaceState(null, '', `${homePath}#some-other-anchor`);

    expect(consumePairingLaunch()).toEqual({ kind: 'none' });
    expect(window.location.hash).toBe('#some-other-anchor');
  });

  test('nothing about a launch link is written to storage', () => {
    window.localStorage.setItem('qbsheet.unrelated', 'something else entirely');
    window.history.replaceState(null, '', `${homePath}${fragment(`${validQuery}&room=room-204`)}`);

    expect(consumePairingLaunch().kind).toBe('intent');

    // Enumerated rather than serialized: `JSON.stringify` of a `Storage` is `{}`, and an assertion
    // against that would pass whatever the parser had written.
    const contents: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key !== null) contents.push(key, window.localStorage.getItem(key) ?? '');
    }
    expect(contents).toContain('qbsheet.unrelated');
    expect(contents.join(' ')).not.toContain(code);
    expect(contents.join(' ')).not.toContain('qbtcp-pair');
  });
});

describe('handing the captured launch to the application', () => {
  test('it is delivered once and then gone', () => {
    window.history.replaceState(null, '', `${homePath}${fragment(validQuery)}`);

    capturePairingLaunch();

    expect(takePairingLaunch()).toMatchObject({ kind: 'intent' });
    expect(takePairingLaunch()).toEqual({ kind: 'none' });
  });

  test('an application mounted without the startup hook still consumes the URL itself', () => {
    window.history.replaceState(null, '', `${homePath}${fragment(validQuery)}`);

    expect(takePairingLaunch()).toMatchObject({ kind: 'intent' });
    expect(window.location.hash).toBe('');
  });
});
