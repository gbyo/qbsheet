/**
 * The product rule, asserted: a tournament never has to choose a transport.
 *
 * Every case in here is one round in which different rooms used different mechanisms, or one game
 * whose assignment went out one way and whose result came back another. None of them may confuse
 * Director, and the way that is achieved is that none of them takes a different code path — they
 * all go through `assessIncomingDocument`, which is why the fingerprints compare and the duplicates
 * are found.
 *
 * If someone later adds a second ingestion path for a new transport, these tests are what fails.
 */
import { describe, expect, it } from 'vitest';
import { digestText, resultFingerprint } from './canonical';
import {
  assessIncomingDocument,
  ingestWarnings,
  stageIncomingDocument,
  type IncomingDocument,
} from './ingest';
import { exchangePaths, joinPath } from './layout';
import { MemoryTransferFileSystem } from './ports';
import { prepareAssignments } from './prepare';
import { collectFromLocation } from './service';
import {
  addTransferLocation,
  importTransferDocuments,
  recordPreparedAssignments,
  recordQbtcpDelivery,
  syncRemovableVolumes,
  type ImportInput,
} from './state';
import { assignmentFor, directorFixture, scoreAssignment } from './testFixtures';
import { normalizeTransferState } from './model';
import type { DirectorState } from '../domain/model';

const mount = '/Volumes/SANDISK';

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

function ingest(state: DirectorState, document: IncomingDocument) {
  const assessment = assessIncomingDocument(state, document);
  const outcome = stageIncomingDocument(state, document, assessment);
  return { assessment, outcome };
}

describe('the same result arriving twice by different routes', () => {
  it('is one game and one duplicate, whichever route was first', () => {
    const state = directorFixture();
    const result = scoreAssignment(assignmentFor(state, 'game-5-1').document);

    // Arrives over QBTCP. The transport supplies its own result id and its own fingerprint, and
    // Director uses neither for matching.
    const overNetwork = ingest(
      state,
      documentFor(result, 'qbtcp', 'Room 101 (QBTCP)', {
        transportResultId: 'result-abc',
        sessionId: 'session-1',
        digest: 'qbtcp-result-abc',
      }),
    );
    expect(overNetwork.assessment.classification).toBe('ready');

    // The same game's backup copy comes back on a stick an hour later. The file is a different
    // sequence of bytes with a different digest; it is the same result.
    const onStick = ingest(
      state,
      documentFor(result, 'removable-drive', 'SanDisk Ultra', {
        fileName: 'Round 5 - Room 101 - result.qbj',
        originalPath: `${mount}/QBSheet/Results/room-101.qbj`,
      }),
    );

    expect(onStick.assessment.classification).toBe('duplicate');
    expect(onStick.assessment.detail).toBe('Director already has this exact result.');
    // One game record, not two. This is the assertion that matters.
    expect(state.games).toHaveLength(1);
    const duplicate = state.submissions.find((entry) => entry.status === 'duplicate');
    expect(duplicate?.reason).toContain('SanDisk Ultra');
    expect(state.transfers.events.some((event) => event.kind === 'duplicate-detected')).toBe(true);
  });

  it('compares equal even though the two copies carry different transport metadata', () => {
    const state = directorFixture();
    const result = scoreAssignment(assignmentFor(state, 'game-5-1').document) as {
      objects: Array<Record<string, unknown>>;
    };
    const stripped = structuredClone(result);
    // A copy whose `_qbtcp` block was dropped by a tool in the middle, and one with a legacy source
    // extension bolted on. Neither is a difference in the result.
    const match = stripped.objects.find((object) => object.type === 'Match');
    if (match) delete match._qbtcp;
    const annotated = structuredClone(result);
    const annotatedMatch = annotated.objects.find((object) => object.type === 'Match');
    if (annotatedMatch) annotatedMatch._qbsheet_source = { producer: 'something else' };

    expect(resultFingerprint(stripped)).toBe(resultFingerprint(result));
    expect(resultFingerprint(annotated)).toBe(resultFingerprint(result));
  });
});

