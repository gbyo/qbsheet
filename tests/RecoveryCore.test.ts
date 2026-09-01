import { describe, expect, test, vi } from 'vitest';
import { validPackage } from './packages';
import { createQbsheetBackup, readQbsheetBackup } from '../src/scorer/QBSheetBackup';
import {
  CoalescingExternalBackupWriter,
  CoalescingCheckpointWriter,
  ExternalBackupTarget,
  IExternalBackupEnvironment,
  IRecoveryDirectoryHandle,
  IRecoveryFileHandle,
  MemoryRecoveryStore,
  RecoveryController,
  chooseCollisionSafeQbsheetFileName,
  chooseQbsheetBackupFileName,
  computeRecoveryFingerprint,
  defaultRecoveryCheckpointLimits,
  externalBackupSupported,
  fingerprintRecoveryCore,
  inspectCheckpoints,
  latestValidRecoveryCheckpoint,
  openRecoveryStore,
  recoverySettings,
  retainRecoveryCheckpoints,
  selectRecoveryCandidate,
} from '../src/recovery';
import { IGameSetup } from '../src/scoring/deriveGame';
import { IRecoveryCheckpoint, IRecoveryWritableFile } from '../src/recovery/RecoveryTypes';

const gamePackage = validPackage({ producer: 'QBSheet' });
const setup: IGameSetup = {
  left: {
    name: gamePackage.left.name,
    players: gamePackage.left.players.map((player) => player.name),
  },
  right: {
    name: gamePackage.right.name,
    players: gamePackage.right.players.map((player) => player.name),
  },
};
const backup = createQbsheetBackup({ gamePackage, setup, events: [] });

function checkpoint(
  id: string,
  capturedAt: string,
  options: Partial<IRecoveryCheckpoint> = {},
): IRecoveryCheckpoint {
  return {
    id,
    gameKey: 'game-1',
    capturedAt,
    serializedBackup: JSON.stringify(backup),
    kind: 'rolling',
    ...options,
  };
}

class FakeFile implements IRecoveryFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  contents = '';
  createCount = 0;
  failWrites = false;

  constructor(name: string) {
    this.name = name;
  }

  createWritable(): Promise<IRecoveryWritableFile> {
    this.createCount += 1;
    const writable: IRecoveryWritableFile = {
      write: async (data) => {
        if (this.failWrites) throw new Error('disk full');
        this.contents = data;
      },
      close: async () => undefined,
      abort: async () => undefined,
    };
    return Promise.resolve(writable);
  }
}

class FakeDirectory implements IRecoveryDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name = 'QBSheet Backups';
  permission: PermissionState = 'granted';
  queryCount = 0;
  requestCount = 0;
  readonly files = new Map<string, FakeFile>();

  async queryPermission(): Promise<PermissionState> {
    this.queryCount += 1;
    return this.permission;
  }

  async requestPermission(): Promise<PermissionState> {
    this.requestCount += 1;
    return this.permission;
  }

  async getFileHandle(name: string): Promise<FakeFile> {
    const existing = this.files.get(name);
    if (existing) return existing;
    const created = new FakeFile(name);
    this.files.set(name, created);
    return created;
  }
}

