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
import { emptyState, loadState, storageKey } from './persistence';
import { resultFileSuffix } from './results';
import { scoredResultDocument } from '../tests/scoredResult';
import { yftFixtureText } from '../tests/fixture';
import { useBridge } from './useBridge';

interface InvokeCall {
  command: string;
  args: Record<string, unknown>;
}

interface RelayReply {
  status: number;
  body: string;
}

interface RelayResultRow {
  result_id: string;
  room_id: string;
  received_at: string;
  qbj: unknown;
}

interface WrittenFile {
  directory: string;
  fileName: string;
  contents: string;
  overwrite: boolean;
}

interface PendingWrite {
  path: string;
  file: WrittenFile;
  resolve(path: string): void;
  reject(reason?: unknown): void;
}

const relayBase = 'https://qbtcp-relay-test.workers.dev';
const replacementRelayBase = 'https://qbtcp-replacement-test.workers.dev';
const relayTournament = 'bcdfghjkmnpqrstvwxyz2345';

let calls: InvokeCall[] = [];
let relayResults: RelayResultRow[] = [];
let relayResultsByBase = new Map<string, RelayResultRow[]>();
let writtenFiles: WrittenFile[] = [];
/** Paths the fake filesystem already holds, so an exclusive write can be refused like the real one. */
let existingPaths = new Set<string>();
/** Set to make the next claim fail, as a wrong setup token or an unreachable relay would. */
let claimFails = false;
/** Set to make the next mirror fail without changing relay or local publication state. */
let mirrorFails = false;
let ackFailuresRemaining = 0;
let resultFolder = '/tournaments/results';
let deferResultRequests = false;
let pendingResultRequests: { resolve: (reply: RelayReply) => void; reject: (reason?: unknown) => void }[] =
  [];
let deferWrites = false;
let pendingWrites: PendingWrite[] = [];
let scorerCanPair = true;
let scorerReadinessFails = false;

function installFakeTauri(): void {
  calls = [];
  writtenFiles = [];
  const invoke = async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    switch (command) {
      case 'open_yellowfruit_file':
        return { path: '/tournaments/spring.yft', contents: yftFixtureText() };
      case 'choose_result_folder':
        return resultFolder;
      case 'write_result_file': {
        const path = `${String(args.directory)}/${String(args.fileName)}`;
        // The real command opens with `create_new` unless told to overwrite.
        if (existingPaths.has(path) && args.overwrite !== true) {
          throw new Error(`${String(args.fileName)} already exists in that folder`);
        }
        existingPaths.add(path);
        const file = args as unknown as WrittenFile;
        if (deferWrites) {
          return new Promise<string>((resolve, reject) => {
            pendingWrites.push({ path, file, resolve, reject });
          });
        }
        writtenFiles.push(file);
        return path;
      }
      case 'relay_request': {
        const url = String(args.url);
        if (url.endsWith('/manage/claim')) {
          if (claimFails) {
            return {
              status: 403,
              body: JSON.stringify({
                code: 'forbidden',
                message: 'This relay has already been claimed.',
              }),
            };
          }
          return {
            status: 200,
            body: JSON.stringify({
              tournamentId: relayTournament,
              managementToken: 'management-secret',
            }),
          };
        }
        if (url.endsWith('/scorer-readiness')) {
          if (scorerReadinessFails) return { status: 503, body: '{}' };
          return {
            status: 200,
            body: JSON.stringify({
              origin: 'https://qbsheet.com',
              canPair: scorerCanPair,
              state: scorerCanPair ? 'ready' : 'blocked',
              message: scorerCanPair
                ? 'https://qbsheet.com can pair and use this relay.'
                : 'Add https://qbsheet.com to RELAY_ALLOWED_ORIGINS in the Cloudflare deployment.',
            }),
          };
        }
        if (url.endsWith('/acks')) {
          if (ackFailuresRemaining > 0) {
            ackFailuresRemaining -= 1;
            return { status: 503, body: JSON.stringify({ message: 'temporary ACK failure' }) };
          }
          return { status: 200, body: JSON.stringify({ acked_results: 1 }) };
        }
        if (url.endsWith('/mirror')) {
          if (mirrorFails) return { status: 503, body: JSON.stringify({ message: 'relay unavailable' }) };
          return { status: 200, body: '{}' };
        }
        if (url.includes('/results')) {
          if (deferResultRequests) {
            return new Promise<RelayReply>((resolve, reject) => {
              pendingResultRequests.push({ resolve, reject });
            });
          }
          const rows = [...relayResultsByBase.entries()].find(([base]) => url.startsWith(base))?.[1];
          return { status: 200, body: JSON.stringify({ results: rows ?? relayResults }) };
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
  relayResultsByBase = new Map();
  existingPaths = new Set();
  claimFails = false;
  mirrorFails = false;
  ackFailuresRemaining = 0;
  resultFolder = '/tournaments/results';
  deferResultRequests = false;
  pendingResultRequests = [];
  deferWrites = false;
  pendingWrites = [];
  scorerCanPair = true;
  scorerReadinessFails = false;
  installFakeTauri();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as Record<string, unknown>, '__TAURI_INTERNALS__');
  resetNativeHost();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function releaseNextWrite(): void {
  const pending = pendingWrites.shift();
  if (!pending) throw new Error('no deferred write is waiting');
  writtenFiles.push(pending.file);
  pending.resolve(pending.path);
}

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
    rendered.result.current.renameRoom(second.id, 'Room 102');
  });
  await setUpRound(rendered, 3);
  return rendered;
}

