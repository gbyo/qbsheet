/**
 * A morning, end to end, with the Tauri bridge faked at the boundary.
 *
 * Faking `__TAURI_INTERNALS__.invoke` rather than the four wrapper functions is deliberate: it
 * exercises the command names and argument shapes the Rust side actually declares, so a rename on
 * one side of that boundary fails here instead of on a laptop at a tournament.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetNativeHost } from './native';
import { loadState, storageKey } from './persistence';
import { scoredResultDocument } from '../tests/scoredResult';
import { yftFixtureText } from '../tests/fixture';
import { useBridge } from './useBridge';

interface InvokeCall {
  command: string;
  args: Record<string, unknown>;
}

const relayBase = 'https://qbtcp-relay-test.workers.dev';
const relayTournament = 'bcdfghjkmnpqrstvwxyz2345';

let calls: InvokeCall[] = [];
let relayResults: { result_id: string; room_id: string; received_at: string; qbj: unknown }[] = [];
let writtenFiles: { directory: string; fileName: string; contents: string }[] = [];

function installFakeTauri(): void {
  calls = [];
  writtenFiles = [];
  const invoke = async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    switch (command) {
      case 'open_yellowfruit_file':
        return { path: '/tournaments/spring.yft', contents: yftFixtureText() };
      case 'choose_result_folder':
        return '/tournaments/results';
      case 'write_result_file': {
        writtenFiles.push(args as unknown as (typeof writtenFiles)[number]);
        return `${String(args.directory)}/${String(args.fileName)}`;
      }
      case 'relay_request': {
        const url = String(args.url);
        if (url.endsWith('/manage/claim')) {
          return {
            status: 200,
            body: JSON.stringify({
              tournamentId: relayTournament,
              managementToken: 'management-secret',
            }),
          };
        }
        if (url.endsWith('/mirror')) return { status: 200, body: '{}' };
        if (url.includes('/results')) {
          return { status: 200, body: JSON.stringify({ results: relayResults }) };
        }
        return { status: 404, body: '{}' };
      }
      default:
        throw new Error(`unexpected command ${command}`);
    }
  };
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { value: { invoke }, configurable: true });
  resetNativeHost();
}

beforeEach(() => {
  relayResults = [];
  installFakeTauri();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as Record<string, unknown>, '__TAURI_INTERNALS__');
  resetNativeHost();
  vi.restoreAllMocks();
});

async function setUpTournament() {
  const rendered = renderHook(() => useBridge());
  await act(async () => {
    await rendered.result.current.loadFile();
  });
  await act(async () => {
    await rendered.result.current.connectRelay({
      baseUrl: relayBase,
      tournamentId: relayTournament,
      setupToken: 'one-time',
    });
  });
  act(() => {
    rendered.result.current.addRoom();
    rendered.result.current.addRoom();
  });
  const [first, second] = rendered.result.current.state.rooms;
  act(() => {
    rendered.result.current.renameRoom(first.id, 'Room 101');
    rendered.result.current.setRoomTeams(first.id, 'left', 'Team_Cony');
    rendered.result.current.setRoomTeams(first.id, 'right', 'Team_Deering');
    rendered.result.current.renameRoom(second.id, 'Room 102');
    rendered.result.current.setRoomTeams(second.id, 'left', 'Team_Wells');
    rendered.result.current.setRoomTeams(second.id, 'right', 'Team_Windham A');
  });
  const round = rendered.result.current.tournament?.rounds[3];
  act(() => {
    rendered.result.current.selectRound(round!.id);
  });
  return rendered;
}

describe('a round, published and returned', () => {
  test('the native commands are called with the arguments the Rust side declares', async () => {
    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.publish();
    });

    expect(calls.map((call) => call.command)).toContain('open_yellowfruit_file');
    const mirror = calls.find(
      (call) => call.command === 'relay_request' && String(call.args.url).endsWith('/mirror'),
    );
    expect(mirror).toBeTruthy();
    expect(mirror?.args).toMatchObject({ method: 'PUT', bearer: 'management-secret' });
    // The body crosses the bridge as a JSON string, which is what `relay_request` takes.
    expect(typeof mirror?.args.body).toBe('string');
    const body = JSON.parse(String(mirror?.args.body)) as { revision: number; rooms: unknown[] };
    expect(body.revision).toBe(1);
    expect(body.rooms).toHaveLength(2);

    expect(rendered.result.current.notice?.kind).toBe('good');
    expect(rendered.result.current.state.relay?.revision).toBe(1);
    expect(rendered.result.current.state.rooms.every((room) => room.publishedMatchId !== null)).toBe(true);
    expect(rendered.result.current.state.rooms.map((room) => bridgeStatus(rendered, room.id))).toEqual([
      'waiting',
      'waiting',
    ]);
  });

  test('the next round keeps each room, its code and its identity, and advances the revision', async () => {
    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.publish();
    });
    const afterFirst = rendered.result.current.state.rooms.map((room) => ({
      id: room.id,
      code: room.pairingCode,
      matchId: room.publishedMatchId,
    }));

    const nextRound = rendered.result.current.tournament?.rounds[4];
    act(() => {
      rendered.result.current.selectRound(nextRound!.id);
    });
    await act(async () => {
      await rendered.result.current.publish();
    });

    const afterSecond = rendered.result.current.state.rooms;
    expect(afterSecond.map((room) => room.id)).toEqual(afterFirst.map((entry) => entry.id));
    expect(afterSecond.map((room) => room.pairingCode)).toEqual(afterFirst.map((entry) => entry.code));
    expect(afterSecond.map((room) => room.publishedMatchId)).not.toEqual(
      afterFirst.map((entry) => entry.matchId),
    );
    expect(afterSecond.map((room) => room.assignmentRevision)).toEqual([2, 2]);
    expect(rendered.result.current.state.relay?.revision).toBe(2);
  });

  test('a failed publish says the rooms were not updated and moves nothing', async () => {
    const rendered = await setUpTournament();
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      value: {
        invoke: async (command: string) => {
          if (command === 'relay_request') throw new Error('relay_unreachable');
          throw new Error(command);
        },
      },
      configurable: true,
    });
    resetNativeHost();

    await act(async () => {
      await rendered.result.current.publish();
    });
    expect(rendered.result.current.notice?.kind).toBe('bad');
    expect(rendered.result.current.notice?.message).toMatch(/still have whatever they had before/);
    expect(rendered.result.current.state.relay?.revision).toBe(0);
    expect(rendered.result.current.state.rooms.every((room) => room.publishedMatchId === null)).toBe(true);
  });
});

describe('results', () => {
  test('the same result on many polls is one result; two results are two', async () => {
    const { result: document } = scoredResultDocument();
    relayResults = [
      { result_id: 'res-1', room_id: 'room-1', received_at: '2026-09-10T15:00:00Z', qbj: document },
    ];
    const rendered = await setUpTournament();

    await act(async () => {
      await rendered.result.current.pollResults();
      await rendered.result.current.pollResults();
      await rendered.result.current.pollResults();
    });
    expect(rendered.result.current.state.results.map((entry) => entry.resultId)).toEqual(['res-1']);

    relayResults = [
      ...relayResults,
      { result_id: 'res-2', room_id: 'room-2', received_at: '2026-09-10T15:10:00Z', qbj: document },
    ];
    await act(async () => {
      await rendered.result.current.pollResults();
    });
    expect(rendered.result.current.state.results.map((entry) => entry.resultId)).toEqual(['res-1', 'res-2']);
  });

  test('a room shows its result once the matching game comes back', async () => {
    const { result: document, matchId } = scoredResultDocument();
    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.publish();
    });
    // The scorer's document carries the match id QBBridge published for Room 101.
    expect(rendered.result.current.state.rooms[0].publishedMatchId).toBe(matchId);

    relayResults = [
      { result_id: 'res-1', room_id: 'room-1', received_at: '2026-09-10T15:00:00Z', qbj: document },
    ];
    await act(async () => {
      await rendered.result.current.pollResults();
    });
    expect(bridgeStatus(rendered, rendered.result.current.state.rooms[0].id)).toBe('result-received');
    expect(bridgeStatus(rendered, rendered.result.current.state.rooms[1].id)).toBe('waiting');
  });

  test('saving writes one untouched file per result and marks only what was written', async () => {
    const { result: document } = scoredResultDocument();
    relayResults = [
      { result_id: 'res-1', room_id: 'room-1', received_at: '2026-09-10T15:00:00Z', qbj: document },
    ];
    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.pollResults();
      await rendered.result.current.chooseFolder();
    });
    await act(async () => {
      await rendered.result.current.saveNewResults();
    });

    expect(writtenFiles).toHaveLength(1);
    expect(writtenFiles[0].directory).toBe('/tournaments/results');
    expect(writtenFiles[0].fileName).toBe('R04_Room-101_Cony_vs_Deering.result.qbj');
    expect(JSON.parse(writtenFiles[0].contents)).toEqual(JSON.parse(JSON.stringify(document)));
    expect(rendered.result.current.state.results[0].savedPath).toBe(
      '/tournaments/results/R04_Room-101_Cony_vs_Deering.result.qbj',
    );

    // Already saved: a second pass writes nothing rather than duplicating the file.
    await act(async () => {
      await rendered.result.current.saveNewResults();
    });
    expect(writtenFiles).toHaveLength(1);
  });

  test('a write that fails leaves that result unsaved and says so', async () => {
    const { result: document } = scoredResultDocument();
    relayResults = [
      { result_id: 'res-1', room_id: 'room-1', received_at: '2026-09-10T15:00:00Z', qbj: document },
    ];
    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.pollResults();
      await rendered.result.current.chooseFolder();
    });
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      value: {
        invoke: async (command: string) => {
          if (command === 'write_result_file') throw new Error('That results folder no longer exists.');
          return { status: 200, body: JSON.stringify({ results: relayResults }) };
        },
      },
      configurable: true,
    });
    resetNativeHost();

    await act(async () => {
      await rendered.result.current.saveNewResults();
    });
    expect(rendered.result.current.state.results[0].savedPath).toBeUndefined();
    expect(rendered.result.current.notice?.kind).toBe('bad');
    expect(rendered.result.current.notice?.message).toMatch(/no longer exists/);
  });
});

describe('persistence', () => {
  test('a restart keeps the relay, the rooms, the codes, the round and the results', async () => {
    const { result: document } = scoredResultDocument();
    relayResults = [
      { result_id: 'res-1', room_id: 'room-1', received_at: '2026-09-10T15:00:00Z', qbj: document },
    ];
    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.publish();
      await rendered.result.current.pollResults();
      await rendered.result.current.chooseFolder();
    });
    await act(async () => {
      await rendered.result.current.saveNewResults();
    });
    const before = rendered.result.current.state;
    rendered.unmount();

    // A new window over the same storage: this is what reopening the application does.
    const restarted = renderHook(() => useBridge());
    const after = restarted.result.current.state;

    expect(after.relay).toEqual(before.relay);
    expect(after.relay?.revision).toBe(1);
    expect(after.rooms).toEqual(before.rooms);
    expect(after.rooms.map((room) => room.pairingCode)).toEqual(before.rooms.map((room) => room.pairingCode));
    expect(after.selectedRoundId).toBe(before.selectedRoundId);
    expect(after.resultFolder).toBe('/tournaments/results');
    expect(after.results.map((entry) => entry.resultId)).toEqual(['res-1']);
    expect(after.results[0].savedPath).toBeTruthy();
    expect(after.yftPath).toBe('/tournaments/spring.yft');

    // The next publish continues from the accepted revision rather than restarting at one, which
    // is what a stale-mirror refusal would otherwise be made of.
    await act(async () => {
      await restarted.result.current.loadFileContents(null, yftFixtureText());
    });
    await act(async () => {
      await restarted.result.current.publish();
    });
    await waitFor(() => expect(restarted.result.current.state.relay?.revision).toBe(2));
  });

  test('unreadable stored state starts clean rather than half-understood', () => {
    globalThis.localStorage.setItem(storageKey, '{ not json');
    expect(loadState()).toEqual({
      version: 1,
      relay: null,
      yftPath: null,
      tournamentName: null,
      rooms: [],
      selectedRoundId: null,
      resultFolder: null,
      results: [],
    });
  });
});

function bridgeStatus(
  rendered: { result: { current: ReturnType<typeof useBridge> } },
  roomId: string,
): string {
  const room = rendered.result.current.state.rooms.find((entry) => entry.id === roomId);
  if (!room) throw new Error(`no room ${roomId}`);
  return rendered.result.current.roomStatus(room);
}
