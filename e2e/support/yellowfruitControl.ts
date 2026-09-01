/**
 * Start YellowFruit's real QBTCP server for a browser contract test.
 *
 * The sibling checkout is intentionally configurable. `YELLOWFRUIT_REPO` selects the source tree and
 * `YELLOWFRUIT_REF`, when supplied, asserts that the checkout is currently at that ref; the harness
 * never changes a user's branch or working tree. Without a sibling checkout this helper reports
 * unavailable, so the ordinary browser suite stays runnable in a QBSheet-only checkout.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { assignmentFor, rounds } from './tournamentControl';

const execFileAsync = promisify(execFile);

const defaultYellowFruitRepo = path.resolve(process.cwd(), '../../Codex/2026-08-26/pu/yellowfruit-link');
export const yellowFruitRepo = process.env.YELLOWFRUIT_REPO ?? defaultYellowFruitRepo;

export const yellowFruitHarnessAvailable =
  existsSync(path.join(yellowFruitRepo, 'package.json')) &&
  existsSync(path.join(yellowFruitRepo, 'src/main/qbtcp/QbtcpServer.ts'));

interface IYellowFruitRoom {
  id: string;
  name: string;
  pairingCode: string;
}

interface IYellowFruitState {
  results: Array<{ id: string; status: string; warnings?: unknown[] }>;
  sessions: Array<{ status?: string; finalReceived?: boolean; progressSequence: number }>;
}

interface IYellowFruitServer {
  readonly running: boolean;
  readonly port?: number;
  bindTournament(tournamentId: string): Promise<void>;
  setScoresheetUrl(url: string): Promise<void>;
  addRoom(name: string): Promise<IYellowFruitRoom>;
  setAssignment(assignment: {
    roomId: string;
    roundNumber: number;
    leftTeamId: string;
    rightTeamId: string;
    leftTeamName: string;
    rightTeamName: string;
    matchId: string;
    roundRevision: number;
    document: object;
  }): Promise<{ id: string } | { assigned: false; reason: string }>;
  start(port: number): Promise<void>;
  stop(): Promise<void>;
  getState(): IYellowFruitState;
  reviewResult(resultId: string, request: { decision: 'accept' }): Promise<{ reviewed: boolean }>;
}

interface IYellowFruitStoreConstructor {
  new (directory: string): object;
}

interface IYellowFruitServerConstructor {
  new (
    store: object,
    hooks: { onResultReceived: () => void; onStateChanged: () => void },
  ): IYellowFruitServer;
}

interface IYellowFruitModules {
  server: IYellowFruitServerConstructor;
  store: IYellowFruitStoreConstructor;
}

async function gitRevision(ref: string): Promise<string> {
  const result = await execFileAsync('git', ['-C', yellowFruitRepo, 'rev-parse', ref]);
  return result.stdout.trim();
}

async function assertRequestedRevision(): Promise<void> {
  const requestedRef = process.env.YELLOWFRUIT_REF;
  if (!requestedRef) return;
  const [head, requested] = await Promise.all([gitRevision('HEAD'), gitRevision(requestedRef)]);
  if (head !== requested) {
    throw new Error(
      `YellowFruit checkout ${yellowFruitRepo} is at ${head}, but YELLOWFRUIT_REF=${requestedRef} resolves to ${requested}. Check out the requested ref before running the harness.`,
    );
  }
}

async function loadYellowFruitModules(): Promise<IYellowFruitModules> {
  await assertRequestedRevision();
  // YellowFruit is a CommonJS TypeScript application. Register its own transpile-only loader in the
  // Playwright worker so this contract test exercises the sibling source tree without building or
  // changing that checkout. The environment is restored immediately after registration.
  const requireFromYellowFruit = createRequire(import.meta.url);
  const previousProject = process.env.TS_NODE_PROJECT;
  const previousTranspileOnly = process.env.TS_NODE_TRANSPILE_ONLY;
  process.env.TS_NODE_PROJECT = path.join(yellowFruitRepo, 'tsconfig.json');
  process.env.TS_NODE_TRANSPILE_ONLY = 'true';
  try {
    requireFromYellowFruit(path.join(yellowFruitRepo, 'node_modules/ts-node/register/transpile-only'));
  } finally {
    if (previousProject === undefined) delete process.env.TS_NODE_PROJECT;
    else process.env.TS_NODE_PROJECT = previousProject;
    if (previousTranspileOnly === undefined) delete process.env.TS_NODE_TRANSPILE_ONLY;
    else process.env.TS_NODE_TRANSPILE_ONLY = previousTranspileOnly;
  }
  const serverModule = requireFromYellowFruit(
    path.join(yellowFruitRepo, 'src/main/qbtcp/QbtcpServer.ts'),
  ) as { default: IYellowFruitServerConstructor };
  const storeModule = requireFromYellowFruit(path.join(yellowFruitRepo, 'src/main/qbtcp/QbtcpStore.ts')) as {
    default: IYellowFruitStoreConstructor;
  };
  return { server: serverModule.default, store: storeModule.default };
}

function assignmentForRoom(roomId: string): object {
  const document = JSON.parse(JSON.stringify(assignmentFor(4))) as {
    objects: Array<Record<string, unknown>>;
  };
  const match = document.objects.find((entry) => entry.type === 'Match');
  if (!match) throw new Error('QBSheet fixture assignment has no Match object.');
  const extension = match._qbtcp;
  if (typeof extension !== 'object' || extension === null || Array.isArray(extension)) {
    throw new Error('QBSheet fixture assignment has no QBTCP extension.');
  }
  match._qbtcp = { ...extension, room_id: roomId };
  return document;
}

export interface IYellowFruitControl {
  readonly origin: string;
  readonly roomId: string;
  readonly pairingCode: string;
  readonly state: () => IYellowFruitState;
  readonly review: (resultId: string) => Promise<{ reviewed: boolean }>;
  readonly close: () => Promise<void>;
}

/** Start a real YellowFruit QBTCP server with the QBSheet contract fixture published as its assignment. */
export async function startYellowFruitControl(): Promise<IYellowFruitControl> {
  if (!yellowFruitHarnessAvailable) {
    throw new Error(
      `YellowFruit checkout not found. Set YELLOWFRUIT_REPO to a sibling checkout to enable this test.`,
    );
  }
  const { server: Server, store: Store } = await loadYellowFruitModules();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qbsheet-yellowfruit-qbtcp-'));
  const server = new Server(new Store(directory), { onResultReceived: () => {}, onStateChanged: () => {} });
  let room: IYellowFruitRoom;
  try {
    const tournamentId = 'Tournament_spring-2026';
    await server.bindTournament(tournamentId);
    // This is the actual browser origin used by playwright.config.ts, so production CORS logic is
    // in the path. The server's default allowlist is deliberately not a wildcard.
    await server.setScoresheetUrl('http://127.0.0.1:4173');
    room = await server.addRoom('Room 204');
    const left = rounds[4].left;
    const right = rounds[4].right;
    const assigned = await server.setAssignment({
      roomId: room.id,
      roundNumber: 4,
      leftTeamId: left.id,
      rightTeamId: right.id,
      leftTeamName: left.name,
      rightTeamName: right.name,
      matchId: rounds[4].matchId,
      roundRevision: 1,
      document: assignmentForRoom(room.id),
    });
    if (!('id' in assigned)) {
      throw new Error(`YellowFruit could not publish the contract assignment: ${assigned.reason}`);
    }
    await server.start(0);
  } catch (error) {
    if (server.running) await server.stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  if (server.port === undefined) {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
    throw new Error('YellowFruit started without reporting its listening port.');
  }

  return {
    origin: `http://127.0.0.1:${server.port}`,
    roomId: room.id,
    pairingCode: room.pairingCode,
    state: () => server.getState(),
    review: (resultId) => server.reviewResult(resultId, { decision: 'accept' }),
    close: async () => {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