describe('recovery IndexedDB store', () => {
  test('uses the native store when IndexedDB is available and keeps bounded checkpoints', async () => {
    const store = await openRecoveryStore({ databaseName: `qbsheet-recovery-${crypto.randomUUID()}` });
    expect(store.durable).toBe(true);

    const serializableHandle = { name: 'Backups' } as IRecoveryDirectoryHandle;
    const settings = recoverySettings(serializableHandle, new Date('2026-09-01T10:00:00.000Z'));
    expect(await store.putSettings(settings)).toBe(true);
    expect(await store.getSettings()).toEqual(settings);

    for (let index = 0; index < defaultRecoveryCheckpointLimits.maxRolling + 2; index += 1) {
      expect(
        await store.saveCheckpoint(
          checkpoint(`rolling-${index}`, `2026-09-01T10:${String(index).padStart(2, '0')}:00.000Z`),
        ),
      ).toBe(true);
    }
    const retained = await store.listCheckpoints('game-1');
    expect(retained).toHaveLength(defaultRecoveryCheckpointLimits.maxRolling);
    expect(retained.map((entry) => entry.id)).toEqual([
      'rolling-2',
      'rolling-3',
      'rolling-4',
      'rolling-5',
      'rolling-6',
      'rolling-7',
      'rolling-8',
      'rolling-9',
    ]);
  });

  test('falls back to an honest in-memory store when IndexedDB is unavailable', async () => {
    const store = await openRecoveryStore({ indexedDB: null });
    expect(store.durable).toBe(false);
    expect(await store.putSettings(recoverySettings({ name: 'tab-only' } as IRecoveryDirectoryHandle))).toBe(
      false,
    );
    expect((await store.getSettings())?.directoryHandle.name).toBe('tab-only');
    expect(await store.saveCheckpoint(checkpoint('one', '2026-09-01T10:00:00.000Z'))).toBe(false);
    expect(await store.listCheckpoints('game-1')).toHaveLength(1);
  });

  test('configuration removal clears metadata but has no file deletion capability', async () => {
    const store = new MemoryRecoveryStore();
    await store.putSettings(recoverySettings({ name: 'Backups' } as IRecoveryDirectoryHandle));
    await store.putFilenameMapping({
      id: 'game-1',
      gameKey: 'game-1',
      fileName: 'game.qbsheet',
      baseFileName: 'game.qbsheet',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
    });
    expect(await store.clearExternalConfiguration()).toBe(false);
    expect(await store.getSettings()).toBeNull();
    expect(await store.listFilenameMappings()).toEqual([]);
  });
});