async function setUpConnectedRooms() {
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
  act(() => rendered.result.current.addRoom());
  return rendered;
}

/** Choose the round first: selecting one clears every room's teams, deliberately. */
async function setUpRound(rendered: Awaited<ReturnType<typeof setUpTournament>>, index: number) {
  const round = rendered.result.current.tournament?.rounds[index];
  act(() => {
    rendered.result.current.selectRound(round!.id);
  });
  const [first, second] = rendered.result.current.state.rooms;
  act(() => {
    rendered.result.current.setRoomTeams(first.id, 'left', 'Team_Cony');
    rendered.result.current.setRoomTeams(first.id, 'right', 'Team_Deering');
    rendered.result.current.setRoomTeams(second.id, 'left', 'Team_Wells');
    rendered.result.current.setRoomTeams(second.id, 'right', 'Team_Windham A');
  });
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

    await setUpRound(rendered, 4);
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

describe('room setup and removal', () => {
  test('publishes rooms before round 1, keeps the code across restart, and accepts a later assignment', async () => {
    const rendered = await setUpConnectedRooms();
    const room = rendered.result.current.state.rooms[0];
    const activeCode = room.pairingCode;
    expect(bridgeStatus(rendered, room.id)).toBe('not-published');

    await act(async () => {
      await rendered.result.current.publishRoomSetup();
    });

    const mirrors = () =>
      calls.filter((call) => call.command === 'relay_request' && String(call.args.url).endsWith('/mirror'));
    const setupBody = JSON.parse(String(mirrors()[0].args.body)) as {
      revision: number;
      rooms: Record<string, unknown>[];
      sessions: unknown[];
    };
    expect(setupBody.revision).toBe(1);
    expect(setupBody.rooms).toHaveLength(1);
    expect(setupBody.rooms[0]).toMatchObject({ room_id: room.id, name: room.name });
    expect(setupBody.rooms[0].assignment_qbj).toBeUndefined();
    expect(setupBody.rooms[0].match_id).toBeUndefined();
    expect(setupBody.rooms[0].pairing_expires_at).toBeUndefined();
    expect(setupBody.sessions).toEqual([]);
    expect(rendered.result.current.state.rooms[0]).toMatchObject({
      pairingCode: activeCode,
      pendingPairingCode: null,
      relayPublished: true,
      publishedMatchId: null,
    });
    expect(bridgeStatus(rendered, room.id)).toBe('ready-to-pair');

    rendered.unmount();
    const restarted = renderHook(() => useBridge());
    expect(restarted.result.current.state.rooms[0]).toMatchObject({
      pairingCode: activeCode,
      pendingPairingCode: null,
      relayPublished: true,
    });

    await act(async () => {
      restarted.result.current.loadFileContents(null, yftFixtureText());
    });
    const restartedRoom = restarted.result.current.state.rooms[0];
    expect(bridgeStatus(restarted, restartedRoom.id)).toBe('ready-to-pair');
    act(() => {
      restarted.result.current.setRoomTeams(restartedRoom.id, 'left', 'Team_Cony');
      restarted.result.current.setRoomTeams(restartedRoom.id, 'right', 'Team_Deering');
    });
    await act(async () => {
      await restarted.result.current.publish();
    });

    const assignmentBody = JSON.parse(String(mirrors()[1].args.body)) as {
      revision: number;
      rooms: Record<string, unknown>[];
    };
    expect(assignmentBody.revision).toBe(2);
    expect(assignmentBody.rooms[0].pairing_code_hash).toBe(setupBody.rooms[0].pairing_code_hash);
    expect(assignmentBody.rooms[0].assignment_qbj).toBeTruthy();
    expect(restarted.result.current.state.rooms[0]).toMatchObject({
      pairingCode: activeCode,
      pendingPairingCode: null,
      relayPublished: true,
    });
    expect(bridgeStatus(restarted, restartedRoom.id)).toBe('waiting');
    restarted.unmount();
  });

  test('assignment clearing returns a published room to ready to pair', async () => {
    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.publish();
    });
    const [, unused] = rendered.result.current.state.rooms;
    expect(bridgeStatus(rendered, unused.id)).toBe('waiting');

    act(() => {
      rendered.result.current.setRoomTeams(unused.id, 'left', null);
      rendered.result.current.setRoomTeams(unused.id, 'right', null);
    });
    await act(async () => {
      await rendered.result.current.publish();
    });

    expect(rendered.result.current.state.rooms.find((room) => room.id === unused.id)).toMatchObject({
      relayPublished: true,
      publishedMatchId: null,
      publishedRoundId: null,
    });
    expect(bridgeStatus(rendered, unused.id)).toBe('ready-to-pair');
  });

  test('keeps the old code active through a failed publish, then activates the pending code', async () => {
    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.publish();
    });
    const room = rendered.result.current.state.rooms[0];
    const oldCode = room.pairingCode;
    act(() => rendered.result.current.regeneratePairingCode(room.id));
    const pendingCode = rendered.result.current.state.rooms[0].pendingPairingCode;
    expect(pendingCode).toBeTruthy();
    expect(pendingCode).not.toBe(oldCode);
    expect(rendered.result.current.state.rooms[0].pairingCode).toBe(oldCode);

    mirrorFails = true;
    await act(async () => {
      await rendered.result.current.publish();
    });
    expect(rendered.result.current.state.rooms[0]).toMatchObject({
      pairingCode: oldCode,
      pendingPairingCode: pendingCode,
    });
    expect(rendered.result.current.state.relay?.revision).toBe(1);

    mirrorFails = false;
    await act(async () => {
      await rendered.result.current.publish();
    });
    expect(rendered.result.current.state.rooms[0]).toMatchObject({
      pairingCode: pendingCode,
      pendingPairingCode: null,
    });
    expect(rendered.result.current.state.relay?.revision).toBe(2);
  });

  test('persists a published-room tombstone and clears it without touching sessions', async () => {
    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.publish();
    });
    const removed = rendered.result.current.state.rooms[0];
    const priorMirror = JSON.parse(
      String(
        calls.find((call) => call.command === 'relay_request' && String(call.args.url).endsWith('/mirror'))
          ?.args.body,
      ),
    ) as { rooms: Record<string, unknown>[] };
    const prior = priorMirror.rooms.find((entry) => entry.room_id === removed.id)!;

    act(() => rendered.result.current.removeRoom(removed.id));
    expect(rendered.result.current.state.rooms.some((room) => room.id === removed.id)).toBe(false);
    expect(loadState().pendingRoomRemovals).toEqual([
      expect.objectContaining({ id: removed.id, pairingCode: removed.pairingCode, pendingPairingCode: null }),
    ]);
    rendered.unmount();

    const restarted = renderHook(() => useBridge());
    await act(async () => {
      restarted.result.current.loadFileContents(null, yftFixtureText());
      await restarted.result.current.publishRoomSetup();
    });

    const mirrorCalls = calls.filter(
      (call) => call.command === 'relay_request' && String(call.args.url).endsWith('/mirror'),
    );
    const clearing = JSON.parse(String(mirrorCalls[1].args.body)) as {
      revision: number;
      rooms: Record<string, unknown>[];
      sessions: unknown[];
    };
    const tombstone = clearing.rooms.find((entry) => entry.room_id === removed.id)!;
    expect(clearing.revision).toBe(2);
    expect(tombstone).toBeTruthy();
    expect(tombstone.pairing_code_hash).toBe(prior.pairing_code_hash);
    expect(tombstone.assignment_qbj).toBeUndefined();
    expect(tombstone.match_id).toBeUndefined();
    expect(clearing.sessions).toEqual([]);
    expect(restarted.result.current.state.pendingRoomRemovals).toEqual([]);
    expect(restarted.result.current.state.retiredRoomIds).toContain(removed.id);
    restarted.unmount();
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
    expect(writtenFiles[0].fileName).toBe(
      `R04_Room-101_Cony_vs_Deering_${resultFileSuffix('res-1')}.result.qbj`,
    );
    // A first save must not be allowed to land on a file that is already in the folder.
    expect(writtenFiles[0].overwrite).toBe(false);
    expect(JSON.parse(writtenFiles[0].contents)).toEqual(JSON.parse(JSON.stringify(document)));
    expect(rendered.result.current.state.results[0].savedPath).toBe(
      `/tournaments/results/R04_Room-101_Cony_vs_Deering_${resultFileSuffix('res-1')}.result.qbj`,
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

  test('a folder change makes Save again an exclusive write', async () => {
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
      await rendered.result.current.saveResult('res-1');
    });

    resultFolder = '/tournaments/other-results';
    await act(async () => {
      await rendered.result.current.chooseFolder();
    });
    await act(async () => {
      await rendered.result.current.saveResult('res-1');
    });

    expect(writtenFiles).toHaveLength(2);
    expect(writtenFiles[0].directory).toBe('/tournaments/results');
    expect(writtenFiles[0].overwrite).toBe(false);
    expect(writtenFiles[1].directory).toBe('/tournaments/other-results');
    expect(writtenFiles[1].overwrite).toBe(false);
    expect(rendered.result.current.state.results[0].savedPath).toBe(
      `/tournaments/other-results/R04_Room-101_Cony_vs_Deering_${resultFileSuffix('res-1')}.result.qbj`,
    );
  });

  test('a batch save prevents a concurrent individual save of the same result', async () => {
    const { result: document } = scoredResultDocument();
    relayResults = [
      { result_id: 'res-1', room_id: 'room-1', received_at: '2026-09-10T15:00:00Z', qbj: document },
    ];
    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.pollResults();
      await rendered.result.current.chooseFolder();
    });

    deferWrites = true;
    let batch!: Promise<void>;
    await act(async () => {
      batch = rendered.result.current.saveNewResults();
      await Promise.resolve();
    });
    expect(pendingWrites).toHaveLength(1);
    expect(rendered.result.current.savingResults).toBe(true);
    expect(rendered.result.current.resultBusy('res-1')).toBe(true);

    await act(async () => {
      await rendered.result.current.saveResult('res-1');
    });
    expect(calls.filter((call) => call.command === 'write_result_file')).toHaveLength(1);

    await act(async () => {
      releaseNextWrite();
      await batch;
    });
    expect(writtenFiles).toHaveLength(1);
    expect(rendered.result.current.savingResults).toBe(false);
  });
});

