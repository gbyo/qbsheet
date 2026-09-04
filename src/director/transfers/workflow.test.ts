/**
 * The whole tournament day, in order, against a real filesystem.
 *
 * # Why this exists next to the unit tests
 *
 * The unit tests each assert one property of one module. This asserts that the sequence a
 * tournament director actually performs works end to end: create, release, prepare onto a drive,
 * open the file in the scorer, score it, put the result back, detect it, match it, accept it, watch
 * the standings move. A subsystem can pass every unit test and still be unusable in that order.
 *
 * It runs against real directories under the OS temp directory rather than physical media, which is
 * what makes it a CI test rather than a note in a manual test plan. The parts a temp directory
 * cannot stand in for — a drive that mounts read-only, a drive pulled mid-write, macOS versus
 * Windows mount points — are covered by `filesystem.test.ts` against the memory port and by the
 * Rust tests against a real filesystem, and the rest is in `docs/TRANSFERS_DEVICE_CHECKLIST.md`.
 *
 * # The scorer interop step is the one that could not be faked
 *
 * Step 6 reads the exported assignment with `defineGame` — the scorer's own parser, the same
 * function a QBTCP assignment goes through. If Director ever wrote a document the scorer could not
 * open, this is what would fail, and it would fail here rather than in a room.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineGame, readQbjText, scoreableWithoutChoice } from '../../qbj/ParseQbjAssignment';
import { deriveTeamStandings } from '../domain/stats';
import { isoNow, newDirectorId, type DirectorState } from '../domain/model';
import { digestText } from './canonical';
import { assessIncomingDocument, stageIncomingDocument, type IncomingDocument } from './ingest';
import { exchangePaths, joinPath } from './layout';
import { maxScanFileBytes } from './limits';
import type {
  TransferDirectoryEntry,
  TransferFileSystem,
  TransferReadResult,
  TransferVolume,
  RemovableVolumeSource,
} from './ports';
import { prepareAssignments } from './prepare';
import { collectFromLocation, readBrowserFiles } from './service';
import {
  addTransferLocation,
  importTransferDocuments,
  recordPreparedAssignments,
  recordQbtcpDelivery,
  syncRemovableVolumes,
} from './state';
import { directorFixture, scoreAssignment } from './testFixtures';

/**
 * The port over Node's filesystem.
 *
 * Lives in the test rather than in the product because the product's implementation of this port
 * talks to Rust. What it shares with the real one is the contract, which is the thing worth
 * exercising: same bounds, same non-recursive listing, same atomic write shape.
 */
class NodeTransferFileSystem implements TransferFileSystem, RemovableVolumeSource {
  readonly kind = 'memory' as const;
  constructor(private readonly volumes: TransferVolume[] = []) {}

  async listDirectory(path: string, limit: number): Promise<TransferDirectoryEntry[]> {
    const entries = await fs.readdir(path, { withFileTypes: true });
    const output: TransferDirectoryEntry[] = [];
    for (const entry of entries.slice(0, limit)) {
      const entryPath = join(path, entry.name);
      const stats = await fs.lstat(entryPath);
      output.push({
        name: entry.name,
        path: entryPath,
        directory: stats.isDirectory(),
        byteLength: stats.isFile() ? stats.size : 0,
        ...(stats.isSymbolicLink() ? { symlink: true } : {}),
      });
    }
    return output;
  }

  async readFile(path: string, maxBytes: number): Promise<TransferReadResult> {
    const stats = await fs.stat(path);
    if (stats.size > maxBytes) throw new Error('That file is too large to read as QBJ.');
    const bytes = new Uint8Array(await fs.readFile(path));
    return { bytes, byteLength: bytes.byteLength };
  }

  async writeFileAtomic(path: string, contents: string): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    await fs.writeFile(temporary, contents, 'utf8');
    await fs.rename(temporary, path);
  }

  async createDirectory(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async availableBytes(): Promise<number | undefined> {
    return undefined;
  }

  async listVolumes(): Promise<TransferVolume[]> {
    return this.volumes;
  }
}

function documentFor(
  qbj: unknown,
  sourceKind: IncomingDocument['sourceKind'],
  sourceLabel: string,
  overrides: Partial<IncomingDocument> = {},
): IncomingDocument {
  const text = JSON.stringify(qbj);
  return {
    sourceKind,
    sourceLabel,
    fileName: 'result.qbj',
    byteLength: text.length,
    digest: digestText(text),
    qbj,
    ...overrides,
  };
}

