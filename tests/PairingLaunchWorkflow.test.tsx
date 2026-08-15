/**
 * @vitest-environment jsdom
 */

/**
 * A QR code, through the whole application, to a room capability in storage.
 *
 * Driven against the real client and a real (if small) QBTCP server at the `fetch` boundary rather
 * than against a stubbed client, because two of the things being asserted are claims about the wire:
 * that nothing is sent before somebody presses a button, and that the room identifier from the link
 * arrives in the pair request. A stubbed client can be made to say either.
 *
 * The property that matters most is the dull one at the end. After the code has been exchanged, a
 * device paired by QR must be indistinguishable from a device paired by hand — same stored shape,
 * same reload behaviour, same room screen — because everything else in this application is built on
 * top of that pairing and none of it knows or should know how the pairing happened.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { openApp, press } from './appHarness';
import { connectionStorageKey, readConnection } from '../src/app/ConnectedSession';
import { gameRecordVersion, IStoredGameRecord } from '../src/game/GameStore';
import { openRecordStore } from '../src/persistence/GameDatabase';
import { connectionTimeline } from '../src/app/ConnectionTimeline';
import { errorLog } from '../src/app/ErrorLog';
import { buildDiagnostics, findLeaks } from '../src/app/Diagnostics';
import { takePairingLaunch } from '../src/app/PairingLaunch';
import { assignmentDocument } from './qbjDocuments';
import { validPackage } from './packages';

const control = 'http://192.168.1.24:3000';
const pairingCode = '48213906';
const roomToken = 'room-token-9f13';
const homePath = '/scoresheet/';

function launchUrl(options: { room?: string; code?: string } = {}): string {
  const room = options.room === undefined ? '' : `&room=${encodeURIComponent(options.room)}`;
  return `${homePath}#qbtcp-pair?v=1&server=${encodeURIComponent(control)}&code=${options.code ?? pairingCode}${room}`;
}

interface IRequestRecord {
  method: string;
  path: string;
  body: unknown;
  roomToken?: string;
}

/**
 * The smallest server that can pair a room and assign it a game.
 *
 * Refuses anything without the room token, so a test cannot pass by accident on a client that
 * forgot to send it.
 */
function startControl(options: { acceptCode?: string } = {}) {
  const accepted = options.acceptCode ?? pairingCode;
  const requests: IRequestRecord[] = [];

  const answer = (status: number, body: unknown) =>
    new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({
      method,
      path,
      body,
      ...(headers.get('x-yf-room-token') ? { roomToken: headers.get('x-yf-room-token') as string } : {}),
    });

    if (path === '/qbtcp/v1') {
      return answer(200, {
        protocol: 'QBTCP',
        version: 1,
        capabilities: ['pairing', 'assignment', 'progress', 'result'],
        qbj_version: '2.1.1',
        name: 'Spring Invitational',
      });
    }
    if (path === '/qbtcp/v1/rooms') {
      return answer(200, { rooms: [{ id: 'room-204', name: 'Room 204' }] });
    }
    if (path === '/qbtcp/v1/pair' && method === 'POST') {
      const sent = body as { code?: string; roomId?: string } | undefined;
      if (sent?.code !== accepted) {
        // "Return an identical failure" — the protocol's uniform pairing refusal.
        return answer(401, { error: 'That pairing code was not accepted.' });
      }
      return answer(200, { roomId: 'room-204', roomName: 'Room 204', token: roomToken });
    }
    if (headers.get('x-yf-room-token') !== roomToken) {
      return answer(401, { error: 'This room is no longer paired.' });
    }
    if (path === '/qbtcp/v1/assignment/status') {
      return answer(200, { state: 'assigned', session: null });
    }
    if (path === '/qbtcp/v1/assignment') {
      return answer(200, assignmentDocument({}));
    }
    return answer(404, { error: 'No such endpoint.' });
  });

  return { fetchImpl, requests };
}

function pathsOf(requests: IRequestRecord[]): string[] {
  return requests.map((entry) => `${entry.method} ${entry.path}`);
}

/**
 * Everything in this browser's local storage, as text.
 *
 * Enumerated rather than serialized, because the `Storage` interface keeps its contents behind
 * `key()` and `getItem()` — a `JSON.stringify` of it returns an empty object and would make every
 * "the code is not in storage" assertion below pass without reading a single stored value.
 */
function storageDump(): string {
  const storage = window.localStorage;
  const contents: Record<string, string | null> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) contents[key] = storage.getItem(key);
  }
  return JSON.stringify(contents);
}

let server: ReturnType<typeof startControl>;

beforeEach(() => {
  server = startControl();
  vi.stubGlobal('fetch', server.fetchImpl);
  connectionTimeline.clear();
  errorLog.clear();
  window.history.replaceState(null, '', homePath);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', homePath);
  takePairingLaunch();
});

