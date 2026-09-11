/**
 * A morning, end to end, with the Tauri bridge faked at the boundary.
 *
 * Faking `__TAURI_INTERNALS__.invoke` rather than the four wrapper functions is deliberate: it
 * exercises the command names and argument shapes the Rust side actually declares, so a rename on
 * one side of that boundary fails here instead of on a laptop at a tournament.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { defineGame, readQbjSource } from '../../../../src/qbj/ParseQbjAssignment';
import { assignmentFingerprint } from './assignment';
import { resetNativeHost } from './native';
import { emptyState, loadState, storageKey } from './persistence';
import { resultFileSuffix } from './results';
import { scoredResultDocument } from '../tests/scoredResult';
import { yftFixtureText } from '../tests/fixture';
import { operationsRefreshMs, resultPollIntervalMs, useBridge } from './useBridge';

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
let secureCredentials = new Map<string, string>();
let recoveryPackage: { path: string; contents: string } | null = null;
let relayResults: RelayResultRow[] = [];
let relayResultsByBase = new Map<string, RelayResultRow[]>();
/** Director sessions view for the operations snapshot; empty unless a test stages presence. */
let relaySessions: unknown[] = [];
/** Open help requests for the operations snapshot. */
let relayHelp: unknown[] = [];
let writtenFiles: WrittenFile[] = [];
let writtenAssignmentFiles: WrittenFile[] = [];
/** Paths the fake filesystem already holds, so an exclusive write can be refused like the real one. */
let existingPaths = new Set<string>();
/** Set to make the next claim fail, as a wrong setup token or an unreachable relay would. */
let claimFails = false;
/** Set to make the next mirror fail without changing relay or local publication state. */
let mirrorFails = false;
let mirrorFailureStatus = 503;
/**
 * Set to hold the next mirror open until it resolves.
 *
 * The point is to reproduce the one interleaving that can silently corrupt a round: a mirror built
 * from A-vs-B is in flight, the operator changes the plan to A-vs-C, and the response arrives. The
 * relay really is holding A-vs-B, so the room must record that — and must not roll the newer plan
 * back to the snapshot that was sent.
 */
let deferMirror: Promise<void> | null = null;
/** True once a deferred mirror has actually been issued, so the test knows when to edit. */
let deferredMirrorStarted = false;
let ackFailuresRemaining = 0;
let resultFolder = '/tournaments/results';
let assignmentFolder = '/tournaments/assignments';
let deferResultRequests = false;
let pendingResultRequests: { resolve: (reply: RelayReply) => void; reject: (reason?: unknown) => void }[] =
  [];
let deferWrites = false;
let pendingWrites: PendingWrite[] = [];
let scorerCanPair = true;
let scorerReadinessFails = false;
let activeController: 'primary' | 'backup' = 'primary';
let relayEpoch = 1;
let relayRevision = 0;
const backupControllerId = 'backup-test-controller';
const backupToken = 'backup-management-secret';