describe('stale result polls', () => {
  test('a success from a replaced relay is discarded', async () => {
    vi.useFakeTimers();
    const { result: document } = scoredResultDocument();
    relayResults = [
      { result_id: 'old-result', room_id: 'room-1', received_at: '2026-09-10T15:00:00Z', qbj: document },
    ];
    relayResultsByBase.set(replacementRelayBase, []);
    const rendered = await setUpTournament();

    deferResultRequests = true;
    const poll = rendered.result.current.pollResults();
    expect(pendingResultRequests).toHaveLength(1);
    deferResultRequests = false;

    await act(async () => {
      await rendered.result.current.connectRelay({
        baseUrl: replacementRelayBase,
        tournamentId: relayTournament,
        setupToken: 'replacement',
      });
    });
    expect(rendered.result.current.relayReachable).toBe(true);

    const pending = pendingResultRequests.shift();
    if (!pending) throw new Error('the old relay poll was not waiting');
    pending.resolve({ status: 200, body: JSON.stringify({ results: relayResults }) });
    await act(async () => {
      await poll;
    });

    expect(rendered.result.current.state.results).toEqual([]);
    expect(rendered.result.current.relayReachable).toBe(true);
  });

  test('a failure from a replaced relay does not mark the replacement unavailable', async () => {
    vi.useFakeTimers();
    relayResultsByBase.set(replacementRelayBase, []);
    const rendered = await setUpTournament();

    deferResultRequests = true;
    const poll = rendered.result.current.pollResults();
    expect(pendingResultRequests).toHaveLength(1);
    deferResultRequests = false;

    await act(async () => {
      await rendered.result.current.connectRelay({
        baseUrl: replacementRelayBase,
        tournamentId: relayTournament,
        setupToken: 'replacement',
      });
    });
    expect(rendered.result.current.relayReachable).toBe(true);

    const pending = pendingResultRequests.shift();
    if (!pending) throw new Error('the old relay poll was not waiting');
    pending.reject(new Error('old relay went away'));
    await act(async () => {
      await poll;
    });

    expect(rendered.result.current.relayReachable).toBe(true);
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
      scorerReadiness: null,
      yftPath: null,
      tournamentName: null,
      rooms: [],
      pendingRoomRemovals: [],
      retiredRoomIds: [],
      selectedRoundId: null,
      resultFolder: null,
      results: [],
    });
  });
});

