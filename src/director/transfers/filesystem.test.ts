/**
 * Removable media, and the ways it misbehaves.
 *
 * Every failure here is one that happens at real tournaments and none of them can be produced on
 * demand with a physical stick: the drive pulled during a scan, the drive that mounted read-only,
 * the drive that filled up on the ninth of twelve files, the folder that vanished because a sync
 * client was reorganising. `MemoryTransferFileSystem` exists so these are ordinary assertions
 * instead of a note in a manual test plan.
 *
 * The real atomicity of a write is asserted on the Rust side, against a real filesystem, in
 * `apps/director/src-tauri/src/transfers.rs`. What is checked here is that the layer above never
 * asks for a non-atomic one and copes when a write fails.
 */
import { describe, expect, it } from 'vitest';
import { looksLikeTransferVolume, scanTransferLocation } from './discover';
import { maxFilesPerDirectory } from './limits';
import { exchangePaths, joinPath } from './layout';
import { MemoryTransferFileSystem } from './ports';
import { initializeExchange, prepareAssignments } from './prepare';
import { collectFromLocation } from './service';
import { assignmentFor, directorFixture, scoreAssignment } from './testFixtures';

const mount = '/Volumes/SANDISK';

function driveWithResults(count = 2): MemoryTransferFileSystem {
  const fileSystem = new MemoryTransferFileSystem();
  fileSystem.addVolume(mount, { name: 'SanDisk Ultra', availableBytes: 4_000_000 });
  const state = directorFixture({ games: count });
  const paths = exchangePaths(mount);
  for (let index = 0; index < count; index += 1) {
    const assignment = assignmentFor(state, `game-5-${index + 1}`);
    const result = scoreAssignment(assignment.document);
    fileSystem.putFile(
      joinPath(paths.results, `Round 5 - Room ${101 + index} - result.qbj`),
      JSON.stringify(result),
    );
  }
  return fileSystem;
}

describe('drive discovery', () => {
  it('enumerates removable volumes through the abstraction the platform implements', async () => {
    const fileSystem = new MemoryTransferFileSystem();
    fileSystem.addVolume(mount, { name: 'SanDisk Ultra', removable: true });
    fileSystem.addVolume('/', { name: 'Macintosh HD', removable: false });
    const volumes = await fileSystem.listVolumes();
    expect(volumes.filter((volume) => volume.removable).map((volume) => volume.name)).toEqual([
      'SanDisk Ultra',
    ]);
  });

  it('recognises a drive with QBSheet data and stays silent about one without', async () => {
    const withData = driveWithResults(2);
    expect(await looksLikeTransferVolume(withData, mount)).toMatchObject({
      recognized: true,
      resultCount: 2,
    });

    const stranger = new MemoryTransferFileSystem();
    stranger.addVolume(mount, { name: 'Holiday photos' });
    stranger.putFile(`${mount}/DCIM/IMG_0001.JPG`, 'binary');
    stranger.putFile(`${mount}/taxes.pdf`, 'binary');
    expect(await looksLikeTransferVolume(stranger, mount)).toMatchObject({ recognized: false });
  });

  it('does not crawl a stranger drive beyond the places a QBSheet file would be', async () => {
    const fileSystem = new MemoryTransferFileSystem();
    fileSystem.addVolume(mount, { name: 'SanDisk Ultra' });
    fileSystem.putFile(`${mount}/QBSheet/Results/room-101.qbj`, '{}');
    fileSystem.putFile(`${mount}/Documents/Personal/notes/private.qbj`, '{}');
    fileSystem.putFile(`${mount}/loose-result.qbj`, '{}');

    const report = await scanTransferLocation(fileSystem, mount, { includeRoot: true });
    const paths = report.candidates.map((candidate) => candidate.path);
    expect(paths).toContain(`${mount}/QBSheet/Results/room-101.qbj`);
    // The root is looked at, shallowly, because "put it on the stick" is what a scorekeeper heard.
    expect(paths).toContain(`${mount}/loose-result.qbj`);
    // Their own folders are not.
    expect(paths).not.toContain(`${mount}/Documents/Personal/notes/private.qbj`);
  });

  it('reports a link instead of following it', async () => {
    const fileSystem = new MemoryTransferFileSystem();
    fileSystem.addVolume(mount, { name: 'SanDisk Ultra' });
    fileSystem.putSymlink(`${mount}/QBSheet/Results/elsewhere.qbj`, '{}');
    fileSystem.putFile(`${mount}/QBSheet/Results/real.qbj`, '{}');
    const report = await scanTransferLocation(fileSystem, mount);
    expect(report.candidates.map((candidate) => candidate.fileName)).toEqual(['real.qbj']);
    expect(report.skipped.some((skip) => skip.reason === 'Links are not followed.')).toBe(true);
  });

  it('bounds an absurd directory rather than reading all of it', async () => {
    const fileSystem = new MemoryTransferFileSystem();
    fileSystem.addVolume(mount, { name: 'SanDisk Ultra' });
    for (let index = 0; index < maxFilesPerDirectory + 50; index += 1)
      fileSystem.putFile(`${mount}/QBSheet/Results/result-${index}.qbj`, '{}');
    const report = await scanTransferLocation(fileSystem, mount, { limit: 1000 });
    expect(report.candidates.length).toBeLessThanOrEqual(maxFilesPerDirectory);
    expect(report.skipped.some((skip) => skip.reason.includes('first'))).toBe(true);
  });

  it('skips a file too large to be a QBJ document instead of reading it', async () => {
    const fileSystem = new MemoryTransferFileSystem();
    fileSystem.addVolume(mount, { name: 'SanDisk Ultra' });
    fileSystem.putFile(`${mount}/QBSheet/Results/movie.qbj`, 'x'.repeat(9 * 1024 * 1024));
    const report = await scanTransferLocation(fileSystem, mount);
    expect(report.candidates).toEqual([]);
    expect(report.skipped[0].reason).toContain('too large');
  });
});