function installFakeTauri(): void {
  calls = [];
  secureCredentials = new Map();
  writtenFiles = [];
  writtenAssignmentFiles = [];
  const invoke = async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    switch (command) {
      case 'open_yellowfruit_file':
        return { path: '/tournaments/spring.yft', contents: yftFixtureText() };
      case 'choose_result_folder':
        return resultFolder;
      case 'choose_assignment_folder':
        return assignmentFolder;
      case 'write_assignment_file': {
        const path = `${String(args.directory)}/${String(args.fileName)}`;
        if (existingPaths.has(path)) throw new Error(`${String(args.fileName)} already exists`);
        existingPaths.add(path);
        writtenAssignmentFiles.push({ ...(args as unknown as WrittenFile), overwrite: false });
        return path;
      }
      case 'store_relay_credential':
        secureCredentials.set(String(args.key), String(args.token));
        return null;
      case 'load_relay_credential':
        return secureCredentials.get(String(args.key)) ?? null;
      case 'delete_relay_credential':
        secureCredentials.delete(String(args.key));
        return null;
      case 'open_recovery_package':
        return recoveryPackage;
      case 'write_recovery_package':
        recoveryPackage = {
          path: `/tournaments/${String(args.fileName)}`,
          contents: String(args.contents),
        };
        return recoveryPackage.path;
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
        const bearer = String(args.bearer ?? '');
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
        if (url.endsWith('/backup/provision')) {
          return {
            status: 200,
            body: JSON.stringify({
              tournamentId: relayTournament,
              controllerId: backupControllerId,
              label: 'Backup laptop',
              backupToken,
            }),
          };
        }
        if (url.endsWith('/health')) {
          const authenticatedAs = bearer === backupToken ? 'backup' : 'primary';
          return {
            status: 200,
            body: JSON.stringify({
              tournamentId: relayTournament,
              protocolVersion: 1,
              lifecycle: 'live',
              mirror: { director_epoch: relayEpoch, revision: relayRevision },
              controller: {
                authenticated_as: authenticatedAs,
                active: authenticatedAs === activeController,
                active_controller: activeController,
                backup_provisioned: true,
                backup_controller_id: backupControllerId,
                backup_controller_label: 'Backup laptop',
              },
              storage: { results_unacked: 2, help_open: 1 },
              counters: { metered_requests_estimate: 4100, rows_written_estimate: 900 },
              budget: { measured: { metered_requests_estimate: 4100 } },
            }),
          };
        }
        if (url.endsWith('/takeover')) {
          activeController = 'backup';
          relayEpoch = 2;
          relayRevision = 0;
          return {
            status: 200,
            body: JSON.stringify({
              tournamentId: relayTournament,
              director_epoch: relayEpoch,
              revision: relayRevision,
              active_controller: activeController,
              idempotent: false,
            }),
          };
        }
        if (url.endsWith('/backup/revoke')) return { status: 200, body: JSON.stringify({ revoked: true }) };
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
          if (mirrorFails)
            return { status: mirrorFailureStatus, body: JSON.stringify({ message: 'relay unavailable' }) };
          if (deferMirror) {
            deferredMirrorStarted = true;
            await deferMirror;
          }
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
        if (url.endsWith('/sessions')) {
          return { status: 200, body: JSON.stringify({ sessions: relaySessions }) };
        }
        if (url.includes('/help?state=open')) {
          return { status: 200, body: JSON.stringify({ help: relayHelp }) };
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
  relaySessions = [];
  relayHelp = [];
  recoveryPackage = null;
  relayResultsByBase = new Map();
  existingPaths = new Set();
  claimFails = false;
  mirrorFails = false;
  mirrorFailureStatus = 503;
  deferMirror = null;
  deferredMirrorStarted = false;
  ackFailuresRemaining = 0;
  resultFolder = '/tournaments/results';
  assignmentFolder = '/tournaments/assignments';
  deferResultRequests = false;
  pendingResultRequests = [];
  deferWrites = false;
  pendingWrites = [];
  scorerCanPair = true;
  scorerReadinessFails = false;
  activeController = 'primary';
  relayEpoch = 1;
  relayRevision = 0;
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

/** Choose the round, then enter its pairings. Each round keeps its own, so order is free. */
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

/** Existing end-to-end flows intentionally publish their reviewed plan after the new safety gate. */
async function publishReviewed(rendered: Awaited<ReturnType<typeof setUpTournament>>): Promise<void> {
  const mirrorsBefore = calls.filter(
    (call) => call.command === 'relay_request' && String(call.args.url).endsWith('/mirror'),
  ).length;
  await act(async () => {
    await rendered.result.current.publish();
  });
  await waitFor(() => {
    if (
      rendered.result.current.pendingPublicationReview === null &&
      calls.filter((call) => call.command === 'relay_request' && String(call.args.url).endsWith('/mirror'))
        .length <= mirrorsBefore
    ) {
      throw new Error('publish has not reached the relay or opened its review yet');
    }
  });
  if (rendered.result.current.pendingPublicationReview !== null) {
    await act(async () => {
      await rendered.result.current.confirmPublicationReview();
    });
  }
}

describe('a round, published and returned', () => {
  test('the native commands are called with the arguments the Rust side declares', async () => {
    const rendered = await setUpTournament();
    await publishReviewed(rendered);

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
    await publishReviewed(rendered);
    const afterFirst = rendered.result.current.state.rooms.map((room) => ({
      id: room.id,
      code: room.pairingCode,
      matchId: room.publishedMatchId,
    }));

    await setUpRound(rendered, 4);
    await publishReviewed(rendered);

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

    await publishReviewed(rendered);
    expect(rendered.result.current.notice?.kind).toBe('bad');
    expect(rendered.result.current.notice?.message).toMatch(/still have whatever they had before/);
    expect(rendered.result.current.state.relay?.revision).toBe(0);
    expect(rendered.result.current.state.rooms.every((room) => room.publishedMatchId === null)).toBe(true);
  });

  test('exports a failed round as ordinary Scorer assignments with the same match identities', async () => {
    const rendered = await setUpTournament();
    mirrorFails = true;
    await publishReviewed(rendered);

    const fallback = rendered.result.current.assignmentFallback;
    expect(fallback?.plan.assignments).toHaveLength(2);
    expect(rendered.result.current.state.rooms.every((room) => room.publishedMatchId === null)).toBe(true);

    await act(async () => {
      await rendered.result.current.exportAssignmentFallback();
    });
    expect(writtenAssignmentFiles).toHaveLength(2);
    for (const file of writtenAssignmentFiles) {
      const source = readQbjSource(JSON.parse(file.contents));
      expect(source.ok).toBe(true);
      if (!source.ok) continue;
      const defined = defineGame(source.value, source.value.candidates[0]!.index);
      expect(defined.ok).toBe(true);
    }

    const completed = scoredResultDocument();
    expect(completed.matchId).toBe(fallback?.plan.assignments[0]?.matchId);
    relayResults = [
      {
        result_id: 'fallback-result',
        room_id: 'room-1',
        received_at: '2026-09-10T15:00:00Z',
        qbj: completed.result,
      },
    ];
    await act(async () => {
      await rendered.result.current.pollResults();
      await rendered.result.current.chooseFolder();
      await rendered.result.current.saveResult('fallback-result');
    });
    expect(rendered.result.current.state.results[0]).toMatchObject({
      resultId: 'fallback-result',
      importStatus: 'needs-import',
    });

    mirrorFails = false;
    const mirrorsBeforeRecovery = calls.filter((call) =>
      String(call.args.url ?? '').endsWith('/mirror'),
    ).length;
    await act(async () => {
      await rendered.result.current.publish();
    });
    expect(rendered.result.current.pendingPublicationReview?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringMatching(/two active writers/i) }),
      ]),
    );
    expect(calls.filter((call) => String(call.args.url ?? '').endsWith('/mirror'))).toHaveLength(
      mirrorsBeforeRecovery,
    );
  });

  test('does not offer the offline fallback for a relay validation refusal', async () => {
    const rendered = await setUpTournament();
    mirrorFails = true;
    mirrorFailureStatus = 409;
    await publishReviewed(rendered);

    expect(rendered.result.current.assignmentFallback).toBeNull();
    expect(rendered.result.current.notice?.message).not.toMatch(/export the round assignment files/i);
  });

  test('reviews a dangerous plan before sending and then publishes the exact reviewed assignments', async () => {
    const rendered = await setUpTournament();
    const [first, second] = rendered.result.current.state.rooms;
    act(() => {
      rendered.result.current.setRoomTeams(first.id, 'right', 'Team_Deering');
      rendered.result.current.setRoomTeams(second.id, 'left', 'Team_Windham A');
      rendered.result.current.setRoomTeams(second.id, 'right', 'Team_Hebron Academy');
    });
    const before = rendered.result.current.state.rooms.map((room) => ({ ...room }));
    await act(async () => {
      await rendered.result.current.publish();
    });
    expect(rendered.result.current.pendingPublicationReview?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: expect.stringMatching(/crosses pools/i) })]),
    );
    expect(calls.filter((call) => String(call.args.url ?? '').endsWith('/mirror'))).toHaveLength(0);

    act(() => rendered.result.current.cancelPublicationReview());
    expect(rendered.result.current.state.rooms).toEqual(before);

    await act(async () => {
      await rendered.result.current.publish();
    });
    const reviewedMatchIds = rendered.result.current.pendingPublicationReview!.plan.assignments.map(
      (assignment) => assignment.matchId,
    );
    await act(async () => {
      await rendered.result.current.confirmPublicationReview();
    });
    const mirror = calls.find((call) => String(call.args.url ?? '').endsWith('/mirror'))!;
    const body = JSON.parse(String(mirror.args.body)) as { rooms: { match_id?: string }[] };
    expect(body.rooms.map((room) => room.match_id).filter(Boolean)).toEqual(reviewedMatchIds);
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
    await publishReviewed(restarted);

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
    await publishReviewed(rendered);
    const [, unused] = rendered.result.current.state.rooms;
    expect(bridgeStatus(rendered, unused.id)).toBe('waiting');
    expect(unused.publishedAssignmentFingerprint).not.toBeNull();

    act(() => {
      rendered.result.current.setRoomTeams(unused.id, 'left', null);
      rendered.result.current.setRoomTeams(unused.id, 'right', null);
    });
    await publishReviewed(rendered);

    expect(rendered.result.current.state.rooms.find((room) => room.id === unused.id)).toMatchObject({
      relayPublished: true,
      publishedMatchId: null,
      publishedRoundId: null,
      publishedAssignmentFingerprint: null,
    });
    expect(bridgeStatus(rendered, unused.id)).toBe('ready-to-pair');
  });

  test('keeps the old code active through a failed publish, then activates the pending code', async () => {
    const rendered = await setUpTournament();
    await publishReviewed(rendered);
    const room = rendered.result.current.state.rooms[0];
    const oldCode = room.pairingCode;
    act(() => rendered.result.current.regeneratePairingCode(room.id));
    const pendingCode = rendered.result.current.state.rooms[0].pendingPairingCode;
    expect(pendingCode).toBeTruthy();
    expect(pendingCode).not.toBe(oldCode);
    expect(rendered.result.current.state.rooms[0].pairingCode).toBe(oldCode);

    mirrorFails = true;
    await publishReviewed(rendered);
    expect(rendered.result.current.state.rooms[0]).toMatchObject({
      pairingCode: oldCode,
      pendingPairingCode: pendingCode,
    });
    expect(rendered.result.current.state.relay?.revision).toBe(1);

    mirrorFails = false;
    await publishReviewed(rendered);
    expect(rendered.result.current.state.rooms[0]).toMatchObject({
      pairingCode: pendingCode,
      pendingPairingCode: null,
    });
    expect(rendered.result.current.state.relay?.revision).toBe(2);
  });

  test('persists a published-room tombstone and clears it without touching sessions', async () => {
    const rendered = await setUpTournament();
    await publishReviewed(rendered);
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
    await waitFor(() =>
      expect(restarted.result.current.state.relay?.managementToken).toBe('management-secret'),
    );
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
    await publishReviewed(rendered);
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
    await publishReviewed(rendered);
    await act(async () => {
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
    await waitFor(() =>
      expect(restarted.result.current.state.relay?.managementToken).toBe('management-secret'),
    );
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
    await publishReviewed(restarted);
    await waitFor(() => expect(restarted.result.current.state.relay?.revision).toBe(2));
  });

  test('unreadable stored state starts clean rather than half-understood', () => {
    globalThis.localStorage.setItem(storageKey, '{ not json');
    expect(loadState()).toEqual({
      version: 2,
      relay: null,
      scorerReadiness: null,
      yftPath: null,
      tournamentName: null,
      rooms: [],
      pendingRoomRemovals: [],
      retiredRoomIds: [],
      selectedRoundId: null,
      roundPlans: [],
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
    const persisted = loadState();
    expect({ ...persisted, relay: null }).toEqual({ ...beforeState, relay: null });
    expect(persisted.relay?.managementToken).toBeUndefined();
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
 * This used to wipe every selection, because the selections lived on the rooms and a round change
 * had nowhere to put the outgoing ones. That made entering a tournament's prelims in advance
 * impossible: the only round that could hold matchups was the one on screen.
 *
 * Each round now owns its own plan, so switching is a read. The mistake the wiping guarded against
 * — publishing round 4's pairings as round 5 — is prevented where it actually happens instead, in
 * `publish()`, which reads the selected round's own plan and nothing else.
 */
describe('changing the round', () => {
  test('keeps every round\u2019s own pairings and changes nothing else', async () => {
    const rendered = await setUpTournament();
    const before = rendered.result.current.state.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      code: room.pairingCode,
    }));
    const roundFour = rendered.result.current.state.selectedRoundId!;
    const [first] = rendered.result.current.state.rooms;
    expect(rendered.result.current.plannedTeamsFor(first.id).leftTeamId).toBe('Team_Cony');

    const nextRound = rendered.result.current.tournament!.rounds[4];
    act(() => {
      rendered.result.current.selectRound(nextRound.id);
    });

    expect(rendered.result.current.state.selectedRoundId).toBe(nextRound.id);
    // Rooms, names and codes are the tournament's physical setup and are untouched.
    expect(
      rendered.result.current.state.rooms.map((room) => ({
        id: room.id,
        name: room.name,
        code: room.pairingCode,
      })),
    ).toEqual(before);
    // Round 5 has nothing entered yet, and round 4 still has everything.
    expect(rendered.result.current.plannedTeamsFor(first.id)).toEqual({
      leftTeamId: null,
      rightTeamId: null,
    });
    expect(
      rendered.result.current.state.roundPlans.find((plan) => plan.roundId === roundFour)?.pairings,
    ).toHaveLength(2);
  });

  test('round 1, round 2, then back to round 1 returns the original pairings', async () => {
    const rendered = await setUpTournament();
    const rounds = rendered.result.current.tournament!.rounds;
    const [first, second] = rendered.result.current.state.rooms;

    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });
    act(() => {
      rendered.result.current.setRoomTeams(first.id, 'left', 'Team_Cony');
      rendered.result.current.setRoomTeams(first.id, 'right', 'Team_Deering');
      rendered.result.current.setRoomTeams(second.id, 'left', 'Team_Wells');
      rendered.result.current.setRoomTeams(second.id, 'right', 'Team_Windham A');
    });

    act(() => {
      rendered.result.current.selectRound(rounds[1].id);
    });
    act(() => {
      rendered.result.current.setRoomTeams(first.id, 'left', 'Team_Wells');
      rendered.result.current.setRoomTeams(first.id, 'right', 'Team_Cony');
    });
    expect(rendered.result.current.plannedTeamsFor(second.id)).toEqual({
      leftTeamId: null,
      rightTeamId: null,
    });

    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });
    expect(rendered.result.current.plannedTeamsFor(first.id)).toEqual({
      leftTeamId: 'Team_Cony',
      rightTeamId: 'Team_Deering',
    });
    expect(rendered.result.current.plannedTeamsFor(second.id)).toEqual({
      leftTeamId: 'Team_Wells',
      rightTeamId: 'Team_Windham A',
    });
  });

  test('clearing the last side deletes the sparse entry rather than storing two nulls', async () => {
    const rendered = await setUpTournament();
    const roundId = rendered.result.current.state.selectedRoundId!;
    const [first] = rendered.result.current.state.rooms;

    act(() => {
      rendered.result.current.setRoomTeams(first.id, 'left', null);
    });
    // One side left, so the entry stays.
    expect(
      rendered.result.current.state.roundPlans
        .find((plan) => plan.roundId === roundId)
        ?.pairings.some((pairing) => pairing.roomId === first.id),
    ).toBe(true);

    act(() => {
      rendered.result.current.setRoomTeams(first.id, 'right', null);
    });
    expect(
      rendered.result.current.state.roundPlans
        .find((plan) => plan.roundId === roundId)
        ?.pairings.some((pairing) => pairing.roomId === first.id),
    ).toBe(false);
  });

  test('a round with nothing entered still cannot be published', async () => {
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
    const [first] = rendered.result.current.state.rooms;
    act(() => {
      rendered.result.current.selectRound(current);
    });
    expect(rendered.result.current.plannedTeamsFor(first.id).leftTeamId).toBe('Team_Cony');
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
    await publishReviewed(rendered);
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
    await publishReviewed(rendered);
    const mirror = calls.find((call) => String(call.args.url ?? '').endsWith('/mirror'));
    expect(mirror?.args.bearer).toBe('management-secret');
  });

  test('the replacement is stored only after the new claim succeeds', async () => {
    const rendered = await setUpTournament();
    await publishReviewed(rendered);
    expect(
      rendered.result.current.state.rooms.every((room) => room.publishedAssignmentFingerprint !== null),
    ).toBe(true);
    const beforeRooms = rendered.result.current.state.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      pairingCode: room.pairingCode,
    }));
    const plansBefore = rendered.result.current.state.roundPlans;
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
    // The rooms were published before the replacement, so content truth existed to be cleared.
    expect(
      rendered.result.current.state.rooms.map((room) => ({
        id: room.id,
        name: room.name,
        pairingCode: room.pairingCode,
        relayPublished: room.relayPublished,
        publishedMatchId: room.publishedMatchId,
        publishedRoundId: room.publishedRoundId,
        publishedAssignmentFingerprint: room.publishedAssignmentFingerprint,
        assignmentRevision: room.assignmentRevision,
      })),
    ).toEqual(
      beforeRooms.map((room) => ({
        ...room,
        relayPublished: false,
        publishedMatchId: null,
        publishedRoundId: null,
        publishedAssignmentFingerprint: null,
        assignmentRevision: 0,
      })),
    );
    // Replacing the relay resets relay facts. The operator's planning survives it: a new relay
    // does not mean a new schedule.
    expect(rendered.result.current.state.roundPlans).toEqual(plansBefore);
  });

  test('forgetting the credential is a separate, explicit action', async () => {
    const rendered = await setUpTournament();
    await act(async () => {
      await rendered.result.current.forgetRelayCredential();
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
    expect(loadState().relay?.managementToken).toBeUndefined();
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
    expect(loadState().relay).toMatchObject({
      baseUrl: oldRelay?.baseUrl,
      tournamentId: oldRelay?.tournamentId,
      epoch: oldRelay?.epoch,
      revision: oldRelay?.revision,
    });
    expect(loadState().relay?.managementToken).toBeUndefined();
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

    await publishReviewed(rendered);

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

describe('backup controller recovery', () => {
  test('encrypts a backup handoff, takes over, then saves and acknowledges retained results', async () => {
    const { result: document } = scoredResultDocument();
    relayResults = [
      { result_id: 'res-recovery', room_id: 'room-1', received_at: '2026-09-11T15:00:00Z', qbj: document },
    ];
    const primary = await setUpTournament();

    let created: boolean | undefined;
    await act(async () => {
      created = await primary.result.current.createRecoveryPackage(
        'correct horse battery staple',
        'Backup laptop',
      );
    });
    expect(created).toBe(true);
    expect(recoveryPackage?.contents).toBeTruthy();
    expect(recoveryPackage?.contents).not.toContain('management-secret');
    expect(recoveryPackage?.contents).not.toContain(backupToken);
    primary.unmount();

    globalThis.localStorage.clear();
    const backup = renderHook(() => useBridge());
    await act(async () => {
      expect(await backup.result.current.importRecoveryPackage('correct horse battery staple')).toBe(true);
    });
    expect(backup.result.current.state.relay).toMatchObject({
      controllerRole: 'backup',
      controllerId: backupControllerId,
      managementToken: backupToken,
      epoch: 1,
      revision: 0,
    });
    expect(JSON.stringify(loadState())).not.toContain(backupToken);

    await act(async () => {
      backup.result.current.loadFileContents(null, yftFixtureText());
    });
    await act(async () => {
      expect(await backup.result.current.takeOverRelay()).toBe(true);
    });
    expect(activeController).toBe('backup');
    expect(backup.result.current.state.relay).toMatchObject({ epoch: 2, revision: 0 });

    await waitFor(() => expect(backup.result.current.state.results).toHaveLength(1));
    await act(async () => {
      await backup.result.current.chooseFolder();
      await backup.result.current.saveNewResults();
    });
    expect(writtenFiles).toHaveLength(1);
    expect(writtenFiles[0].fileName).toMatch(/\.result\.qbj$/);
    const ack = calls.find(
      (call) => call.command === 'relay_request' && String(call.args.url).endsWith('/acks'),
    );
    expect(ack?.args.bearer).toBe(backupToken);
    expect(backup.result.current.state.results[0].ackPending).toBe(false);
    backup.unmount();
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
    expect(loadState().relay?.managementToken).toBeUndefined();
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
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(restarted.result.current.state.relay?.managementToken).toBe('management-secret');
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

/**
 * Planning a tournament before it starts.
 *
 * The whole point of separating a room from a round's plan is that an operator can sit down on
 * Friday night, enter every prelim round, close the application, and find all of it on Saturday
 * morning — and that publishing round 1 then means round 1 and nothing else.
 *
 * Every test below is about one of the two sources of truth not leaking into the other.
 */
describe('preplanned rounds', () => {
  /** Enter a distinct matchup in the first room for each of the first three prelim rounds. */
  async function planThreeRounds() {
    const rendered = await setUpTournament();
    const rounds = rendered.result.current.tournament!.rounds;
    const [first, second] = rendered.result.current.state.rooms;
    const entries: [string, string, string][] = [
      [rounds[0].id, 'Team_Cony', 'Team_Deering'],
      [rounds[1].id, 'Team_Wells', 'Team_Windham A'],
      [rounds[2].id, 'Team_Plymouth A', 'Team_Plymouth B'],
    ];
    for (const [roundId, left, right] of entries) {
      act(() => {
        rendered.result.current.selectRound(roundId);
      });
      act(() => {
        rendered.result.current.setRoomTeams(first.id, 'left', left);
        rendered.result.current.setRoomTeams(first.id, 'right', right);
        rendered.result.current.setRoomTeams(second.id, 'left', 'Team_Hebron Academy');
        rendered.result.current.setRoomTeams(second.id, 'right', 'Team_Gould Academy A');
      });
    }
    return { rendered, rounds, first, second, entries };
  }

  test('survive a restart, every round of them', async () => {
    const { rendered, first, entries } = await planThreeRounds();
    const saved = rendered.result.current.state.roundPlans;
    // The three entered here, plus the round `setUpTournament` already planned.
    expect(saved).toHaveLength(4);
    expect(loadState().roundPlans).toEqual(saved);

    // A new hook is a new application session reading the same local storage.
    const restarted = renderHook(() => useBridge());
    expect(restarted.result.current.state.roundPlans).toEqual(saved);
    await act(async () => {
      restarted.result.current.loadFileContents(null, yftFixtureText());
    });
    for (const [roundId, left, right] of entries) {
      act(() => {
        restarted.result.current.selectRound(roundId);
      });
      expect(restarted.result.current.plannedTeamsFor(first.id)).toEqual({
        leftTeamId: left,
        rightTeamId: right,
      });
    }
  });

  test('a reload of the same file with the same ids changes nothing', async () => {
    const { rendered } = await planThreeRounds();
    const before = rendered.result.current.state.roundPlans;
    act(() => {
      rendered.result.current.loadFileContents('/tournaments/spring.yft', yftFixtureText());
    });
    expect(rendered.result.current.state.roundPlans).toEqual(before);
    expect(rendered.result.current.notice?.kind).toBe('good');
  });

  test('a reload missing one team clears only that side, and says so once', async () => {
    const { rendered, rounds, first, second } = await planThreeRounds();
    // The team keeps its name and loses its id, which is the only thing reconciliation may read.
    const withoutWells = yftFixtureText().replaceAll('Team_Wells', 'Team_Wells_Withdrawn');
    act(() => {
      rendered.result.current.loadFileContents('/tournaments/spring.yft', withoutWells);
    });

    act(() => {
      rendered.result.current.selectRound(rounds[1].id);
    });
    // Round 2 had Wells on the left; only that side is gone.
    expect(rendered.result.current.plannedTeamsFor(first.id)).toEqual({
      leftTeamId: null,
      rightTeamId: 'Team_Windham A',
    });
    // The other room in that round, and every other round, is untouched.
    expect(rendered.result.current.plannedTeamsFor(second.id)).toEqual({
      leftTeamId: 'Team_Hebron Academy',
      rightTeamId: 'Team_Gould Academy A',
    });
    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });
    expect(rendered.result.current.plannedTeamsFor(first.id)).toEqual({
      leftTeamId: 'Team_Cony',
      rightTeamId: 'Team_Deering',
    });

    expect(rendered.result.current.notice?.kind).toBe('warn');
    expect(rendered.result.current.notice?.message).toMatch(/team selection\(s\) were cleared/);
  });

  test('a reload missing one round drops only that round’s plan', async () => {
    const { rendered, rounds, first } = await planThreeRounds();
    // Round ids are synthesized by the importer from the phase and the round number, so the round
    // has to be taken out of the file itself rather than renamed by a string replacement.
    const withoutRoundThree = (() => {
      const parsed = JSON.parse(yftFixtureText()) as {
        objects: { type?: string; phases?: { name?: string; rounds?: { name?: string }[] }[] }[];
      };
      const tournament = parsed.objects.find((object) => object.type === 'Tournament')!;
      const prelims = tournament.phases!.find((phase) => phase.name === 'Prelims')!;
      prelims.rounds = prelims.rounds!.filter((round) => round.name !== '3');
      return JSON.stringify(parsed);
    })();
    act(() => {
      rendered.result.current.loadFileContents('/tournaments/spring.yft', withoutRoundThree);
    });

    // Round 3's plan is gone; every other planned round — including the one `setUpTournament`
    // entered — is untouched.
    expect(rendered.result.current.state.roundPlans.map((plan) => plan.roundId)).not.toContain(rounds[2].id);
    expect(rendered.result.current.state.roundPlans.map((plan) => plan.roundId)).toEqual(
      expect.arrayContaining([rounds[0].id, rounds[1].id, rounds[3].id]),
    );
    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });
    expect(rendered.result.current.plannedTeamsFor(first.id)).toEqual({
      leftTeamId: 'Team_Cony',
      rightTeamId: 'Team_Deering',
    });
    expect(rendered.result.current.notice?.message).toMatch(/planned round\(s\) no longer exist/);
  });

  test('adding a room changes no existing plan', async () => {
    const { rendered } = await planThreeRounds();
    const before = rendered.result.current.state.roundPlans;
    act(() => {
      rendered.result.current.addRoom();
    });
    // Sparse: the new room is in no round until the operator puts it in one.
    expect(rendered.result.current.state.roundPlans).toEqual(before);
    expect(rendered.result.current.state.rooms).toHaveLength(3);
  });

  test('renaming a room changes no plan, because plans reference the id', async () => {
    const { rendered, first } = await planThreeRounds();
    const before = rendered.result.current.state.roundPlans;
    act(() => {
      rendered.result.current.renameRoom(first.id, 'Auditorium');
    });
    expect(rendered.result.current.state.roundPlans).toEqual(before);
    expect(rendered.result.current.state.rooms[0].name).toBe('Auditorium');
  });

  test('removing a room removes it from every plan and still leaves a relay tombstone', async () => {
    const { rendered, first, second } = await planThreeRounds();
    // Publish once so the room exists on the relay and its removal owes the relay a clear.
    await publishReviewed(rendered);
    act(() => {
      rendered.result.current.removeRoom(first.id);
    });

    for (const plan of rendered.result.current.state.roundPlans) {
      expect(plan.pairings.some((pairing) => pairing.roomId === first.id)).toBe(false);
      // The other room's entries are untouched in every round.
      expect(plan.pairings.some((pairing) => pairing.roomId === second.id)).toBe(true);
    }
    // The relay half of the removal is unchanged by any of this.
    expect(rendered.result.current.state.pendingRoomRemovals.map((room) => room.id)).toEqual([first.id]);
    expect(rendered.result.current.state.retiredRoomIds).toContain(first.id);
  });

  test('regenerating a pairing code changes no plan', async () => {
    const { rendered, first } = await planThreeRounds();
    const before = rendered.result.current.state.roundPlans;
    act(() => {
      rendered.result.current.regeneratePairingCode(first.id);
    });
    expect(rendered.result.current.state.roundPlans).toEqual(before);
    expect(rendered.result.current.state.rooms[0].pendingPairingCode).toBeTruthy();
  });

  test('Publish Room Setup changes no plan', async () => {
    const { rendered } = await planThreeRounds();
    const before = rendered.result.current.state.roundPlans;
    await act(async () => {
      await rendered.result.current.publishRoomSetup();
    });
    expect(rendered.result.current.state.roundPlans).toEqual(before);
    expect(rendered.result.current.state.rooms.every((room) => room.relayPublished)).toBe(true);
  });

  test('publishing one round leaves every round’s plan exactly as it was', async () => {
    const { rendered, rounds } = await planThreeRounds();
    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });
    const before = rendered.result.current.state.roundPlans;

    await publishReviewed(rendered);

    expect(rendered.result.current.state.roundPlans).toEqual(before);
    expect(loadState().roundPlans).toEqual(before);
  });

  test('publishing round 1 sends round 1’s pairings even while round 2 differs', async () => {
    const { rendered, rounds } = await planThreeRounds();
    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });
    await publishReviewed(rendered);

    const mirror = calls.find((call) => String(call.args.url ?? '').endsWith('/mirror'));
    const body = JSON.parse(String(mirror!.args.body)) as {
      rooms: { room_id: string; assignment_qbj?: { objects: Record<string, unknown>[] } }[];
    };
    const room = body.rooms.find((entry) => entry.room_id === 'room-1')!;
    const teams = room.assignment_qbj!.objects.filter((object) => object.type === 'Team');
    // Round 1's matchup, not round 2's or round 3's.
    expect(teams.map((team) => team.id)).toEqual(['Team_Cony', 'Team_Deering']);
  });

  test('a room used in round 1 but not round 2 is explicitly cleared by round 2', async () => {
    const rendered = await setUpTournament();
    const rounds = rendered.result.current.tournament!.rounds;
    const [first, second] = rendered.result.current.state.rooms;

    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });
    act(() => {
      rendered.result.current.setRoomTeams(first.id, 'left', 'Team_Cony');
      rendered.result.current.setRoomTeams(first.id, 'right', 'Team_Deering');
      rendered.result.current.setRoomTeams(second.id, 'left', 'Team_Wells');
      rendered.result.current.setRoomTeams(second.id, 'right', 'Team_Windham A');
    });
    await publishReviewed(rendered);

    // Round 2 uses only the first room.
    act(() => {
      rendered.result.current.selectRound(rounds[1].id);
    });
    act(() => {
      rendered.result.current.setRoomTeams(first.id, 'left', 'Team_Plymouth A');
      rendered.result.current.setRoomTeams(first.id, 'right', 'Team_Plymouth B');
    });
    await publishReviewed(rendered);

    const mirrors = calls.filter((call) => String(call.args.url ?? '').endsWith('/mirror'));
    const body = JSON.parse(String(mirrors[1].args.body)) as {
      rooms: { room_id: string; assignment_qbj?: unknown; match_id?: string }[];
    };
    const unused = body.rooms.find((entry) => entry.room_id === second.id)!;
    // Present and explicitly holding nothing, because the relay upserts and never deletes.
    expect(unused).toBeTruthy();
    expect(unused.assignment_qbj).toBeUndefined();
    expect(unused.match_id).toBeUndefined();
    expect(rendered.result.current.state.rooms[1].publishedMatchId).toBeNull();
  });

  test('a failed publish changes neither the plans nor local publication state', async () => {
    const { rendered, rounds } = await planThreeRounds();
    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });
    const beforePlans = rendered.result.current.state.roundPlans;
    const beforeRooms = rendered.result.current.state.rooms;
    const beforeRevision = rendered.result.current.state.relay?.revision;

    mirrorFails = true;
    await publishReviewed(rendered);
    mirrorFails = false;

    expect(rendered.result.current.notice?.kind).toBe('bad');
    expect(rendered.result.current.state.roundPlans).toEqual(beforePlans);
    expect(rendered.result.current.state.rooms).toEqual(beforeRooms);
    expect(rendered.result.current.state.relay?.revision).toBe(beforeRevision);
  });

  test('a future round never shows the live round’s assignment as its own', async () => {
    const { rendered, rounds, first } = await planThreeRounds();
    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });
    await publishReviewed(rendered);

    const room = () => rendered.result.current.state.rooms[0];
    // Round 1 is live and says so.
    expect(rendered.result.current.planStatus(room())).toBe('live');
    // The room-level status is `waiting` regardless of which round is selected, which is exactly
    // why the plan needs its own status.
    expect(rendered.result.current.roomStatus(room())).toBe('waiting');

    act(() => {
      rendered.result.current.selectRound(rounds[1].id);
    });
    expect(rendered.result.current.roomStatus(room())).toBe('waiting');
    expect(rendered.result.current.planStatus(room())).toBe('other-round');
    expect(rendered.result.current.plannedTeamsFor(first.id)).toEqual({
      leftTeamId: 'Team_Wells',
      rightTeamId: 'Team_Windham A',
    });
  });

  test('editing a published round marks it as differing from what is live', async () => {
    const { rendered, rounds, first } = await planThreeRounds();
    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });
    await publishReviewed(rendered);
    expect(rendered.result.current.planStatus(rendered.result.current.state.rooms[0])).toBe('live');

    act(() => {
      rendered.result.current.setRoomTeams(first.id, 'right', 'Team_Windham B');
    });
    expect(rendered.result.current.planStatus(rendered.result.current.state.rooms[0])).toBe('edited');
  });

  test('renaming a room after publishing reads as edited until it is republished', async () => {
    const { rendered, rounds, first } = await planThreeRounds();
    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });
    await publishReviewed(rendered);
    const room = () => rendered.result.current.state.rooms[0];
    expect(rendered.result.current.planStatus(room())).toBe('live');

    // Same tournament, round, room id, and teams — so the match id is unchanged — but the relay
    // is serving an assignment whose location is still the old room name.
    act(() => {
      rendered.result.current.renameRoom(first.id, 'Auditorium');
    });
    expect(rendered.result.current.planStatus(room())).toBe('edited');

    await publishReviewed(rendered);
    expect(rendered.result.current.planStatus(room())).toBe('live');
  });

  test('reloading the same file with changed roster names reads as edited', async () => {
    const { rendered, rounds, first } = await planThreeRounds();
    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });
    await publishReviewed(rendered);
    const room = () => rendered.result.current.state.rooms[0];
    expect(rendered.result.current.planStatus(room())).toBe('live');

    // Every team id is stable, so the plan survives reconciliation — but the relay serves the
    // old rosters.
    const reloaded = JSON.parse(yftFixtureText()) as {
      objects: {
        registrations?: { teams?: { players?: { name?: unknown }[] }[] }[];
      }[];
    };
    for (const registration of reloaded.objects[0].registrations ?? []) {
      for (const team of registration.teams ?? []) {
        for (const player of team.players ?? []) {
          if (typeof player.name === 'string') player.name = `${player.name} Jr`;
        }
      }
    }
    await act(async () => {
      rendered.result.current.loadFileContents('/tournaments/spring.yft', JSON.stringify(reloaded));
    });
    expect(rendered.result.current.plannedTeamsFor(first.id)).toEqual({
      leftTeamId: 'Team_Cony',
      rightTeamId: 'Team_Deering',
    });
    expect(rendered.result.current.planStatus(room())).toBe('edited');
  });

  test('reloading the same file with a changed timed setting reads as edited', async () => {
    const { rendered, rounds } = await planThreeRounds();
    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });
    await publishReviewed(rendered);
    const room = () => rendered.result.current.state.rooms[0];
    expect(rendered.result.current.planStatus(room())).toBe('live');

    const reloaded = JSON.parse(yftFixtureText()) as {
      objects: { scoring_rules?: Record<string, unknown> }[];
    };
    const rules = reloaded.objects[0].scoring_rules as Record<string, unknown>;
    rules.YfData = { timed: true };
    rules.maximum_regulation_tossup_count = 24;
    await act(async () => {
      rendered.result.current.loadFileContents('/tournaments/spring.yft', JSON.stringify(reloaded));
    });
    // Same ids throughout, so the round is still planned — but the served assignment scored it
    // untimed.
    expect(rendered.result.current.planStatus(room())).toBe('edited');
  });

  test('a failed republish leaves the previous publication fingerprint intact', async () => {
    const { rendered, rounds } = await planThreeRounds();
    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });
    await publishReviewed(rendered);
    const room = () => rendered.result.current.state.rooms[0];
    const before = room().publishedAssignmentFingerprint;
    expect(before).not.toBeNull();
    expect(rendered.result.current.planStatus(room())).toBe('live');

    mirrorFails = true;
    await publishReviewed(rendered);
    mirrorFails = false;

    expect(rendered.result.current.notice?.kind).toBe('bad');
    expect(room().publishedAssignmentFingerprint).toBe(before);
    expect(rendered.result.current.planStatus(room())).toBe('live');
  });

  test('an edit made while a publish is in flight is not overwritten by the response', async () => {
    const { rendered, rounds, first } = await planThreeRounds();
    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });

    // Hold the mirror open, change the plan underneath it, then let it succeed.
    let releaseMirror: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      releaseMirror = resolve;
    });
    deferMirror = held;

    await act(async () => {
      await rendered.result.current.publish();
    });
    await waitFor(() => expect(rendered.result.current.pendingPublicationReview).not.toBeNull());
    let publishing: Promise<void>;
    act(() => {
      publishing = rendered.result.current.confirmPublicationReview();
    });
    await waitFor(() => expect(deferredMirrorStarted).toBe(true));

    act(() => {
      rendered.result.current.setRoomTeams(first.id, 'right', 'Team_Windham C');
    });

    releaseMirror!();
    await act(async () => {
      await publishing!;
    });
    deferMirror = null;

    // The relay really is holding A-vs-B, so that is what the room records.
    const room = rendered.result.current.state.rooms[0];
    expect(room.publishedRoundId).toBe(rounds[0].id);
    expect(room.publishedMatchId).toBeTruthy();
    // The newer plan is intact rather than reverted to the snapshot that was sent.
    expect(rendered.result.current.plannedTeamsFor(first.id)).toEqual({
      leftTeamId: 'Team_Cony',
      rightTeamId: 'Team_Windham C',
    });
    // And the screen can tell the operator the two differ.
    expect(rendered.result.current.planStatus(room)).toBe('edited');
    // Relay truth is the fingerprint of what was actually sent — A-vs-B under the old room
    // name — not a rebuild from the newer plan the operator has since typed.
    const sentMirror = calls.filter((call) => String(call.args.url ?? '').endsWith('/mirror')).at(-1);
    const sentBody = JSON.parse(String(sentMirror!.args.body)) as {
      rooms: { room_id: string; assignment_qbj?: Record<string, unknown> }[];
    };
    const sentRoom = sentBody.rooms.find((entry) => entry.room_id === first.id)!;
    expect(room.publishedAssignmentFingerprint).toBe(assignmentFingerprint(sentRoom.assignment_qbj!));
    expect(room.publishedAssignmentFingerprint).not.toBeNull();
  });

  test('a result still matches the match that was published, not the plan on screen', async () => {
    const { rendered, rounds, first } = await planThreeRounds();
    act(() => {
      rendered.result.current.selectRound(rounds[0].id);
    });
    await publishReviewed(rendered);
    const publishedMatchId = rendered.result.current.state.rooms[0].publishedMatchId!;

    // Change the plan after publishing. The relay's game is unaffected, and so is its result.
    act(() => {
      rendered.result.current.setRoomTeams(first.id, 'right', 'Team_Windham B');
    });

    relayResults = [
      {
        result_id: 'result-live',
        room_id: 'room-1',
        received_at: '2026-09-11T15:00:00Z',
        qbj: { type: 'Match', id: publishedMatchId },
      },
    ];
    await act(async () => {
      await rendered.result.current.pollResults();
    });

    expect(rendered.result.current.roomStatus(rendered.result.current.state.rooms[0])).toBe(
      'result-received',
    );
  });
});