describe('YellowFruit file boundaries', () => {
  test('an invalid first file leaves the empty bridge state empty', () => {
    const rendered = renderHook(() => useBridge());
    act(() => {
      rendered.result.current.loadFileContents('/tournaments/bad.yft', '{ not a YellowFruit file');
    });

    expect(rendered.result.current.tournament).toBeNull();
    expect(rendered.result.current.state).toEqual(emptyState());
    expect(rendered.result.current.notice?.kind).toBe('bad');
  });

  test('a failed reload preserves the current valid tournament and state', async () => {
    const rendered = await setUpTournament();
    const beforeTournament = rendered.result.current.tournament;
    const beforeState = rendered.result.current.state;

    act(() => {
      rendered.result.current.loadFileContents('/tournaments/corrupt.yft', '{ truncated');
    });

    expect(rendered.result.current.tournament).toBe(beforeTournament);
    expect(rendered.result.current.state).toEqual(beforeState);
    expect(loadState()).toEqual(beforeState);
    expect(rendered.result.current.notice?.kind).toBe('bad');

    // A later valid same-file reload still works after the failed attempt.
    act(() => {
      rendered.result.current.loadFileContents('/tournaments/spring.yft', yftFixtureText());
    });
    expect(rendered.result.current.tournament).not.toBeNull();
    expect(rendered.result.current.state.relay).toEqual(beforeState.relay);
    expect(rendered.result.current.state.rooms).toEqual(beforeState.rooms);
  });

  test('a same-path reload refreshes YellowFruit data without resetting bridge state', async () => {
    const rendered = await setUpTournament();
    const before = rendered.result.current.state;
    const refreshed = yftFixtureText().replace(
      '2025 MEQBA Season Opener - Revised',
      '2025 MEQBA Season Opener - Updated',
    );

    act(() => {
      rendered.result.current.loadFileContents('/tournaments/spring.yft', refreshed);
    });

    expect(rendered.result.current.tournament?.name).toBe('2025 MEQBA Season Opener - Updated');
    expect(rendered.result.current.state.relay).toEqual(before.relay);
    expect(rendered.result.current.state.rooms).toEqual(before.rooms);
    expect(rendered.result.current.state.results).toEqual(before.results);
    expect(rendered.result.current.state.yftPath).toBe('/tournaments/spring.yft');
  });

  test('a current-file reload dismisses an older different-file confirmation', async () => {
    const rendered = await setUpTournament();
    const otherFile = yftFixtureText().replace(
      '2025 MEQBA Season Opener - Revised',
      '2025 Winter Invitational',
    );

    act(() => {
      rendered.result.current.loadFileContents('/tournaments/winter.yft', otherFile);
    });
    expect(rendered.result.current.pendingFileSwitch).not.toBeNull();

    act(() => {
      rendered.result.current.loadFileContents('/tournaments/spring.yft', yftFixtureText());
    });

    expect(rendered.result.current.pendingFileSwitch).toBeNull();
    expect(rendered.result.current.state.yftPath).toBe('/tournaments/spring.yft');
    expect(rendered.result.current.state.relay).not.toBeNull();
  });

  test('a different valid file requires confirmation and starts clean after confirmation', async () => {
    const rendered = await setUpTournament();
    const { result: document } = scoredResultDocument();
    relayResults = [
      { result_id: 'old-result', room_id: 'room-1', received_at: '2026-09-10T15:00:00Z', qbj: document },
    ];
    await act(async () => {
      await rendered.result.current.pollResults();
    });
    const before = rendered.result.current.state;
    const otherFile = yftFixtureText().replace(
      '2025 MEQBA Season Opener - Revised',
      '2025 Winter Invitational',
    );

    act(() => {
      rendered.result.current.loadFileContents('/tournaments/winter.yft', otherFile);
    });
    expect(rendered.result.current.pendingFileSwitch).toMatchObject({
      path: '/tournaments/winter.yft',
      tournamentName: '2025 Winter Invitational',
    });
    expect(rendered.result.current.state).toEqual(before);
    expect(rendered.result.current.tournament?.name).toBe(before.tournamentName);

    act(() => rendered.result.current.cancelFileSwitch());
    expect(rendered.result.current.pendingFileSwitch).toBeNull();
    expect(rendered.result.current.state).toEqual(before);

    act(() => {
      rendered.result.current.loadFileContents('/tournaments/winter.yft', otherFile);
    });
    act(() => rendered.result.current.confirmFileSwitch());

    expect(rendered.result.current.pendingFileSwitch).toBeNull();
    expect(rendered.result.current.tournament?.name).toBe('2025 Winter Invitational');
    expect(rendered.result.current.state).toMatchObject({
      relay: null,
      rooms: [],
      pendingRoomRemovals: [],
      retiredRoomIds: [],
      selectedRoundId: 'Phase_Prelims__round_1',
      resultFolder: before.resultFolder,
      results: [],
      yftPath: '/tournaments/winter.yft',
      tournamentName: '2025 Winter Invitational',
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

/**
 * Changing rounds.
 *
 * The mistake this prevents is the cheapest one on the screen to make: choose round 5, leave
 * round 4's dropdowns as they are, and press Publish. The rooms would receive real, correctly
 * formatted round 5 assignments for round 4's matchups, score them, and YellowFruit would import
 * them without a word of complaint.
 */
describe('changing the round', () => {
  test('clears the team selections and keeps everything else about the room', async () => {
    const rendered = await setUpTournament();
    const before = rendered.result.current.state.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      code: room.pairingCode,
    }));
    expect(rendered.result.current.state.rooms[0].leftTeamId).toBe('Team_Cony');
    expect(rendered.result.current.roundChangeDiscardsSelections).toBe(true);

    const nextRound = rendered.result.current.tournament!.rounds[4];
    act(() => {
      rendered.result.current.selectRound(nextRound.id);
    });

    const after = rendered.result.current.state.rooms;
    expect(rendered.result.current.state.selectedRoundId).toBe(nextRound.id);
    // Rooms, names and codes are the tournament's physical setup and survive.
    expect(after.map((room) => ({ id: room.id, name: room.name, code: room.pairingCode }))).toEqual(before);
    // The pairings do not.
    expect(after.every((room) => room.leftTeamId === null && room.rightTeamId === null)).toBe(true);
    expect(rendered.result.current.roundChangeDiscardsSelections).toBe(false);
  });

  test('the cleared pairings cannot be published as the new round', async () => {
    const rendered = await setUpTournament();
    const nextRound = rendered.result.current.tournament!.rounds[4];
    act(() => {
      rendered.result.current.selectRound(nextRound.id);
    });

    await act(async () => {
      await rendered.result.current.publish();
    });

    // Nothing reached the relay, and the operator was told why rather than left to discover it.
    expect(calls.some((call) => String(call.args.url ?? '').endsWith('/mirror'))).toBe(false);
    expect(rendered.result.current.notice?.kind).toBe('bad');
    expect(rendered.result.current.notice?.message).toMatch(/two teams chosen/i);
    expect(rendered.result.current.state.relay?.revision).toBe(0);
  });

  test('reselecting the round already chosen changes nothing', async () => {
    const rendered = await setUpTournament();
    const current = rendered.result.current.state.selectedRoundId!;
    act(() => {
      rendered.result.current.selectRound(current);
    });
    expect(rendered.result.current.state.rooms[0].leftTeamId).toBe('Team_Cony');
  });
});

/**
 * Replacing the relay.
 *
 * A relay's setup token is consumed by the claim that produced its management credential. A
 * credential deleted before a replacement exists is a tournament that cannot publish and cannot
 * get its results back, so "Change Relay" must not be a delete with a friendly name.
 */
describe('changing the relay', () => {
  test('opening the form keeps the current credential', async () => {
    const rendered = await setUpTournament();
    const before = rendered.result.current.state.relay;
    expect(before?.managementToken).toBe('management-secret');

    act(() => {
      rendered.result.current.beginRelayChange();
    });
    expect(rendered.result.current.changingRelay).toBe(true);
    expect(rendered.result.current.state.relay).toEqual(before);
  });

  test('cancelling leaves the original relay in place and usable', async () => {
    const rendered = await setUpTournament();
    const before = rendered.result.current.state.relay;

    act(() => {
      rendered.result.current.beginRelayChange();
    });
    act(() => {
      rendered.result.current.cancelRelayChange();
    });

    expect(rendered.result.current.changingRelay).toBe(false);
    expect(rendered.result.current.state.relay).toEqual(before);

    // Still usable: a publish goes out under the original credential.
    await act(async () => {
      await rendered.result.current.publish();
    });
    const mirror = calls.find((call) => String(call.args.url ?? '').endsWith('/mirror'));
    expect(mirror?.args.bearer).toBe('management-secret');
  });

  test('a failed claim leaves the working credential untouched', async () => {
    const rendered = await setUpTournament();
    const before = rendered.result.current.state.relay;
    claimFails = true;

    act(() => {
      rendered.result.current.beginRelayChange();
    });
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await rendered.result.current.connectRelay({
        baseUrl: 'https://qbtcp-relay-other.workers.dev',
        tournamentId: relayTournament,
        setupToken: 'already-used',
      });
    });

    expect(accepted).toBe(false);
    expect(rendered.result.current.state.relay).toEqual(before);
    expect(rendered.result.current.notice?.kind).toBe('bad');
    expect(rendered.result.current.notice?.message).toMatch(/already been claimed/);
    expect(rendered.result.current.notice?.message).toMatch(/unchanged/);
    // The form stays open so the operator can correct the address and try again.
    expect(rendered.result.current.changingRelay).toBe(true);

    // And the original still works.
    await act(async () => {
      await rendered.result.current.publish();
    });
    const mirror = calls.find((call) => String(call.args.url ?? '').endsWith('/mirror'));
    expect(mirror?.args.bearer).toBe('management-secret');
  });

  test('the replacement is stored only after the new claim succeeds', async () => {
    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.publish();
    });
    const beforeRooms = rendered.result.current.state.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      pairingCode: room.pairingCode,
      leftTeamId: room.leftTeamId,
      rightTeamId: room.rightTeamId,
    }));
    act(() => {
      rendered.result.current.beginRelayChange();
    });
    await act(async () => {
      await rendered.result.current.connectRelay({
        baseUrl: 'https://qbtcp-relay-other.workers.dev/',
        tournamentId: relayTournament,
        setupToken: 'fresh',
      });
    });

    expect(rendered.result.current.state.relay?.baseUrl).toBe('https://qbtcp-relay-other.workers.dev');
    // A different relay is a different object with its own revision counter.
    expect(rendered.result.current.state.relay?.revision).toBe(0);
    expect(rendered.result.current.changingRelay).toBe(false);
    expect(rendered.result.current.notice?.message).toMatch(/Publish Room Setup to activate these rooms/);
    expect(
      rendered.result.current.state.rooms.map((room) => ({
        id: room.id,
        name: room.name,
        pairingCode: room.pairingCode,
        leftTeamId: room.leftTeamId,
        rightTeamId: room.rightTeamId,
        relayPublished: room.relayPublished,
        publishedMatchId: room.publishedMatchId,
        publishedRoundId: room.publishedRoundId,
        assignmentRevision: room.assignmentRevision,
      })),
    ).toEqual(
      beforeRooms.map((room) => ({
        ...room,
        relayPublished: false,
        publishedMatchId: null,
        publishedRoundId: null,
        assignmentRevision: 0,
      })),
    );
  });

  test('forgetting the credential is a separate, explicit action', async () => {
    const rendered = await setUpTournament();
    act(() => {
      rendered.result.current.forgetRelayCredential();
    });
    expect(rendered.result.current.state.relay).toBeNull();
    // It says what happened rather than looking like a successful change.
    expect(rendered.result.current.notice?.kind).toBe('warn');
    expect(rendered.result.current.notice?.message).toMatch(/deleted from this machine/);
  });
});