describe('media that goes away', () => {
  it('reports a drive pulled mid-scan without throwing, and keeps what it already had', async () => {
    const fileSystem = driveWithResults(2);
    // The listing succeeds, then the drive is gone before the files are read — the worst ordering,
    // because Director has already told the director there are two results waiting.
    const report = await scanTransferLocation(fileSystem, mount);
    expect(report.candidates).toHaveLength(2);
    report.candidates.forEach((candidate) => fileSystem.failing.add(candidate.path));

    const collected = await collectFromLocation(fileSystem, mount, {
      sourceKind: 'removable-drive',
      sourceLabel: 'SanDisk Ultra',
    });
    // Every file is accounted for, each with a reason, and nothing threw.
    expect(collected.inputs.every((input) => !input.ok)).toBe(true);
    expect(collected.inputs[0].ok === false && collected.inputs[0].reason).toContain('no longer available');
  });

  it('turns a location that has vanished into an error on the report, not an exception', async () => {
    const fileSystem = driveWithResults(1);
    fileSystem.failing.add(mount);
    const report = await scanTransferLocation(fileSystem, mount);
    expect(report.error).toBeTruthy();
    expect(report.candidates).toEqual([]);
  });
});

describe('writing assignments', () => {
  it('writes the layout, the files, the README and the manifest', async () => {
    const state = directorFixture({ games: 2 });
    const fileSystem = new MemoryTransferFileSystem();
    fileSystem.addVolume(mount, { name: 'SanDisk Ultra', availableBytes: 4_000_000 });

    const report = await prepareAssignments(state, fileSystem, {
      basePath: mount,
      destinationLabel: 'SanDisk Ultra',
      selection: { kind: 'current-round' },
      directorBuild: 'test',
    });

    expect(report.ok).toBe(true);
    expect(report.written).toHaveLength(2);
    expect(report.message).toContain('2 assignments prepared.');
    // The exact wording matters: Director has not performed an OS-level eject and must not imply it.
    expect(report.message).toContain('Eject the drive normally before removing it.');
    expect(report.message).not.toContain('safe to remove');

    const paths = exchangePaths(mount);
    expect(fileSystem.readSync(paths.readme)).toContain('QBSheet tournament files');
    const manifest = JSON.parse(fileSystem.readSync(paths.manifest) ?? '{}');
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.assignments).toHaveLength(2);
    expect(
      fileSystem.readSync(
        joinPath(paths.assignments, 'Round 5 - Room 101 - Ninety Six A vs Greenwood A.qbj'),
      ),
    ).toContain('"game-5-1"');
  });

  it('leaves a read-only drive untouched and says so', async () => {
    const state = directorFixture();
    const fileSystem = new MemoryTransferFileSystem();
    fileSystem.addVolume(mount, { name: 'SanDisk Ultra', readOnly: true, availableBytes: 4_000_000 });
    const report = await prepareAssignments(state, fileSystem, {
      basePath: mount,
      destinationLabel: 'SanDisk Ultra',
      selection: { kind: 'current-round' },
      directorBuild: 'test',
    });
    expect(report.ok).toBe(false);
    expect(report.error).toContain('read-only');
    expect(fileSystem.allPaths()).toEqual([]);
  });

  it('refuses before writing when the drive has no room', async () => {
    const state = directorFixture({ games: 4 });
    const fileSystem = new MemoryTransferFileSystem();
    fileSystem.addVolume(mount, { name: 'Tiny drive', availableBytes: 512 });
    const report = await prepareAssignments(state, fileSystem, {
      basePath: mount,
      destinationLabel: 'Tiny drive',
      selection: { kind: 'current-round' },
      directorBuild: 'test',
    });
    expect(report.ok).toBe(false);
    expect(report.message).toContain('full');
    // Nothing half-written is left behind for a scan to find later.
    expect(fileSystem.allPaths()).toEqual([]);
  });

  it('keeps the files it could write when the drive fills up partway through', async () => {
    const state = directorFixture({ games: 4 });
    const fileSystem = new MemoryTransferFileSystem();
    // The drive reports plenty of room and then runs out anyway, which is what happens when
    // something else is filling the same volume. The precheck passes and the ninth write fails.
    fileSystem.addVolume(mount, { name: 'SanDisk Ultra', availableBytes: 4_000_000 });
    fileSystem.setWriteBudget(mount, 6_000);
    const report = await prepareAssignments(state, fileSystem, {
      basePath: mount,
      destinationLabel: 'SanDisk Ultra',
      selection: { kind: 'current-round' },
      directorBuild: 'test',
    });
    expect(report.written.length).toBeGreaterThan(0);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.message).toContain('could not be written');
    // Partial success is reported as partial success. Each written file is complete.
    report.written.forEach((written) =>
      expect(fileSystem.readSync(written.path)).toContain('"version": "2.1.1"'),
    );
  });

  it('writes an exchange folder that is usable before any round exists', async () => {
    const fileSystem = new MemoryTransferFileSystem();
    fileSystem.addVolume('/Users/td/Quiz Bowl Exchange', {
      name: 'Quiz Bowl Exchange',
      removable: false,
    });
    const outcome = await initializeExchange(
      fileSystem,
      '/Users/td/Quiz Bowl Exchange',
      'Saturday Invitational',
    );
    expect(outcome.ok).toBe(true);
    expect(await fileSystem.exists('/Users/td/Quiz Bowl Exchange/QBSheet/Results')).toBe(true);
  });
});

describe('a drive with no manifest', () => {
  it('is read exactly as well as one with a manifest', async () => {
    const fileSystem = driveWithResults(2);
    const withManifest = await scanTransferLocation(fileSystem, mount);
    expect(withManifest.manifest).toBeUndefined();
    expect(withManifest.candidates).toHaveLength(2);

    // Adding a manifest changes recognition specificity and nothing about what is importable.
    fileSystem.putFile(
      exchangePaths(mount).manifest,
      JSON.stringify({ manifestVersion: 1, tournamentId: 'tournament-fixture', assignments: [] }),
    );
    const after = await scanTransferLocation(fileSystem, mount);
    expect(after.manifest?.tournamentId).toBe('tournament-fixture');
    expect(after.candidates).toHaveLength(2);
  });

  it('ignores a manifest that a sync client truncated mid-write', async () => {
    const fileSystem = driveWithResults(1);
    fileSystem.putFile(exchangePaths(mount).manifest, '{"manifestVersion": 1, "tournam');
    const report = await scanTransferLocation(fileSystem, mount);
    expect(report.manifest).toBeUndefined();
    expect(report.candidates).toHaveLength(1);
  });
});