describe('operations snapshot', () => {
  const operationsSessionCalls = (): number =>
    calls.filter((call) => call.command === 'relay_request' && String(call.args.url).endsWith('/sessions'))
      .length;

  it('shows director sessions, open help, and quota without relay operator identity', async () => {
    relaySessions = [
      {
        session_id: 'sess-1',
        room_id: 'Room 1',
        match_id: 'match-1',
        status: 'open',
        writer_device: 'ipad-1',
        updated_at: '2026-09-11T17:59:00Z',
        presence: [
          {
            device_id: 'ipad-1',
            operator_name: 'Should Not Appear',
            updated_at: '2026-09-11T17:59:00Z',
            expires_at: '2026-09-11T18:05:00Z',
          },
        ],
      },
    ];
    relayHelp = [
      {
        id: 'help-1',
        room_id: 'Room 1',
        category: 'scoring',
        message: 'Should Not Appear',
        device_id: 'ipad-1',
        operator_name: 'Should Not Appear',
        created_at: '2026-09-11T17:59:00Z',
        updated_at: '2026-09-11T17:59:30Z',
      },
    ];

    const rendered = await setUpTournament();
    try {
      await act(async () => {
        await rendered.result.current.refreshOperations();
      });

      const operations = rendered.result.current.operations;
      expect(operations?.error).toBeNull();
      expect(typeof operations?.fetchedAt).toBe('string');
      expect(operations?.sessions).toHaveLength(1);
      expect(operations?.sessions[0]).toEqual({
        sessionId: 'sess-1',
        roomId: 'Room 1',
        matchId: 'match-1',
        status: 'open',
        writerDevice: 'ipad-1',
        updatedAt: '2026-09-11T17:59:00Z',
        progressSequence: null,
        progressUpdatedAt: null,
        results: [],
        presence: [
          {
            deviceId: 'ipad-1',
            updatedAt: '2026-09-11T17:59:00Z',
            expiresAt: '2026-09-11T18:05:00Z',
          },
        ],
      });
      expect(operations?.help).toEqual([
        {
          id: 'help-1',
          roomId: 'Room 1',
          category: 'scoring',
          createdAt: '2026-09-11T17:59:00Z',
          updatedAt: '2026-09-11T17:59:30Z',
        },
      ]);
      expect(operations?.health.protocolVersion).toBe(1);
      expect(operations?.health.lifecycle).toBe('live');
      expect(operations?.health.storage).toEqual({ results_unacked: 2, help_open: 1 });
      expect(operations?.health.counters?.metered_requests_estimate).toBe(4100);
    } finally {
      rendered.unmount();
    }
  });

  it('keeps ordinary result polls off the operations snapshot', async () => {
    const rendered = await setUpTournament();
    try {
      await act(async () => {
        await rendered.result.current.refreshOperations();
      });
      const before = operationsSessionCalls();

      await act(async () => {
        await rendered.result.current.pollResults();
      });
      await act(async () => {
        await rendered.result.current.pollResults();
      });
      await act(async () => {
        await rendered.result.current.pollResults();
      });

      expect(operationsSessionCalls()).toBe(before);
      expect(operationsRefreshMs).toBe(resultPollIntervalMs * 6);
    } finally {
      rendered.unmount();
    }
  });

  it('notes a reachability transition once across repeated polls', async () => {
    const rendered = await setUpTournament();
    try {
      await act(async () => {
        await rendered.result.current.pollResults();
      });
      await act(async () => {
        await rendered.result.current.pollResults();
      });

      const reachability = rendered.result.current.operationsTimeline.filter(
        (entry) => entry.kind === 'reachability',
      );
      expect(reachability).toHaveLength(1);
      expect(reachability[0].detail).toBe('relay reachable');
    } finally {
      rendered.unmount();
    }
  });
});