describe('critical relay persistence', () => {
  test('does not consume a setup token when the storage preflight fails', async () => {
    const setItem = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage is unavailable');
    });
    const rendered = renderHook(() => useBridge());

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await rendered.result.current.connectRelay({
        baseUrl: relayBase,
        tournamentId: relayTournament,
        setupToken: 'one-time',
      });
    });

    expect(accepted).toBe(false);
    expect(calls.filter((call) => String(call.args.url ?? '').endsWith('/manage/claim'))).toEqual([]);
    expect(rendered.result.current.state).toEqual(emptyState());
    expect(rendered.result.current.notice?.message).toMatch(/setup token was not sent/);
    setItem.mockRestore();
  });

  test('holds a claimed credential for an in-session persistence retry without false success', async () => {
    const originalSetItem = globalThis.localStorage.setItem.bind(globalThis.localStorage);
    let writes = 0;
    const setItem = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation((key, value) => {
      writes += 1;
      if (writes === 2) throw new Error('storage became unavailable after the claim');
      originalSetItem(key, value);
    });
    const rendered = renderHook(() => useBridge());

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await rendered.result.current.connectRelay({
        baseUrl: relayBase,
        tournamentId: relayTournament,
        setupToken: 'one-time',
      });
    });

    expect(accepted).toBe(false);
    expect(rendered.result.current.state.relay).toBeNull();
    expect(rendered.result.current.relayCredentialSavePending).toBe(true);
    expect(rendered.result.current.changingRelay).toBe(true);
    expect(rendered.result.current.notice?.message).not.toContain('management-secret');
    expect(JSON.stringify(loadState())).not.toContain('management-secret');

    let retried: boolean | undefined;
    await act(async () => {
      retried = await rendered.result.current.retryRelayCredentialSave();
    });

    expect(retried).toBe(true);
    expect(rendered.result.current.relayCredentialSavePending).toBe(false);
    expect(rendered.result.current.state.relay?.managementToken).toBe('management-secret');
    expect(loadState().relay?.managementToken).toBe('management-secret');
    setItem.mockRestore();
  });

  test('a replacement claim cannot silently replace the old durable relay', async () => {
    const rendered = await setUpTournament();
    const oldRelay = rendered.result.current.state.relay;
    const originalSetItem = globalThis.localStorage.setItem.bind(globalThis.localStorage);
    let writes = 0;
    const setItem = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation((key, value) => {
      writes += 1;
      if (writes === 2) throw new Error('storage failed while replacing relay');
      originalSetItem(key, value);
    });

    act(() => rendered.result.current.beginRelayChange());
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await rendered.result.current.connectRelay({
        baseUrl: replacementRelayBase,
        tournamentId: relayTournament,
        setupToken: 'replacement',
      });
    });

    expect(accepted).toBe(false);
    expect(rendered.result.current.state.relay).toEqual(oldRelay);
    expect(loadState().relay).toEqual(oldRelay);
    expect(rendered.result.current.relayCredentialSavePending).toBe(true);
    expect(calls.filter((call) => String(call.args.url ?? '').endsWith('/manage/claim'))).toHaveLength(2);
    setItem.mockRestore();
  });

  test('warns and offers recovery when a relay accepts a publication but its revision is not saved', async () => {
    const rendered = await setUpTournament();
    const originalSetItem = globalThis.localStorage.setItem.bind(globalThis.localStorage);
    const setItem = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage failed after remote publication');
    });

    await act(async () => {
      await rendered.result.current.publish();
    });

    expect(rendered.result.current.state.relay?.revision).toBe(1);
    expect(loadState().relay?.revision).toBe(0);
    expect(rendered.result.current.persistenceSavePending).toBe(true);
    expect(rendered.result.current.notice?.message).toMatch(/accepted it.*could not save the new revision/i);

    setItem.mockRestore();
    // Keep the original reference used above alive for the test's explicit recovery boundary.
    expect(originalSetItem).toBeTypeOf('function');
    act(() => {
      expect(rendered.result.current.retryStatePersistence()).toBe(true);
    });
    expect(rendered.result.current.persistenceSavePending).toBe(false);
    expect(loadState().relay?.revision).toBe(1);
  });
});