describe('two routes that disagree', () => {
  it('raises a conflict for review rather than picking the newer one', () => {
    const state = directorFixture();
    const assignment = assignmentFor(state, 'game-5-1');
    const overNetwork = scoreAssignment(assignment.document, { leftPoints: 325, rightPoints: 210 });
    // The same match, scored differently. A protest was ruled on in the room and the paper copy is
    // not the copy that went over the wire.
    const onStick = scoreAssignment(assignment.document, { leftPoints: 315, rightPoints: 210 });

    ingest(state, documentFor(overNetwork, 'qbtcp', 'Room 101 (QBTCP)', { digest: 'qbtcp-1' }));
    const second = ingest(state, documentFor(onStick, 'removable-drive', 'SanDisk Ultra'));

    expect(second.assessment.classification).toBe('needs-review');
    expect(second.assessment.warnings).toContain(ingestWarnings.resultConflict);
    expect(second.assessment.conflictWithSubmissionId).toBe(state.submissions[0].id);

    const staged = state.submissions.find((entry) => entry.id === second.outcome.submissionId);
    expect(staged?.status).toBe('review');
    expect(staged?.conflictWith).toBe(state.submissions[0].id);
    // Two submissions for a director to reconcile; neither has been accepted.
    expect(state.submissions.every((entry) => entry.status !== 'accepted')).toBe(true);
  });
});

describe('a round where every room used a different mechanism', () => {
  it('produces one coherent set of staged results', () => {
    const state = directorFixture({ games: 4 });

    // Room 101 is on QBTCP. Room 102 hands in a stick. Room 103's result appears in a Drive-synced
    // folder. Room 104 is paper and the director types it in — which is `addManualResult`'s job and
    // is not routed through here at all, so it is represented by its scheduled game staying open.
    const overNetwork = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    const onStick = scoreAssignment(assignmentFor(state, 'game-5-2').document, {
      leftPoints: 280,
      rightPoints: 275,
    });
    const inDriveFolder = scoreAssignment(assignmentFor(state, 'game-5-3').document, {
      leftPoints: 400,
      rightPoints: 120,
    });

    ingest(state, documentFor(overNetwork, 'qbtcp', 'Room 101 (QBTCP)', { digest: 'qbtcp-1' }));
    ingest(state, documentFor(onStick, 'removable-drive', 'SanDisk Ultra'));
    ingest(state, documentFor(inDriveFolder, 'folder', 'Quiz Bowl Exchange'));

    expect(state.games).toHaveLength(3);
    expect(state.submissions.map((entry) => entry.status)).toEqual(['received', 'received', 'received']);
    // Each landed on its own scheduled game.
    expect(state.games.map((game) => game.scheduledGameId).sort()).toEqual([
      'game-5-1',
      'game-5-2',
      'game-5-3',
    ]);
    // The paper room is untouched and still shows as awaiting a result.
    expect(state.scheduledGames.find((game) => game.id === 'game-5-4')?.status).toBe('released');
    // And the source of each is recorded, so the transfer history reads correctly.
    expect(state.games.map((game) => game.source).sort()).toEqual(['qbj', 'qbj', 'qbtcp']);
  });

  it('handles an assignment sent over QBTCP whose result comes back on a stick', () => {
    const state = directorFixture();
    recordQbtcpDelivery(state, 'round-5');
    expect(state.transfers.assignments.every((entry) => entry.transportKind === 'qbtcp')).toBe(true);

    const result = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    const { assessment } = ingest(state, documentFor(result, 'removable-drive', 'SanDisk Ultra'));
    expect(assessment.classification).toBe('ready');
    expect(assessment.scheduledGameId).toBe('game-5-1');
  });

  it('handles an assignment prepared on a stick whose result comes back over QBTCP', async () => {
    const state = directorFixture();
    const fileSystem = new MemoryTransferFileSystem();
    fileSystem.addVolume(mount, { name: 'SanDisk Ultra', availableBytes: 4_000_000 });
    const report = await prepareAssignments(state, fileSystem, {
      basePath: mount,
      destinationLabel: 'SanDisk Ultra',
      selection: { kind: 'games', scheduledGameIds: ['game-5-1'] },
      directorBuild: 'test',
    });
    recordPreparedAssignments(state, {
      report,
      transportKind: 'removable-drive',
      destinationLabel: 'SanDisk Ultra',
    });

    // The room opened the file, scored it, and its device happened to reconnect before it finished.
    const written = JSON.parse(fileSystem.readSync(report.written[0].path) ?? '{}');
    const result = scoreAssignment(written);
    const { assessment } = ingest(
      state,
      documentFor(result, 'qbtcp', 'Room 101 (QBTCP)', { digest: 'qbtcp-1' }),
    );

    expect(assessment.classification).toBe('ready');
    expect(assessment.scheduledGameId).toBe('game-5-1');
    // Both deliveries are in one history.
    expect(state.transfers.assignments.map((entry) => entry.transportKind)).toEqual(['removable-drive']);
  });

  it('handles an assignment delivered both ways and a result that arrives both ways', async () => {
    const state = directorFixture();
    const fileSystem = new MemoryTransferFileSystem();
    fileSystem.addVolume(mount, { name: 'SanDisk Ultra', availableBytes: 4_000_000 });

    recordQbtcpDelivery(state, 'round-5');
    const report = await prepareAssignments(state, fileSystem, {
      basePath: mount,
      destinationLabel: 'SanDisk Ultra',
      selection: { kind: 'current-round' },
      directorBuild: 'test',
    });
    recordPreparedAssignments(state, {
      report,
      transportKind: 'removable-drive',
      destinationLabel: 'SanDisk Ultra',
    });

    // One game, two deliveries, in one table with one answer to "how did room 101 get this".
    const forGame = state.transfers.assignments.filter((entry) => entry.scheduledGameId === 'game-5-1');
    expect(forGame.map((entry) => entry.transportKind).sort()).toEqual(['qbtcp', 'removable-drive']);
    expect(forGame.every((entry) => entry.roundRevision === 1 && entry.assignmentRevision === 1)).toBe(true);

    const result = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    ingest(state, documentFor(result, 'qbtcp', 'Room 101 (QBTCP)', { digest: 'qbtcp-1' }));
    const second = ingest(state, documentFor(result, 'removable-drive', 'SanDisk Ultra'));
    expect(second.assessment.classification).toBe('duplicate');
    expect(state.games).toHaveLength(1);
  });
});

