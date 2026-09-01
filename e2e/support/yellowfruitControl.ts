/**
 * Start YellowFruit's real QBTCP server and renderer importer for a browser contract test.
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

const execFileAsync = promisify(execFile);

const defaultYellowFruitRepo = path.resolve(process.cwd(), '../../Codex/2026-08-26/pu/yellowfruit-link');
export const yellowFruitRepo = process.env.YELLOWFRUIT_REPO ?? defaultYellowFruitRepo;

export const yellowFruitHarnessAvailable =
  existsSync(path.join(yellowFruitRepo, 'package.json')) &&
  existsSync(path.join(yellowFruitRepo, 'node_modules/ts-node/register/transpile-only.js')) &&
  existsSync(path.join(yellowFruitRepo, 'src/main/qbtcp/QbtcpServer.ts')) &&
  existsSync(path.join(yellowFruitRepo, 'src/renderer/TournamentManager.ts')) &&
  existsSync(path.join(yellowFruitRepo, 'src/renderer/DataModel/QbjAssignment.ts'));

interface IYellowFruitPlayer {
  id: string;
  name: string;
}

interface IYellowFruitTeam {
  id: string;
  name: string;
  players: IYellowFruitPlayer[];
}

interface IYellowFruitRound {
  number: number;
  revision: number;
  matches: Array<{
    id: string;
    scheduledGameId?: string;
    tossupsRead?: number;
    leftTeam?: { points?: number };
    rightTeam?: { points?: number };
  }>;
  addScheduledGame(game: IYellowFruitScheduledGame, options?: { bumpRevision?: boolean }): void;
}

interface IYellowFruitPhase {
  rounds: IYellowFruitRound[];
  pools: IYellowFruitPool[];
}

interface IYellowFruitPool {
  addTeam(team: IYellowFruitTeam): void;
}

interface IYellowFruitScheduledGame {
  id: string;
}

interface IYellowFruitTournament {
  name: string;
  tournamentId: string;
  phases: IYellowFruitPhase[];
  roomProcedure: object;
  handoffInstruction?: string;
  scoringRules: { applyRuleSet(ruleSet: string): void };
  addRegistration(registration: object): void;
  ensureTournamentId(): string;
  findPhaseByRound(round: IYellowFruitRound): IYellowFruitPhase | undefined;
}

interface IYellowFruitRoom {
  id: string;
  name: string;
  pairingCode: string;
}

interface IYellowFruitResult {
  id: string;
  matchId: string;
  status: string;
  document?: object;
  importedMatchId?: string;
  warnings?: unknown[];
}

interface IYellowFruitRosterTeam {
  id: string;
  name: string;
  players: IYellowFruitPlayer[];
}

interface IYellowFruitSession {
  id?: string;
  matchId?: string;
  writerGrantToken?: string | null;
  grants?: Array<{ token: string }>;
  status?: string;
  finalReceived?: boolean;
  progressSequence: number;
  rosterAmendments?: Array<{ playerName: string; playerId?: string; teamId: string }>;
}

interface IYellowFruitState {
  results: IYellowFruitResult[];
  sessions: IYellowFruitSession[];
  roster: { left: IYellowFruitRosterTeam; right: IYellowFruitRosterTeam };
  matches: Array<{
    id: string;
    scheduledGameId?: string;
    tossupsRead?: number;
    leftPoints?: number;
    rightPoints?: number;
  }>;
  importPreview?: { modalIsOpen: boolean; statuses: string[]; messages: string[]; comparisons: string[] };
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
    assignmentRevision?: number;
    document: object;
  }): Promise<{ id: string } | { assigned: false; reason: string }>;
  start(port: number): Promise<void>;
  stop(): Promise<void>;
  getState(): {
    results: IYellowFruitResult[];
    sessions: IYellowFruitSession[];
  };
  classifyResults(document: object, reviewingResultId?: string): unknown[];
  recordFileResult(document: object): Promise<void>;
  reviewResult(
    resultId: string,
    request: { decision: 'accept'; imported: true },
  ): Promise<{ reviewed: boolean }>;
  unresolvedResults(): IYellowFruitResult[];
}

interface IYellowFruitRosterPlayerRequest {
  requestId: string;
  roomId: string;
  sessionId: string;
  teamId: string;
  teamName: string;
  playerName: string;
  questionNumber?: number;
}

type IYellowFruitRosterPlayerOutcome =
  | {
      ok: true;
      playerId?: string;
      playerName?: string;
      teamId?: string;
      teamName?: string;
      created?: boolean;
      warning?: string;
    }
  | { ok: false; status?: number; error: string };

interface IYellowFruitStoreConstructor {
  new (directory: string): object;
}

interface IYellowFruitServerConstructor {
  new (
    store: object,
    hooks: {
      onResultReceived: (result: unknown) => void;
      onStateChanged: () => void;
      onRosterPlayerRequested?: (
        request: IYellowFruitRosterPlayerRequest,
      ) => Promise<IYellowFruitRosterPlayerOutcome>;
    },
  ): IYellowFruitServer;
}

interface IYellowFruitTournamentConstructor {
  new (name?: string): IYellowFruitTournament;
}

interface IYellowFruitPhaseConstructor {
  new (type: string, firstRound: number, lastRound: number, code: string, name?: string): IYellowFruitPhase;
}

interface IYellowFruitTeamConstructor {
  new (name: string): IYellowFruitTeam;
}

interface IYellowFruitPlayerConstructor {
  new (name: string): IYellowFruitPlayer;
}

interface IYellowFruitRegistrationConstructor {
  new (name: string, team?: IYellowFruitTeam): object;
}

interface IYellowFruitScheduledGameConstructor {
  new (
    leftTeam: IYellowFruitTeam,
    rightTeam: IYellowFruitTeam,
    options?: { id?: string },
  ): IYellowFruitScheduledGame;
}

interface IYellowFruitPoolConstructor {
  new (size: number, position: number, name?: string): IYellowFruitPool;
}

interface IYellowFruitTournamentManager {
  tournament: IYellowFruitTournament;
  dataChangedReactCallback: () => void;
  makeToast: () => void;
  matchImportResultsManager: {
    modalIsOpen: boolean;
    resultsList?: Array<{ status: number; messages: string[]; comparison?: { kind: string } }>;
  };
  modalManagersSetTournament(): void;
  closeMatchImportModal(shouldImport: boolean): void;
  handleQbtcpResultReceived(result: unknown): void;
  handleQbtcpRosterPlayerRequest(request: IYellowFruitRosterPlayerRequest): Promise<void>;
}

interface IYellowFruitModules {
  server: IYellowFruitServerConstructor;
  store: IYellowFruitStoreConstructor;
  Tournament: IYellowFruitTournamentConstructor;
  Phase: IYellowFruitPhaseConstructor;
  Team: IYellowFruitTeamConstructor;
  Player: IYellowFruitPlayerConstructor;
  Registration: IYellowFruitRegistrationConstructor;
  ScheduledGame: IYellowFruitScheduledGameConstructor;
  Pool: IYellowFruitPoolConstructor;
  buildAssignmentDocument: (request: {
    tournament: IYellowFruitTournament;
    phase: IYellowFruitPhase;
    round: IYellowFruitRound;
    leftTeam: IYellowFruitTeam;
    rightTeam: IYellowFruitTeam;
    matchId: string;
    roomName: string;
    roomId: string;
    roundRevision: number;
    assignmentRevision: number;
  }) => object;
  phaseTypes: { Prelim: string };
  commonRuleSets: { AcfPowers: string };
  TournamentManager: new () => IYellowFruitTournamentManager;
}

async function gitRevision(ref: string): Promise<string> {
  const result = await execFileAsync('git', ['-C', yellowFruitRepo, 'rev-parse', ref]);
  return result.stdout.trim();
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

function installRendererWindow(invoke: (...args: unknown[]) => Promise<unknown>): unknown {
  const rendererGlobal = globalThis as { window?: unknown };
  const previousWindow = rendererGlobal.window;
  rendererGlobal.window = {
    electron: {
      ipcRenderer: {
        invoke,
        on: () => {},
        sendMessage: () => {},
      },
    },
  };
  return previousWindow;
}

function restoreRendererWindow(previousWindow: unknown): void {
  (globalThis as { window?: unknown }).window = previousWindow;
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

  const load = <T>(relativePath: string): T =>
    requireFromYellowFruit(path.join(yellowFruitRepo, relativePath)) as T;
  const serverModule = load<{ default: IYellowFruitServerConstructor }>('src/main/qbtcp/QbtcpServer.ts');
  const storeModule = load<{ default: IYellowFruitStoreConstructor }>('src/main/qbtcp/QbtcpStore.ts');
  const tournamentModule = load<{ default: IYellowFruitTournamentConstructor }>(
    'src/renderer/DataModel/Tournament.ts',
  );
  const phaseModule = load<{ Phase: IYellowFruitPhaseConstructor; PhaseTypes: { Prelim: string } }>(
    'src/renderer/DataModel/Phase.ts',
  );
  const teamModule = load<{ Team: IYellowFruitTeamConstructor }>('src/renderer/DataModel/Team.ts');
  const playerModule = load<{ Player: IYellowFruitPlayerConstructor }>('src/renderer/DataModel/Player.ts');
  const registrationModule = load<{ default: IYellowFruitRegistrationConstructor }>(
    'src/renderer/DataModel/Registration.ts',
  );
  const scheduledGameModule = load<{ ScheduledGame: IYellowFruitScheduledGameConstructor }>(
    'src/renderer/DataModel/ScheduledGame.ts',
  );
  const poolModule = load<{ Pool: IYellowFruitPoolConstructor }>('src/renderer/DataModel/Pool.ts');
  const assignmentModule = load<{
    buildAssignmentDocument: IYellowFruitModules['buildAssignmentDocument'];
  }>('src/renderer/DataModel/QbjAssignment.ts');
  const scoringRulesModule = load<{ CommonRuleSets: { AcfPowers: string } }>(
    'src/renderer/DataModel/ScoringRules.ts',
  );

  // TournamentManager constructs its module-level NullTournamentManager while loading. It only
  // needs a harmless IPC surface at that point; the route below is replaced with the real server
  // once it has been constructed.
  const previousWindow = installRendererWindow(async () => ({ ok: true, status: emptyStatus(false) }));
  const managerModule = load<{ TournamentManager: IYellowFruitModules['TournamentManager'] }>(
    'src/renderer/TournamentManager.ts',
  );
  restoreRendererWindow(previousWindow);

  return {
    server: serverModule.default,
    store: storeModule.default,
    Tournament: tournamentModule.default,
    Phase: phaseModule.Phase,
    Team: teamModule.Team,
    Player: playerModule.Player,
    Registration: registrationModule.default,
    ScheduledGame: scheduledGameModule.ScheduledGame,
    Pool: poolModule.Pool,
    buildAssignmentDocument: assignmentModule.buildAssignmentDocument,
    phaseTypes: phaseModule.PhaseTypes,
    commonRuleSets: scoringRulesModule.CommonRuleSets,
    TournamentManager: managerModule.TournamentManager,
  };
}

function emptyStatus(running: boolean): object {
  return {
    running,
    addresses: [],
    hasActiveWork: false,
    rooms: [],
    reviewQueue: [],
    scoresheetUrl: 'https://qbsheet.openai.invalid',
  };
}

function makeTournament(modules: IYellowFruitModules): {
  tournament: IYellowFruitTournament;
  round: IYellowFruitRound;
  leftTeam: IYellowFruitTeam;
  rightTeam: IYellowFruitTeam;
  scheduledGame: IYellowFruitScheduledGame;
} {
  const tournament = new modules.Tournament('Spring Invitational');
  tournament.tournamentId = 'Tournament_spring-2026';
  tournament.roomProcedure = {
    version: 3,
    halves: true,
    breaks: [{ afterTossup: 10, label: 'Mid-game' }],
    halfLengthMinutes: 25,
    timeoutsPerTeam: 1,
    timeoutDurationSeconds: 30,
    protestCheckpoints: 'phase-boundaries',
    substitutionPolicy: 'any-boundary',
  };
  tournament.handoffInstruction = 'Return the scoresheet to the director table.';
  tournament.scoringRules.applyRuleSet(modules.commonRuleSets.AcfPowers);
  const phase = new modules.Phase(modules.phaseTypes.Prelim, 1, 6, '1');
  tournament.phases = [phase];

  const makeTeam = (name: string, playerNames: string[]): IYellowFruitTeam => {
    const team = new modules.Team(name);
    team.players = playerNames.map((playerName) => new modules.Player(playerName));
    tournament.addRegistration(new modules.Registration(name, team));
    return team;
  };
  const leftTeam = makeTeam('Ninety Six', ['Sarah', 'James', 'Alex', 'Taylor']);
  const rightTeam = makeTeam('Greenwood', ['Emma', 'Jordan', 'Morgan', 'Casey']);
  const pool = new modules.Pool(2, 1, 'Prelims');
  pool.addTeam(leftTeam);
  pool.addTeam(rightTeam);
  phase.pools = [pool];
  const round = phase.rounds.find((entry) => entry.number === 4);
  if (!round) throw new Error('YellowFruit fixture has no Round 4.');
  const scheduledGame = new modules.ScheduledGame(leftTeam, rightTeam, { id: 'SchedGame_interop_round-4' });
  round.addScheduledGame(scheduledGame, { bumpRevision: false });
  return { tournament, round, leftTeam, rightTeam, scheduledGame };
}

export interface IYellowFruitControl {
  readonly origin: string;
  readonly roomId: string;
  readonly pairingCode: string;
  readonly matchId: string;
  readonly assignmentDocument: object;
  readonly roster: { left: IYellowFruitRosterTeam; right: IYellowFruitRosterTeam };
  readonly state: () => IYellowFruitState;
  readonly submitWarning: () => Promise<Record<string, unknown>>;
  readonly reviewWarning: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * Start YellowFruit's real server, real tournament model, and real renderer importer.
 *
 * The browser still scores through QBSheet's production UI. The result callback then enters
 * `TournamentManager.handleQbtcpResultReceived`, which parses the QBJ, commits the Match, and sends
 * the explicit imported review decision back through the server. There is intentionally no direct
 * test-only call to `reviewResult`.
 */