describe('Scorer origin readiness', () => {
  test('persists a blocked readiness result without discarding the claimed credential', async () => {
    globalThis.localStorage.removeItem(storageKey);
    scorerCanPair = false;
    const rendered = renderHook(() => useBridge());

    await act(async () => {
      await rendered.result.current.connectRelay({
        baseUrl: relayBase,
        tournamentId: relayTournament,
        setupToken: 'one-time',
      });
    });

    expect(rendered.result.current.state.relay?.managementToken).toBe('management-secret');
    expect(rendered.result.current.scorerReadiness).toMatchObject({
      status: 'blocked',
      origin: 'https://qbsheet.com',
    });
    expect(rendered.result.current.notice).toMatchObject({ kind: 'warn' });
    expect(rendered.result.current.notice?.message).toMatch(/RELAY_ALLOWED_ORIGINS/);
    expect(loadState().scorerReadiness).toMatchObject({ status: 'blocked' });
  });

  test('keeps the new management credential when readiness cannot be checked', async () => {
    globalThis.localStorage.removeItem(storageKey);
    scorerReadinessFails = true;
    const rendered = renderHook(() => useBridge());

    await act(async () => {
      await rendered.result.current.connectRelay({
        baseUrl: relayBase,
        tournamentId: relayTournament,
        setupToken: 'one-time',
      });
    });

    expect(rendered.result.current.state.relay?.managementToken).toBe('management-secret');
    expect(rendered.result.current.scorerReadiness).toMatchObject({ status: 'unknown' });
    expect(rendered.result.current.notice?.message).toMatch(/Do not pair until this check succeeds/);
    expect(loadState().relay?.managementToken).toBe('management-secret');
    expect(loadState().scorerReadiness).toMatchObject({ status: 'unknown' });
  });
});