describe('the backup USB workflow', () => {
  it('prepares every game in the round even when every room is connected', async () => {
    const state = directorFixture({ games: 4 });
    state.qbtcpSessions = state.rooms.map((room, index) => ({
      roomId: room.id,
      sessionId: `session-${index}`,
      deviceId: `device-${index}`,
      state: 'live' as const,
      lastSeenAt: '2026-09-05T12:00:00.000Z',
      progress: null,
      helpRequestId: null,
    }));

    const fileSystem = new MemoryTransferFileSystem();
    fileSystem.addVolume(mount, { name: 'SanDisk Ultra', availableBytes: 4_000_000 });
    const report = await prepareAssignments(state, fileSystem, {
      basePath: mount,
      destinationLabel: 'SanDisk Ultra',
      selection: { kind: 'current-round' },
      directorBuild: 'test',
    });

    expect(report.written).toHaveLength(4);
    recordPreparedAssignments(state, {
      report,
      transportKind: 'removable-drive',
      destinationLabel: 'SanDisk Ultra',
    });
    expect(state.audit.some((event) => event.type === 'assignment-prepared')).toBe(true);
    // Every file is self-contained: reading one back off the drive gives a complete assignment.
    const first = JSON.parse(fileSystem.readSync(report.written[0].path) ?? '{}');
    expect(first.objects.filter((object: { type: string }) => object.type === 'Match')).toHaveLength(1);
    expect(first.objects.some((object: { type: string }) => object.type === 'ScoringRules')).toBe(true);
  });
});

describe('locations coming and going', () => {
  it('adopts a drive when it appears and keeps it when it is pulled', () => {
    const state = directorFixture();
    const appeared = syncRemovableVolumes(state, [
      { mountPoint: mount, name: 'SanDisk Ultra', removable: true, readOnly: false, availableBytes: 1000 },
      { mountPoint: '/', name: 'Macintosh HD', removable: false, readOnly: false },
    ]);
    expect(appeared.appeared).toHaveLength(1);
    expect(appeared.metadataChanged).toBe(false);
    expect(state.transfers.locations).toHaveLength(1);
    expect(state.transfers.locations[0]).toMatchObject({ label: 'SanDisk Ultra', connected: true });

    const updated = syncRemovableVolumes(state, [
      {
        mountPoint: mount,
        name: 'SanDisk Ultra Renamed',
        removable: true,
        readOnly: true,
        availableBytes: 2000,
      },
    ]);
    expect(updated.appeared).toHaveLength(0);
    expect(updated.disappeared).toHaveLength(0);
    expect(updated.metadataChanged).toBe(true);
    expect(state.transfers.locations[0]).toMatchObject({
      label: 'SanDisk Ultra Renamed',
      readOnly: true,
      availableBytes: 2000,
      connected: true,
    });

    const gone = syncRemovableVolumes(state, []);
    expect(gone.disappeared).toHaveLength(1);
    // Kept, marked disconnected. A director who walked the stick to a room has not stopped using it.
    expect(state.transfers.locations).toHaveLength(1);
    expect(state.transfers.locations[0].connected).toBe(false);

    const back = syncRemovableVolumes(state, [
      { mountPoint: mount, name: 'SanDisk Ultra', removable: true, readOnly: false },
    ]);
    expect(back.appeared).toHaveLength(1);
    expect(state.transfers.locations).toHaveLength(1);
    expect(state.transfers.locations[0].connected).toBe(true);
  });

  it('leaves a chosen folder alone when volume enumeration cannot see it', () => {
    const state = directorFixture();
    addTransferLocation(state, {
      kind: 'folder',
      label: 'Quiz Bowl Exchange',
      path: '/Users/td/Google Drive/Quiz Bowl Exchange',
    });
    // A network share or a cloud folder is not a volume; a poll that lists no volumes must not
    // conclude the director's folder has gone.
    syncRemovableVolumes(state, []);
    expect(state.transfers.locations[0].connected).toBe(true);
    expect(state.transfers.locations[0].watching).toBe(true);
    expect(state.transfers.locations[0].cloudProvider).toBe('Google Drive');
  });

  it('re-adopts the same folder rather than listing it twice', () => {
    const state = directorFixture();
    addTransferLocation(state, { kind: 'folder', label: 'Exchange', path: '/Users/td/Exchange' });
    addTransferLocation(state, { kind: 'folder', label: 'Exchange', path: '/Users/td/Exchange/' });
    expect(state.transfers.locations).toHaveLength(1);
  });
});