/**
 * The Results-page step, as the controller performs it.
 *
 * Deliberately the same mutation `acceptSubmission` makes, so that "accepted through the existing
 * Results pipeline" means the pipeline and not a shortcut this test invented.
 */
function acceptSubmission(state: DirectorState, submissionId: string): void {
  const submission = state.submissions.find((entry) => entry.id === submissionId);
  if (!submission) throw new Error('workflow: no such submission');
  submission.status = 'accepted';
  submission.acceptedAt = isoNow();
  const game = state.games.find((entry) => entry.id === submission.gameId);
  if (!game) return;
  game.status = 'accepted';
  game.acceptedAt = submission.acceptedAt;
  const scheduled = state.scheduledGames.find((entry) => entry.id === game.scheduledGameId);
  if (scheduled) scheduled.status = 'accepted';
  state.audit.push({
    id: newDirectorId('audit'),
    at: isoNow(),
    actor: 'Director',
    type: 'result-accepted',
    summary: `Accepted result ${submissionId}.`,
    entityId: submission.gameId,
  });
}

describe('a tournament day, from an empty drive to updated standings', () => {
  let root = '';
  let usb = '';
  let drive = '';
  let downloads = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'qbsheet-transfers-'));
    usb = join(root, 'SANDISK');
    drive = join(root, 'Google Drive', 'Quiz Bowl Exchange');
    downloads = join(root, 'Downloads');
    await fs.mkdir(usb, { recursive: true });
    await fs.mkdir(drive, { recursive: true });
    await fs.mkdir(downloads, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('runs the full USB round trip and keeps working with the network unplugged', async () => {
    // Steps 1 and 2: a tournament with a generated, released round.
    const state = directorFixture({ games: 4 });
    expect(state.rounds[0].status).toBe('released');
    expect(state.scheduledGames.filter((game) => game.roundId === 'round-5')).toHaveLength(4);

    // Step 23, brought forward so it covers everything that follows: nothing in the file path may
    // touch the network. Any `fetch` from here on fails the test rather than quietly succeeding.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('the network is unplugged');
    }) as typeof fetch;

    try {
      // Steps 3 and 4: a drive appears and Director adopts it.
      const fileSystem = new NodeTransferFileSystem([
        { mountPoint: usb, name: 'SanDisk Ultra', removable: true, readOnly: false },
        { mountPoint: root, name: 'Macintosh HD', removable: false, readOnly: false },
      ]);
      const volumes = await fileSystem.listVolumes();
      // A legitimate location UUID can contain the same digits as a later score.
      const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('200d43dd-4967-467f-b853-f0325b812a16');
      let appeared: ReturnType<typeof syncRemovableVolumes>;
      try {
        appeared = syncRemovableVolumes(state, volumes);
      } finally {
        uuid.mockRestore();
      }
      expect(appeared.appeared.map((location) => location.label)).toEqual(['SanDisk Ultra']);
      const usbLocation = state.transfers.locations[0];
      expect(usbLocation.id).toContain('325');

      // Step 5: prepare the round's assignments onto it.
      const prepared = await prepareAssignments(state, fileSystem, {
        basePath: usb,
        destinationLabel: 'SanDisk Ultra',
        selection: { kind: 'current-round' },
        directorBuild: 'workflow-test',
      });
      recordPreparedAssignments(state, {
        report: prepared,
        transportKind: 'removable-drive',
        destinationLabel: 'SanDisk Ultra',
        locationId: usbLocation.id,
      });
      expect(prepared.written).toHaveLength(4);
      expect(prepared.message).toContain('Eject the drive normally');
      expect(await fs.readFile(exchangePaths(usb).readme, 'utf8')).toContain('Do not rename files');

      // Step 6: open one of the exported files in the scorer, using the scorer's own parser. This
      // is the interoperability claim, checked rather than asserted in a comment.
      const room101 = prepared.written.find((written) => written.assignment.roomName === 'Room 101');
      if (!room101) throw new Error('workflow: room 101 was not prepared');
      const onDisk = await fs.readFile(room101.path, 'utf8');
      const source = readQbjText(onDisk);
      expect(source.ok).toBe(true);
      if (!source.ok) return;
      const candidate = scoreableWithoutChoice(source.value);
      expect(candidate?.state).toBe('unplayed');
      const defined = defineGame(source.value, candidate?.index ?? 0);
      expect(defined.ok).toBe(true);
      if (!defined.ok) return;
      // The identities the profile requires an assignment to preserve, read back by the scorer.
      expect([defined.definition.left.name, defined.definition.right.name]).toEqual([
        'Ninety Six A',
        'Greenwood A',
      ]);
      expect(defined.definition.scheduledMatchId).toBe('game-5-1');
      expect(defined.definition.tournament.key).toBe('tournament-fixture');
      expect(defined.definition.round.revision).toBe(1);
      expect(defined.definition.room?.name).toBe('Room 101');
      // Structural rules survived the round trip, so the room can score without being asked to
      // choose a format.
      expect(defined.definition.scorekeeperFormat.answerTypes.map((type) => type.value)).toEqual([
        15, 10, -5,
      ]);
      expect(defined.definition.scorekeeperFormat.regulation.tossupCount).toBe(20);

      // Steps 7 and 8: the room scores it offline and saves the completed QBJ.
      const completed = scoreAssignment(JSON.parse(onDisk), { leftPoints: 325, rightPoints: 210 });

      // Steps 9 and 10: the file goes into Results on the stick, and the stick comes back.
      await fs.writeFile(
        joinPath(exchangePaths(usb).results, 'Round 5 - Room 101 - completed.qbj'),
        JSON.stringify(completed),
        'utf8',
      );

      // Steps 11 and 12: Director finds it and matches it to the right scheduled game.
      const collected = await collectFromLocation(fileSystem, usb, {
        sourceKind: 'removable-drive',
        sourceLabel: 'SanDisk Ultra',
        includeAssignments: true,
      });
      const summary = importTransferDocuments(state, collected.inputs);
      // Four assignments Director wrote are recognised as assignments, one game is staged.
      expect(summary.assignments).toBe(4);
      expect(summary.imported).toBe(1);
      const staged = state.submissions.find((entry) => entry.status === 'received');
      expect(staged).toBeDefined();
      const stagedGame = state.games.find((game) => game.id === staged?.gameId);
      expect(stagedGame?.scheduledGameId).toBe('game-5-1');
      expect(stagedGame?.scores.map((score) => score.score)).toEqual([325, 210]);

      // Steps 13 and 14: accept it through Results, and the standings move.
      expect(deriveTeamStandings(state).find((team) => team.teamId === 'team-1')?.wins ?? 0).toBe(0);
      acceptSubmission(state, staged?.id ?? '');
      const standings = deriveTeamStandings(state);
      expect(standings.find((team) => team.teamId === 'team-1')?.wins).toBe(1);
      expect(standings.find((team) => team.teamId === 'team-2')?.losses).toBe(1);

      // Steps 15, 16 and 17: another game goes out over QBTCP, and its duplicate comes back on the
      // stick. One accepted game, one recognised duplicate.
      recordQbtcpDelivery(state, 'round-5');
      const room102Assignment = prepared.written.find(
        (written) => written.assignment.roomName === 'Room 102',
      );
      const room102Result = scoreAssignment(
        JSON.parse(await fs.readFile(room102Assignment?.path ?? '', 'utf8')),
        { leftPoints: 280, rightPoints: 275 },
      );
      const overNetwork = documentFor(room102Result, 'qbtcp', 'Room 102 (QBTCP)', {
        transportResultId: 'result-102',
        sessionId: 'session-102',
        digest: 'qbtcp-result-102',
      });
      const networkAssessment = assessIncomingDocument(state, overNetwork);
      stageIncomingDocument(state, overNetwork, networkAssessment);
      expect(networkAssessment.classification).toBe('ready');

      await fs.writeFile(
        joinPath(exchangePaths(usb).results, 'Round 5 - Room 102 - completed.qbj'),
        JSON.stringify(room102Result),
        'utf8',
      );
      const secondPass = await collectFromLocation(fileSystem, usb, {
        sourceKind: 'removable-drive',
        sourceLabel: 'SanDisk Ultra',
      });
      const secondSummary = importTransferDocuments(state, secondPass.inputs);
      expect(secondSummary.duplicates).toBe(1);
      // The already-imported room 101 file is skipped rather than staged twice.
      expect(secondSummary.skipped).toBe(1);
      expect(state.games.filter((game) => game.scheduledGameId === 'game-5-2')).toHaveLength(1);

      // Steps 18, 19 and 20: the same layout in a folder a cloud client syncs, and a completed game
      // dropped into its Results directory is staged. No provider API is involved anywhere.
      const driveLocation = addTransferLocation(state, {
        kind: 'folder',
        label: 'Quiz Bowl Exchange',
        path: drive,
      });
      expect(driveLocation.cloudProvider).toBe('Google Drive');
      const drivePrepared = await prepareAssignments(state, fileSystem, {
        basePath: drive,
        destinationLabel: 'Quiz Bowl Exchange',
        selection: { kind: 'current-round' },
        directorBuild: 'workflow-test',
      });
      const room103 = drivePrepared.written.find((written) => written.assignment.roomName === 'Room 103');
      const room103Result = scoreAssignment(JSON.parse(await fs.readFile(room103?.path ?? '', 'utf8')), {
        leftPoints: 400,
        rightPoints: 120,
      });
      await fs.writeFile(
        joinPath(exchangePaths(drive).results, 'room-103.qbj'),
        JSON.stringify(room103Result),
        'utf8',
      );
      const fromDrive = await collectFromLocation(fileSystem, drive, {
        sourceKind: 'folder',
        sourceLabel: 'Quiz Bowl Exchange',
      });
      const driveSummary = importTransferDocuments(state, fromDrive.inputs);
      expect(driveSummary.imported).toBe(1);

      // Steps 21 and 22: several downloaded files dragged onto the window go through the same
      // pipeline. One of them is deliberately broken, and it costs only itself.
      const room104 = drivePrepared.written.find((written) => written.assignment.roomName === 'Room 104');
      const room104Result = scoreAssignment(JSON.parse(await fs.readFile(room104?.path ?? '', 'utf8')), {
        leftPoints: 250,
        rightPoints: 245,
      });
      const dropped = [
        new File([JSON.stringify(room104Result)], 'Room 104 result.qbj', { type: 'application/json' }),
        new File(['{"version": "2.1.1", "objects": ['], 'truncated.qbj', { type: 'application/json' }),
      ];
      const droppedInputs = await readBrowserFiles(dropped, {
        sourceKind: 'drop',
        sourceLabel: 'Dropped files',
      });
      const dropSummary = importTransferDocuments(state, droppedInputs);
      expect(dropSummary.imported).toBe(1);
      expect(dropSummary.invalid).toBe(1);

      // Step 24: every game in the round now has a staged or accepted result, and it all happened
      // with `fetch` throwing.
      const roundGames = state.scheduledGames.filter((game) => game.roundId === 'round-5');
      expect(roundGames.every((game) => ['submitted', 'accepted'].includes(game.status))).toBe(true);
      expect(state.games).toHaveLength(4);

      // The transfer history reads as an operation log, not a filesystem log: it names what
      // happened and where, and carries no file contents.
      const history = JSON.stringify(state.transfers.events);
      expect(history).toContain('Prepared 4 assignments on SanDisk Ultra');
      const eventPayloads = state.transfers.events.map(({ id: _id, at: _at, ...event }) => event);
      expect(JSON.stringify(eventPayloads)).not.toContain('match_teams');
      // Assert score fields are absent; score digits can legitimately appear in IDs or paths.
      expect(JSON.stringify(eventPayloads)).not.toMatch(/"(?:score|points)":/);
      expect(maxScanFileBytes).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('exports assignment files for a manual upload with no sync client at all', async () => {
    // The browser-cloud workflow: files land in a folder, a person uploads them by hand, and the
    // completed files come back by download and drag. Nothing here needs a provider.
    const state = directorFixture({ games: 2 });
    const fileSystem = new NodeTransferFileSystem();
    const report = await prepareAssignments(state, fileSystem, {
      basePath: downloads,
      destinationLabel: 'Downloads',
      selection: { kind: 'current-round' },
      directorBuild: 'workflow-test',
    });
    expect(report.written).toHaveLength(2);

    const returned = scoreAssignment(JSON.parse(await fs.readFile(report.written[0].path, 'utf8')));
    const inputs = await readBrowserFiles(
      [new File([JSON.stringify(returned)], 'downloaded (1).qbj', { type: 'application/json' })],
      { sourceKind: 'file-picker', sourceLabel: 'Chosen files' },
    );
    const summary = importTransferDocuments(state, inputs);
    expect(summary.imported).toBe(1);
    // A browser renamed the file and it made no difference: identity came out of the QBJ.
    expect(state.games[0].scheduledGameId).toBe('game-5-1');
  });
});