/**
 * Two legitimate results for one game.
 *
 * A room that submitted a correction leaves the relay holding two finals with the same match, the
 * same room and the same two teams. Their descriptive filenames are identical; only the suffix
 * differs, and the native writer refuses to open an existing file besides.
 */
describe('a corrected result', () => {
  test('gets its own file and never lands on top of the first', async () => {
    const { result: original } = scoredResultDocument();
    const corrected = JSON.parse(JSON.stringify(original)) as {
      objects: Record<string, unknown>[];
    };
    const match = corrected.objects.find((entry) => entry.type === 'Match') as Record<string, unknown>;
    (match.match_teams as Record<string, unknown>[])[0].points = 35;

    relayResults = [
      { result_id: 'result-aaa', room_id: 'room-1', received_at: '2026-09-11T15:00:00Z', qbj: original },
      {
        result_id: 'result-bbb',
        room_id: 'room-1',
        received_at: '2026-09-11T15:20:00Z',
        qbj: corrected,
      },
    ];

    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.pollResults();
      await rendered.result.current.chooseFolder();
    });
    await act(async () => {
      await rendered.result.current.saveNewResults();
    });

    // Same match, same teams, same room — two files.
    expect(writtenFiles).toHaveLength(2);
    const names = writtenFiles.map((file) => file.fileName);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name).toMatch(/^R04_Room-101_Cony_vs_Deering_[0-9a-f]{12}\.result\.qbj$/);
    }

    // Each result records its own path, and the first file still holds the first result.
    const [first, second] = rendered.result.current.state.results;
    expect(first.savedPath).toBeTruthy();
    expect(second.savedPath).toBeTruthy();
    expect(first.savedPath).not.toBe(second.savedPath);
    expect(JSON.parse(writtenFiles[0].contents)).toEqual(JSON.parse(JSON.stringify(original)));
    expect(JSON.parse(writtenFiles[1].contents)).toEqual(JSON.parse(JSON.stringify(corrected)));
  });

  test('a name that is somehow already taken is refused rather than overwritten', async () => {
    const { result: document } = scoredResultDocument();
    relayResults = [
      { result_id: 'result-aaa', room_id: 'room-1', received_at: '2026-09-11T15:00:00Z', qbj: document },
    ];
    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.pollResults();
      await rendered.result.current.chooseFolder();
    });
    // Something else is already at that path — a file restored from a backup, say.
    existingPaths.add(
      `/tournaments/results/R04_Room-101_Cony_vs_Deering_${resultFileSuffix('result-aaa')}.result.qbj`,
    );

    await act(async () => {
      await rendered.result.current.saveNewResults();
    });

    expect(writtenFiles).toHaveLength(0);
    expect(rendered.result.current.state.results[0].savedPath).toBeUndefined();
    expect(rendered.result.current.notice?.kind).toBe('bad');
    expect(rendered.result.current.notice?.message).toMatch(/already exists/);
  });
});