describe('a watched folder end to end', () => {
  it('picks up a result a sync client dropped into Results', async () => {
    const state = directorFixture();
    const folder = '/Users/td/Google Drive/Quiz Bowl Exchange';
    const fileSystem = new MemoryTransferFileSystem();
    fileSystem.addVolume(folder, { name: 'Quiz Bowl Exchange', removable: false });
    const location = addTransferLocation(state, {
      kind: 'folder',
      label: 'Quiz Bowl Exchange',
      path: folder,
    });

    const report = await prepareAssignments(state, fileSystem, {
      basePath: folder,
      destinationLabel: location.label,
      selection: { kind: 'current-round' },
      directorBuild: 'test',
    });
    expect(report.ok).toBe(true);

    // Somebody scores a game elsewhere and their sync client puts the file in Results.
    const written = JSON.parse(fileSystem.readSync(report.written[0].path) ?? '{}');
    fileSystem.putFile(
      joinPath(exchangePaths(folder).results, 'Room 101 result.qbj'),
      JSON.stringify(scoreAssignment(written)),
    );

    const collected = await collectFromLocation(fileSystem, folder, {
      sourceKind: 'folder',
      sourceLabel: location.label,
      includeAssignments: true,
    });
    const summary = importTransferDocuments(state, collected.inputs);

    // The two assignments Director itself wrote are recognised as assignments and not imported; the
    // one completed game is staged.
    expect(summary.imported).toBe(1);
    expect(summary.assignments).toBe(2);
    expect(state.submissions).toHaveLength(1);
  });
});

describe('restarting with staged transfer state', () => {
  it('survives a round trip through storage with its locations, artifacts and history intact', () => {
    const state = directorFixture();
    addTransferLocation(state, { kind: 'folder', label: 'Exchange', path: '/Users/td/Exchange' });
    const result = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    const input: ImportInput = {
      ok: true,
      document: documentFor(result, 'folder', 'Exchange', {
        originalPath: '/Users/td/Exchange/QBSheet/Results/a.qbj',
      }),
    };
    importTransferDocuments(state, [input]);

    // What the repository does on save and load.
    const reloaded: DirectorState = JSON.parse(JSON.stringify(state));
    reloaded.transfers = normalizeTransferState(reloaded.transfers);

    expect(reloaded.transfers.locations).toHaveLength(1);
    expect(reloaded.transfers.artifacts).toHaveLength(1);
    expect(reloaded.transfers.events.length).toBeGreaterThan(0);
    expect(reloaded.submissions).toHaveLength(1);

    // And the seen-file memory still works, so re-scanning the folder after a restart does not
    // stage the same result a second time.
    expect(importTransferDocuments(reloaded, [input]).skipped).toBe(1);
    expect(reloaded.submissions).toHaveLength(1);
  });

  it('repairs a document written before Transfers existed', () => {
    const legacy: Partial<DirectorState> = directorFixture();
    delete legacy.transfers;
    const repaired = normalizeTransferState(legacy.transfers);
    expect(repaired.locations).toEqual([]);
    expect(repaired.artifacts).toEqual([]);
    expect(repaired.version).toBe(1);
  });
});