export async function startYellowFruitControl(): Promise<IYellowFruitControl> {
  if (!yellowFruitHarnessAvailable) {
    throw new Error(
      'YellowFruit checkout not found. Set YELLOWFRUIT_REPO to a sibling checkout to enable this test.',
    );
  }

  const modules = await loadYellowFruitModules();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qbsheet-yellowfruit-qbtcp-'));
  const model = makeTournament(modules);
  let manager: IYellowFruitTournamentManager | undefined;
  let server: IYellowFruitServer | undefined;
  let previousWindow: unknown;
  const pendingRosterRequests = new Map<string, (outcome: IYellowFruitRosterPlayerOutcome) => void>();

  const statusForRenderer = () => emptyStatus(server?.running ?? false);
  const invoke = async (...args: unknown[]): Promise<unknown> => {
    const rawCommand = args[args.length - 1];
    const command = rawCommand as {
      kind?: string;
      resultId?: string;
      document?: object;
      reviewingResultId?: string;
      requestId?: string;
      outcome?: IYellowFruitRosterPlayerOutcome;
    };
    if (!server) return { ok: true, status: statusForRenderer() };
    switch (command.kind) {
      case 'bind':
      case 'status':
      case 'setScoresheetUrl':
        return { ok: true, status: statusForRenderer() };
      case 'classifyResults':
        return {
          ok: true,
          comparisons: server.classifyResults(command.document ?? {}, command.reviewingResultId),
        };
      case 'recordFileResult':
        await server.recordFileResult(command.document ?? {});
        return { ok: true };
      case 'reviewResult': {
        const result = await server.reviewResult(command.resultId ?? '', {
          decision: 'accept',
          imported: true,
        });
        return result.reviewed
          ? { ok: true, status: statusForRenderer() }
          : { ok: false, error: 'Review failed.' };
      }
      case 'completeRosterPlayerRequest': {
        const resolve = command.requestId ? pendingRosterRequests.get(command.requestId) : undefined;
        if (!resolve || !command.outcome)
          return { ok: false, error: 'That roster update is no longer waiting.' };
        pendingRosterRequests.delete(command.requestId as string);
        resolve(command.outcome);
        return { ok: true };
      }
      case 'unresolvedResults':
        return { ok: true, results: server.unresolvedResults() };
      default:
        return { ok: true, status: statusForRenderer() };
    }
  };

  try {
    const store = new modules.store(directory);
    server = new modules.server(store, {
      onResultReceived: (result) => manager?.handleQbtcpResultReceived(result),
      onStateChanged: () => {},
      onRosterPlayerRequested: async (request) => {
        if (!manager) return { ok: false, status: 503, error: 'YellowFruit is not ready.' };
        const outcome = new Promise<IYellowFruitRosterPlayerOutcome>((resolve) => {
          pendingRosterRequests.set(request.requestId, resolve);
        });
        try {
          await manager.handleQbtcpRosterPlayerRequest(request);
          return await withTimeout(outcome, 5_000, 'YellowFruit roster update');
        } finally {
          pendingRosterRequests.delete(request.requestId);
        }
      },
    });
    await server.bindTournament(model.tournament.tournamentId);
    await server.setScoresheetUrl('http://127.0.0.1:4173');
    const room = await server.addRoom('Room 204');
    const document = modules.buildAssignmentDocument({
      tournament: model.tournament,
      phase: model.tournament.findPhaseByRound(model.round) ?? model.tournament.phases[0],
      round: model.round,
      leftTeam: model.leftTeam,
      rightTeam: model.rightTeam,
      matchId: model.scheduledGame.id,
      roomName: room.name,
      roomId: room.id,
      roundRevision: model.round.revision,
      assignmentRevision: 1,
    });
    const assigned = await server.setAssignment({
      roomId: room.id,
      roundNumber: model.round.number,
      leftTeamId: model.leftTeam.id,
      rightTeamId: model.rightTeam.id,
      leftTeamName: model.leftTeam.name,
      rightTeamName: model.rightTeam.name,
      matchId: model.scheduledGame.id,
      roundRevision: model.round.revision,
      assignmentRevision: 1,
      document,
    });
    if (!('id' in assigned))
      throw new Error(`YellowFruit could not publish the contract assignment: ${assigned.reason}`);

    const startup = server.start(0);
    try {
      await withTimeout(startup, 5_000, 'YellowFruit QBTCP server startup');
    } catch (error) {
      // A server implementation that finishes binding after the timeout must still be cleaned up.
      void startup
        .then(async () => {
          if (server?.running) await server.stop();
        })
        .catch(() => {});
      if (server.running) await server.stop();
      throw error;
    }
    if (server.port === undefined)
      throw new Error('YellowFruit started without reporting its listening port.');

    previousWindow = installRendererWindow(invoke);
    manager = new modules.TournamentManager();
    manager.tournament = model.tournament;
    manager.dataChangedReactCallback = () => {};
    manager.makeToast = () => {};
    manager.modalManagersSetTournament();

    let closed = false;
    return {
      origin: `http://127.0.0.1:${server.port}`,
      roomId: room.id,
      pairingCode: room.pairingCode,
      matchId: model.scheduledGame.id,
      assignmentDocument: document,
      roster: {
        left: {
          id: model.leftTeam.id,
          name: model.leftTeam.name,
          players: model.leftTeam.players.map((player) => ({ id: player.id, name: player.name })),
        },
        right: {
          id: model.rightTeam.id,
          name: model.rightTeam.name,
          players: model.rightTeam.players.map((player) => ({ id: player.id, name: player.name })),
        },
      },
      state: () => {
        const state = server?.getState();
        const rosterSnapshot = (team: IYellowFruitTeam): IYellowFruitRosterTeam => ({
          id: team.id,
          name: team.name,
          players: team.players.map((player) => ({ id: player.id, name: player.name })),
        });
        return {
          results: state?.results ?? [],
          sessions: state?.sessions ?? [],
          roster: { left: rosterSnapshot(model.leftTeam), right: rosterSnapshot(model.rightTeam) },
          matches: model.round.matches.map((match) => ({
            id: match.id,
            scheduledGameId: match.scheduledGameId,
            tossupsRead: match.tossupsRead,
            leftPoints: match.leftTeam?.points,
            rightPoints: match.rightTeam?.points,
          })),
          ...(manager
            ? {
                importPreview: {
                  modalIsOpen: manager.matchImportResultsManager.modalIsOpen,
                  statuses: (manager.matchImportResultsManager.resultsList ?? []).map((result) =>
                    String(result.status),
                  ),
                  messages: (manager.matchImportResultsManager.resultsList ?? []).flatMap(
                    (result) => result.messages,
                  ),
                  comparisons: (manager.matchImportResultsManager.resultsList ?? []).map(
                    (result) => result.comparison?.kind ?? 'none',
                  ),
                },
              }
            : {}),
        };
      },
      submitWarning: async () => {
        if (!server?.port) throw new Error('YellowFruit server is not listening.');
        const state = server.getState();
        const session = state.sessions.find((entry) => entry.matchId === model.scheduledGame.id);
        const token = session?.grants?.find((grant) => grant.token === session.writerGrantToken)?.token;
        const source = state.results.find((result) => result.matchId === model.scheduledGame.id)?.document;
        if (!session?.id || !token || !source)
          throw new Error('The clean result did not leave warning-test evidence.');
        const warningDocument = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
        const currentTossups = warningDocument.tossups_read;
        warningDocument.tossups_read =
          typeof currentTossups === 'number' ? Math.max(0, currentTossups - 1) : 19;
        const response = await fetch(
          `http://127.0.0.1:${server.port}/qbtcp/v1/sessions/${session.id}/result`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-yf-session-token': token },
            body: JSON.stringify(warningDocument),
          },
        );
        const body = (await response.json()) as Record<string, unknown>;
        if (!response.ok) throw new Error(`YellowFruit warning result failed with HTTP ${response.status}.`);
        return body;
      },
      reviewWarning: async () => {
        if (!manager) throw new Error('YellowFruit importer is not ready.');
        // This is the same public manager action the Rooms page uses after a director commits the
        // import modal. It deliberately does not call the server review primitive directly.
        await manager.closeMatchImportModal(true);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        if (server?.running) await server.stop();
        restoreRendererWindow(previousWindow);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server?.running) await server.stop();
    if (previousWindow !== undefined) restoreRendererWindow(previousWindow);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