/**
 * The relay's unacknowledged window.
 *
 * `GET results?state=unacked` serves the oldest 128 and has no page behind it, so a build that
 * never acknowledged would lose access to result 129. Acknowledging exactly what is on disk turns
 * that endpoint into an unsaved-results queue.
 */
describe('acknowledging saved results', () => {
  test('a result is acknowledged after it is written, and not before', async () => {
    const { result: document } = scoredResultDocument();
    relayResults = [
      { result_id: 'result-aaa', room_id: 'room-1', received_at: '2026-09-11T15:00:00Z', qbj: document },
    ];
    const rendered = await setUpTournament();

    await act(async () => {
      await rendered.result.current.pollResults();
    });
    // Received and displayed is not saved. Nothing has been acknowledged.
    expect(calls.some((call) => String(call.args.url ?? '').endsWith('/acks'))).toBe(false);

    await act(async () => {
      await rendered.result.current.chooseFolder();
    });
    await act(async () => {
      await rendered.result.current.saveNewResults();
    });

    const ack = calls.find((call) => String(call.args.url ?? '').endsWith('/acks'));
    expect(ack).toBeTruthy();
    expect(ack?.args.method).toBe('POST');
    expect(JSON.parse(String(ack?.args.body))).toEqual({ results: ['result-aaa'] });
  });

  test('a result that failed to save is not acknowledged', async () => {
    const { result: document } = scoredResultDocument();
    relayResults = [
      { result_id: 'result-aaa', room_id: 'room-1', received_at: '2026-09-11T15:00:00Z', qbj: document },
    ];
    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.pollResults();
      await rendered.result.current.chooseFolder();
    });
    existingPaths.add(
      `/tournaments/results/R04_Room-101_Cony_vs_Deering_${resultFileSuffix('result-aaa')}.result.qbj`,
    );

    await act(async () => {
      await rendered.result.current.saveNewResults();
    });

    // The bytes are not on disk, so the relay keeps holding it.
    const ackCalls = calls.filter((call) => String(call.args.url ?? '').endsWith('/acks'));
    expect(ackCalls).toEqual([]);
  });

  test('a failed ACK is retried after restart while the saved file stays safe', async () => {
    vi.useFakeTimers();
    const { result: document } = scoredResultDocument();
    relayResults = [
      { result_id: 'result-aaa', room_id: 'room-1', received_at: '2026-09-11T15:00:00Z', qbj: document },
    ];
    ackFailuresRemaining = 1;
    const rendered = await setUpTournament();

    await act(async () => {
      await rendered.result.current.pollResults();
      await rendered.result.current.chooseFolder();
    });
    await act(async () => {
      await rendered.result.current.saveNewResults();
    });

    expect(rendered.result.current.state.results[0].savedPath).toBeTruthy();
    expect(rendered.result.current.state.results[0].ackPending).toBe(true);
    expect(calls.filter((call) => String(call.args.url ?? '').endsWith('/acks'))).toHaveLength(1);
    const persisted = JSON.parse(globalThis.localStorage.getItem(storageKey) ?? '{}') as {
      results?: { ackPending?: boolean }[];
    };
    expect(persisted.results?.[0]?.ackPending).toBe(true);

    rendered.unmount();
    const restarted = renderHook(() => useBridge());
    expect(restarted.result.current.state.results[0].savedPath).toBeTruthy();
    expect(restarted.result.current.state.results[0].ackPending).toBe(true);

    await act(async () => {
      await restarted.result.current.pollResults();
    });

    expect(calls.filter((call) => String(call.args.url ?? '').endsWith('/acks'))).toHaveLength(2);
    expect(restarted.result.current.state.results[0].ackPending).toBe(false);
  });

  test('the operator is warned before unsaved results reach the relay’s window', async () => {
    const { result: document } = scoredResultDocument();
    relayResults = Array.from({ length: 100 }, (_, index) => ({
      result_id: `result-${index}`,
      room_id: 'room-1',
      received_at: `2026-09-11T15:${String(index % 60).padStart(2, '0')}:00Z`,
      qbj: document,
    }));
    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.pollResults();
    });

    expect(rendered.result.current.state.results).toHaveLength(100);
    expect(rendered.result.current.unsavedResultWarning).toMatch(/100 results are still unsaved/);
    expect(rendered.result.current.unsavedResultWarning).toMatch(/oldest 128/);
  });
});