describe('a pairing link opened on an idle device', () => {
  test('scrubs the URL, touches no network, and waits for a press', async () => {
    window.history.replaceState(null, '', launchUrl({ room: 'room-204' }));

    await openApp();

    // Gone from the address bar before the first screen was on it.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe(homePath);
    expect(window.location.href).not.toContain(pairingCode);

    // The ready state, with the address and the room and deliberately not the code.
    expect(screen.getByRole('heading', { name: 'Ready to connect' })).toBeInTheDocument();
    expect(screen.getByText('192.168.1.24:3000')).toBeInTheDocument();
    expect(screen.getByText('room-204')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(pairingCode);

    // Local-network access is gated on a gesture, so nothing has been attempted yet.
    expect(server.fetchImpl).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Connect and pair' })).toBeInTheDocument();
  });

  test('the press runs discovery, identify and pairing, and lands on the room', async () => {
    window.history.replaceState(null, '', launchUrl({ room: 'room-204' }));
    await openApp();

    await press('Connect and pair');
    await waitFor(() => expect(screen.getByText('Room 204', { exact: true })).toBeInTheDocument());

    // Discovery, the verify that follows it, the room list, then the exchange — the same sequence
    // in the same order the typed address box runs, because it is the same two functions.
    // (`identify` needs no request on this surface: discovery already carried the name.)
    expect(pathsOf(server.requests).slice(0, 4)).toEqual([
      'GET /qbtcp/v1',
      'GET /qbtcp/v1',
      'GET /qbtcp/v1/rooms',
      'POST /qbtcp/v1/pair',
    ]);
  });

  test('the room identifier from the link reaches the pair request', async () => {
    window.history.replaceState(null, '', launchUrl({ room: 'room-204' }));
    await openApp();

    await press('Connect and pair');
    await waitFor(() => expect(readConnection()).not.toBeNull());

    const pair = server.requests.find((entry) => entry.path === '/qbtcp/v1/pair');
    expect(pair?.body).toEqual({ code: pairingCode, roomId: 'room-204' });
  });

  test('a link without a room leaves the room to the protocol, as a typed code does', async () => {
    window.history.replaceState(null, '', launchUrl());
    await openApp();

    await press('Connect and pair');
    await waitFor(() => expect(readConnection()).not.toBeNull());

    const pair = server.requests.find((entry) => entry.path === '/qbtcp/v1/pair');
    expect(pair?.body).toEqual({ code: pairingCode });
    // The server is still authoritative about which room it opened.
    expect(readConnection()?.roomName).toBe('Room 204');
  });

  test('the room capability is stored, survives a reload, and is not asked for again', async () => {
    window.history.replaceState(null, '', launchUrl({ room: 'room-204' }));
    await openApp();
    await press('Connect and pair');
    await waitFor(() => expect(readConnection()?.roomToken).toBe(roomToken));

    const stored = readConnection();
    expect(stored).toMatchObject({ baseUrl: control, roomId: 'room-204', roomName: 'Room 204' });
    expect(stored?.deviceId).toMatch(/^device-/);

    // A reload: the same storage, a fresh application, and no fragment in the URL any more.
    cleanup();
    await openApp();

    await waitFor(() => expect(screen.getByText('Room 204', { exact: true })).toBeInTheDocument());
    expect(screen.queryByLabelText('Pairing code')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect and pair' })).toBeNull();
  });

  test('the assignment arrives on that restored pairing', async () => {
    window.history.replaceState(null, '', launchUrl({ room: 'room-204' }));
    await openApp();
    await press('Connect and pair');

    await waitFor(() => expect(document.querySelectorAll('.assignment-team')).toHaveLength(2));
    expect(screen.getByRole('button', { name: /^(Start|Resume) scoring$/ })).toBeEnabled();
  });
});

describe('a pairing link that does not work', () => {
  test('a code control refuses hands over to the ordinary pairing form', async () => {
    server = startControl({ acceptCode: '11112222' });
    vi.stubGlobal('fetch', server.fetchImpl);
    window.history.replaceState(null, '', launchUrl({ room: 'room-204' }));
    await openApp();

    await press('Connect and pair');

    await waitFor(() => expect(screen.getByLabelText('Pairing code')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('That pairing code was not accepted.');
    // Nothing was paired, and nothing was stored.
    expect(readConnection()).toBeNull();
  });

  test('an invalid link is reported on the ordinary homepage, without repeating it', async () => {
    window.history.replaceState(null, '', `${homePath}#qbtcp-pair?v=1&code=${pairingCode}`);

    await openApp();

    expect(screen.getByText('This QBSheet pairing link is invalid.')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(document.body.textContent).not.toContain(pairingCode);
    expect(server.fetchImpl).not.toHaveBeenCalled();
  });

  test('a link from a newer build says so and is still scrubbed', async () => {
    window.history.replaceState(
      null,
      '',
      `${homePath}#qbtcp-pair?v=2&server=${encodeURIComponent(control)}&code=${pairingCode}`,
    );

    await openApp();

    expect(
      screen.getByText('This pairing link uses a version this build does not support.'),
    ).toBeInTheDocument();
    expect(window.location.href).not.toContain(pairingCode);
  });
});

describe('what a pairing link is not allowed to do', () => {
  test('an unfinished game that depends on the current pairing cannot be replaced by a link', async () => {
    // A device that is Room 12 at another tournament, mid-game.
    window.localStorage.setItem(
      connectionStorageKey,
      JSON.stringify({
        version: 1,
        baseUrl: 'http://10.0.0.9:3000',
        roomId: 'room-12',
        roomName: 'Room 12',
        roomToken: 'existing-room-token',
        deviceId: 'device-existing',
        gameRecordId: 'game-1',
        updatedAt: new Date().toISOString(),
      }),
    );
    const store = await openRecordStore<IStoredGameRecord>();
    await store.put({
      version: gameRecordVersion,
      id: 'game-1',
      identity: 'game-identity',
      attempt: 1,
      gameKey: 'session-1',
      package: validPackage(),
      setup: { left: { name: 'A', players: [] }, right: { name: 'B', players: [] } },
      events: [],
      connected: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      serverDelivery: 'pending',
    });

    window.history.replaceState(null, '', launchUrl({ room: 'room-204' }));
    await openApp();

    // Scrubbed anyway — that half is about the secret and not about the game.
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(pairingCode);
    // Refused, in words that name the game and not the code.
    const notice = screen.getByText(/cannot switch tournament control/);
    expect(notice).toHaveTextContent('Room 12');
    expect(notice.textContent).not.toContain(pairingCode);
    // The unfinished game is still there and still resumable, and the old capability is untouched.
    expect(screen.getByRole('button', { name: 'Resume scoring' })).toBeInTheDocument();
    expect(readConnection()?.roomToken).toBe('existing-room-token');
    expect(server.fetchImpl).not.toHaveBeenCalled();
  });

  test('an existing pairing is not erased until a new one has actually succeeded', async () => {
    server = startControl({ acceptCode: '11112222' });
    vi.stubGlobal('fetch', server.fetchImpl);
    window.localStorage.setItem(
      connectionStorageKey,
      JSON.stringify({
        version: 1,
        baseUrl: 'http://10.0.0.9:3000',
        roomId: 'room-12',
        roomName: 'Room 12',
        roomToken: 'existing-room-token',
        deviceId: 'device-existing',
        updatedAt: new Date().toISOString(),
      }),
    );

    window.history.replaceState(null, '', launchUrl({ room: 'room-204' }));
    await openApp();
    // The link outranks the stored room on screen, and does not touch it in storage.
    expect(screen.getByRole('heading', { name: 'Ready to connect' })).toBeInTheDocument();
    expect(readConnection()?.roomToken).toBe('existing-room-token');

    await press('Connect and pair');
    await waitFor(() => expect(screen.getByLabelText('Pairing code')).toBeInTheDocument());

    // The exchange failed, so Room 12 is still this device's room.
    expect(readConnection()?.roomToken).toBe('existing-room-token');
    expect(readConnection()?.roomName).toBe('Room 12');
  });
});

describe('the code goes nowhere', () => {
  test('nothing that leaves this device carries the pairing code', async () => {
    window.history.replaceState(null, '', launchUrl({ room: 'room-204' }));
    await openApp();
    await press('Connect and pair');
    await waitFor(() => expect(readConnection()?.roomToken).toBe(roomToken));

    // Storage holds the capability the exchange bought and no trace of what bought it.
    const stored = storageDump();
    expect(stored).toContain(roomToken);
    expect(stored).not.toContain(pairingCode);
    expect(stored).not.toContain('qbtcp-pair');

    // The connection timeline records that a room paired, by name.
    const timeline = JSON.stringify(connectionTimeline.entries());
    expect(timeline).toContain('room-repaired');
    expect(timeline).not.toContain(pairingCode);

    // The error log has nothing at all, and could not have caught a URL that no longer had it.
    expect(JSON.stringify(errorLog.entries())).not.toContain(pairingCode);

    // And the diagnostics file, which is the thing that actually gets emailed to a stranger.
    const bundle = buildDiagnostics({ server: { address: control, protocol: 'QBTCP' }, roomName: 'Room 204' });
    expect(JSON.stringify(bundle)).not.toContain(pairingCode);
    expect(findLeaks(bundle, [roomToken, pairingCode])).toEqual([]);

    // Nothing rendered it either.
    expect(document.body.textContent).not.toContain(pairingCode);
  });

  test('the pairing code is sent exactly once, in the body of the pair request', async () => {
    window.history.replaceState(null, '', launchUrl({ room: 'room-204' }));
    await openApp();
    await press('Connect and pair');
    await waitFor(() => expect(readConnection()?.roomToken).toBe(roomToken));

    const carrying = server.requests.filter((entry) => JSON.stringify(entry).includes(pairingCode));
    expect(carrying).toHaveLength(1);
    expect(carrying[0].path).toBe('/qbtcp/v1/pair');
    // And never in a URL, which is the rule the fragment exists to keep.
    expect(server.requests.every((entry) => !entry.path.includes(pairingCode))).toBe(true);
  });
});