describe('recovery canonicalization and fingerprints', () => {
  test('same setup/events have the same SHA-256 fingerprint', async () => {
    const webCrypto =
      (globalThis.crypto as unknown as {
        subtle: { digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer> };
      }) ?? null;
    const first = await fingerprintRecoveryCore(setup, [], webCrypto);
    const second = await fingerprintRecoveryCore({ ...setup }, [], webCrypto);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  test('event corrections and order change the fingerprint even with the same event count', async () => {
    const webCrypto =
      (globalThis.crypto as unknown as {
        subtle: { digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer> };
      }) ?? null;
    const firstEvent = { id: 'event-1', type: 'tossup-dead' as const, questionNumber: 1 };
    const secondEvent = { id: 'event-2', type: 'tossup-readout' as const, questionNumber: 2 };
    const corrected = { ...firstEvent, type: 'tossup-readout' as const };
    const original = await fingerprintRecoveryCore(setup, [firstEvent, secondEvent], webCrypto);
    const correction = await fingerprintRecoveryCore(setup, [corrected, secondEvent], webCrypto);
    const reordered = await fingerprintRecoveryCore(setup, [secondEvent, firstEvent], webCrypto);
    expect(correction).not.toBe(original);
    expect(reordered).not.toBe(original);
  });

  test('runtime and credential-like fields cannot affect the canonical input', async () => {
    const webCrypto =
      (globalThis.crypto as unknown as {
        subtle: { digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer> };
      }) ?? null;
    const event = { id: 'event-1', type: 'tossup-dead' as const, questionNumber: 1 };
    const unsafeSetup = {
      ...setup,
      sessionToken: 'do-not-fingerprint',
      left: { ...setup.left, browserDeviceId: 'browser-id' },
    } as IGameSetup & Record<string, unknown>;
    const unsafeEvent = { ...event, authorization: 'Bearer secret', deviceId: 'device-id' } as typeof event;
    expect(await fingerprintRecoveryCore(setup, [event], webCrypto)).toBe(
      await fingerprintRecoveryCore(unsafeSetup, [unsafeEvent], webCrypto),
    );
  });

  test('Web Crypto unavailability is reported without rejecting recovery', async () => {
    await expect(fingerprintRecoveryCore(setup, [], null)).resolves.toBeNull();
    await expect(computeRecoveryFingerprint(setup, [], null)).resolves.toEqual({
      algorithm: 'sha256-core-v1',
      available: false,
    });
  });
});

describe('collision-safe QBSheet filenames', () => {
  test('keeps one familiar name, then deterministically separates another local attempt', () => {
    const first = chooseQbsheetBackupFileName(gamePackage, 'attempt-one', []);
    const second = chooseQbsheetBackupFileName(gamePackage, 'attempt-two', [
      { gameKey: 'attempt-one', fileName: first },
    ]);
    const again = chooseQbsheetBackupFileName(gamePackage, 'attempt-two', [
      { gameKey: 'attempt-one', fileName: first },
      { gameKey: 'attempt-two', fileName: second },
    ]);
    expect(first).toMatch(/\.qbsheet$/u);
    expect(second).toMatch(/\.qbsheet$/u);
    expect(second).not.toBe(first);
    expect(again).toBe(second);
    expect(second).not.toContain('attempt-two');
  });

  test('handles an already occupied derived name and rejects unsafe base names', () => {
    const base = 'R01_A_vs_B.qbsheet';
    const first = chooseCollisionSafeQbsheetFileName(base, 'one', [{ gameKey: 'other', fileName: base }]);
    const second = chooseCollisionSafeQbsheetFileName(base, 'two', [
      { gameKey: 'other', fileName: base },
      { gameKey: 'one', fileName: first },
    ]);
    expect(first).not.toBe(second);
    expect(chooseCollisionSafeQbsheetFileName('../private/token', 'one', [])).toMatch(
      /^[\p{L}\p{N}._-]+\.qbsheet$/u,
    );
  });
});

describe('coalescing external writes', () => {
  test('coalesces rapid revisions and ignores an older revision arriving late', async () => {
    const file = new FakeFile('game.qbsheet');
    const writer = new CoalescingExternalBackupWriter({ debounceMs: 0 });
    const first = writer.enqueue('game', file, 'old', 1);
    const second = writer.enqueue('game', file, 'newer', 2);
    const late = writer.enqueue('game', file, 'stale', 1);
    await writer.flush();
    await expect(first).resolves.toMatchObject({ state: 'superseded', revision: 1 });
    await expect(second).resolves.toMatchObject({ state: 'saved', revision: 2 });
    await expect(late).resolves.toMatchObject({ state: 'superseded', revision: 1 });
    expect(file.createCount).toBe(1);
    expect(file.contents).toBe('newer');
  });

  test('never overlaps a delayed old write with the newer pending state', async () => {
    const file = new FakeFile('game.qbsheet');
    let releaseOld!: () => void;
    let oldStarted!: () => void;
    const oldHasStarted = new Promise<void>((resolve) => {
      oldStarted = resolve;
    });
    const handle: IRecoveryFileHandle = {
      createWritable: async () => ({
        write: async (data) => {
          if (data === 'old') {
            oldStarted();
            await new Promise<void>((resolve) => {
              releaseOld = resolve;
            });
          }
          file.contents = data;
        },
        close: async () => undefined,
      }),
    };
    const writer = new CoalescingExternalBackupWriter({ debounceMs: 0 });
    const old = writer.enqueue('game', handle, 'old', 1);
    await oldHasStarted;
    const newer = writer.enqueue('game', handle, 'newer', 2);
    releaseOld();
    await writer.flush();
    await expect(old).resolves.toMatchObject({ state: 'saved' });
    await expect(newer).resolves.toMatchObject({ state: 'saved' });
    expect(file.contents).toBe('newer');
  });

  test('resolves write failures as non-fatal results', async () => {
    const file = new FakeFile('game.qbsheet');
    file.failWrites = true;
    const writer = new CoalescingExternalBackupWriter({ debounceMs: 0 });
    const result = writer.enqueue('game', file, 'state', 1);
    await writer.flush();
    await expect(result).resolves.toMatchObject({ state: 'failed', revision: 1 });
  });
});

describe('coalescing checkpoint writes', () => {
  test('keeps only the newest pending exact snapshot for a game', async () => {
    const writes: string[] = [];
    const writer = new CoalescingCheckpointWriter(
      async (input) => {
        writes.push(input.id);
        return true;
      },
      { debounceMs: 0 },
    );
    const oldInput = {
      id: 'old',
      gameKey: 'game-1',
      capturedAt: '2026-09-01T10:00:00.000Z',
      backup,
    };
    const newInput = { ...oldInput, id: 'new', capturedAt: '2026-09-01T10:01:00.000Z' };
    const old = writer.enqueue('game-1', oldInput, 1);
    const newer = writer.enqueue('game-1', newInput, 2);
    await writer.flush();
    await expect(old).resolves.toBe(false);
    await expect(newer).resolves.toBe(true);
    expect(writes).toEqual(['new']);
  });
});

describe('checkpoint retention and source ranking', () => {
  test('retains anchors while bounding rolling checkpoints', () => {
    const all = [
      checkpoint('start', '2026-09-01T09:00:00.000Z', { kind: 'anchor', anchorKey: 'game-start' }),
      checkpoint('break', '2026-09-01T09:30:00.000Z', { kind: 'anchor', anchorKey: 'halftime:1' }),
      ...Array.from({ length: 10 }, (_, index) =>
        checkpoint(`rolling-${index}`, `2026-09-01T10:${String(index).padStart(2, '0')}:00.000Z`),
      ),
    ];
    const retained = retainRecoveryCheckpoints(all, { maxRolling: 3, maxAnchors: 8 });
    expect(retained.map((entry) => entry.id)).toEqual([
      'start',
      'break',
      'rolling-7',
      'rolling-8',
      'rolling-9',
    ]);
  });

  test('a corrupt newest checkpoint falls back to the newest valid older checkpoint', () => {
    const valid = checkpoint('valid', '2026-09-01T10:00:00.000Z');
    const corrupt = checkpoint('corrupt', '2026-09-01T10:01:00.000Z', {
      serializedBackup: '{not-json',
    });
    expect(latestValidRecoveryCheckpoint([valid, corrupt])?.checkpoint.id).toBe('valid');
    expect(inspectCheckpoints([valid, corrupt]).map((entry) => entry.valid)).toEqual([false, true]);
  });

  test('a valid journal wins over every async or server source, and server is blocked after local scoring starts', () => {
    const journal = {
      source: 'journal' as const,
      value: 'journal',
      valid: true,
      exact: true,
      capturedAt: '2026-09-01T09:00:00Z',
    };
    const server = {
      source: 'server' as const,
      value: 'server',
      valid: true,
      exact: true,
      capturedAt: '2026-09-01T11:00:00Z',
    };
    const checkpointCandidate = {
      source: 'checkpoint' as const,
      value: 'checkpoint',
      valid: true,
      exact: true,
      capturedAt: '2026-09-01T10:00:00Z',
    };
    expect(selectRecoveryCandidate([server, checkpointCandidate, journal])?.value).toBe('journal');
    expect(selectRecoveryCandidate([server, checkpointCandidate], { localScoringStarted: true })?.value).toBe(
      'checkpoint',
    );
  });
});

describe('external backup target and controller', () => {
  test('status and setup never request permission automatically', async () => {
    const directory = new FakeDirectory();
    const picker = vi.fn(async () => directory);
    const environment: IExternalBackupEnvironment = { showDirectoryPicker: picker };
    const store = new MemoryRecoveryStore();
    const target = new ExternalBackupTarget(store, environment);
    expect(externalBackupSupported(environment)).toBe(true);
    expect((await target.status()).state).toBe('not-configured');
    expect(picker).not.toHaveBeenCalled();
    expect(directory.requestCount).toBe(0);
    await target.setupFromUserGesture();
    expect(picker).toHaveBeenCalledTimes(1);
    expect(directory.requestCount).toBe(0);
    expect((await target.status()).state).toBe('ready');
  });

  test('permission prompt is quiet until explicit reconnect', async () => {
    const directory = new FakeDirectory();
    const store = new MemoryRecoveryStore();
    const target = new ExternalBackupTarget(store, { showDirectoryPicker: async () => directory });
    await target.setupFromUserGesture();
    directory.permission = 'prompt';
    expect((await target.status()).state).toBe('needs-permission');
    expect(directory.requestCount).toBe(0);
    directory.permission = 'granted';
    expect((await target.reconnectFromUserGesture()).ok).toBe(true);
    expect(directory.requestCount).toBe(1);
  });

  test('writes valid normal .qbsheet content, keeps one file per game, and reports failures', async () => {
    const directory = new FakeDirectory();
    const store = new MemoryRecoveryStore();
    const controller = new RecoveryController(store, {
      externalEnvironment: { showDirectoryPicker: async () => directory },
      webCrypto: null,
    });
    await controller.setupExternalBackup();
    const first = await controller.writeExternalBackup({
      gameKey: 'game-one',
      gamePackage,
      backup,
      revision: 1,
    });
    const second = await controller.writeExternalBackup({
      gameKey: 'game-one',
      gamePackage,
      backup,
      revision: 2,
    });
    expect(first.ok && second.ok).toBe(true);
    await controller.flushExternalBackup();
    await first.completion;
    await second.completion;
    expect(directory.files).toHaveLength(1);
    const written = JSON.parse([...directory.files.values()][0].contents) as unknown;
    expect(readQbsheetBackup(written).ok).toBe(true);
    expect(JSON.stringify(written)).not.toMatch(/token|authorization|device|session/i);

    const file = [...directory.files.values()][0];
    file.failWrites = true;
    const failed = await controller.writeExternalBackup({
      gameKey: 'game-one',
      gamePackage,
      backup,
      revision: 3,
    });
    await controller.flushExternalBackup();
    await expect(failed.completion).resolves.toMatchObject({ state: 'failed' });
    await Promise.resolve();
    expect((await controller.status()).externalBackup.state).toBe('backup-failed');
  });

  test('two local game keys get collision-safe files and cancel is honest', async () => {
    const directory = new FakeDirectory();
    const picker = vi.fn(async () => {
      const error = new DOMException('cancelled', 'AbortError');
      throw error;
    });
    const cancelled = new ExternalBackupTarget(new MemoryRecoveryStore(), { showDirectoryPicker: picker });
    const result = await cancelled.setupFromUserGesture();
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.status.state).toBe('not-configured');

    const store = new MemoryRecoveryStore();
    const target = new ExternalBackupTarget(store, { showDirectoryPicker: async () => directory });
    await target.setupFromUserGesture();
    const one = await target.enqueueBackup({ gameKey: 'one', gamePackage, backup, revision: 1 });
    const two = await target.enqueueBackup({ gameKey: 'two', gamePackage, backup, revision: 1 });
    await target.flush();
    await one.completion;
    await two.completion;
    expect(directory.files).toHaveLength(2);
  });

  test('controller schedules checkpoint and external work independently', async () => {
    const directory = new FakeDirectory();
    const controller = await RecoveryController.open({
      storeEnvironment: { indexedDB: null },
      externalEnvironment: { showDirectoryPicker: async () => directory },
      webCrypto: null,
    });
    await controller.setupExternalBackup();
    const scheduled = controller.scheduleSnapshot({
      gameKey: 'game-1',
      gamePackage,
      backup,
      revision: 1,
      checkpoint: {
        id: 'checkpoint-1',
        capturedAt: '2026-09-01T10:00:00.000Z',
        kind: 'anchor',
        anchorKey: 'game-start',
      },
    });
    expect(await scheduled.checkpoint).toBe(false);
    const external = await scheduled.externalBackup;
    expect(external.ok).toBe(true);
    await controller.flushExternalBackup();
    await external.completion;
    expect(await controller.listCheckpoints('game-1')).toHaveLength(1);
  });
});
