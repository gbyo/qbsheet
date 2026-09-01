import { IGamePackage } from '../game/GamePackage';
import { IQbsheetBackup, serializeQbsheetBackup } from '../scorer/QBSheetBackup';
import { chooseQbsheetBackupFileName, RecoveryFilenameMappings } from './RecoveryFilenames';
import {
  CoalescingExternalBackupWriter,
  ExternalWriteState,
  IExternalWriteResult,
} from './ExternalBackupWriter';
import { recoverySettings, IRecoveryStore } from './RecoveryStore';
import {
  IRecoveryDirectoryHandle,
  IRecoveryFileHandle,
  IRecoveryFilenameMapping,
  IRecoverySettings,
} from './RecoveryTypes';

export type ExternalBackupStatusState =
  'unsupported' | 'not-configured' | 'ready' | 'needs-permission' | 'folder-unavailable' | 'backup-failed';

export interface IExternalBackupStatus {
  state: ExternalBackupStatusState;
  supported: boolean;
  configured: boolean;
  directoryName?: string;
  lastSuccessfulWriteAt?: string;
  lastFailureAt?: string;
  lastFailure?: string;
  /** The handle/settings still survive only for this tab when the recovery DB is not durable. */
  metadataDurable: boolean;
}

export interface IExternalBackupEnvironment {
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<IRecoveryDirectoryHandle>;
  now?: () => Date;
}

export interface IExternalBackupConfigureResult {
  ok: boolean;
  status: IExternalBackupStatus;
  cancelled?: boolean;
}

export interface IExternalBackupRequest {
  gameKey: string;
  gamePackage: IGamePackage;
  backup: IQbsheetBackup;
  /** Monotonic scorer state revision. Omit only when call order itself is the freshness signal. */
  revision?: number;
}

export interface IExternalBackupEnqueueResult {
  ok: boolean;
  status: ExternalBackupStatusState;
  filename?: string;
  /** Completion is separate so scoring code can intentionally ignore filesystem latency. */
  completion?: Promise<IExternalWriteResult>;
}

function defaultEnvironment(): IExternalBackupEnvironment {
  try {
    if (typeof window === 'undefined') return {};
    const candidate = window as Window & {
      showDirectoryPicker?: IExternalBackupEnvironment['showDirectoryPicker'];
    };
    return {
      ...(typeof candidate.showDirectoryPicker === 'function'
        ? { showDirectoryPicker: candidate.showDirectoryPicker.bind(candidate) }
        : {}),
    };
  } catch {
    return {};
  }
}

export function externalBackupSupported(
  environment: IExternalBackupEnvironment = defaultEnvironment(),
): boolean {
  return typeof environment.showDirectoryPicker === 'function';
}

function nowIso(now: () => Date): string {
  try {
    return now().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function isPermissionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    ['NotAllowedError', 'SecurityError'].includes(String((error as { name?: unknown }).name))
  );
}

function safeFailureText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message.slice(0, 240);
  return fallback;
}

type PermissionCheck = 'granted' | 'prompt' | 'denied' | 'unavailable';

async function queryPermission(handle: IRecoveryDirectoryHandle): Promise<PermissionCheck> {
  if (!handle.queryPermission) return 'granted';
  try {
    const state = await handle.queryPermission({ mode: 'readwrite' });
    return state === 'granted' || state === 'prompt' || state === 'denied' ? state : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function statusFromSettings(
  settings: IRecoverySettings | null,
  state: ExternalBackupStatusState,
  supported: boolean,
  durable: boolean,
): IExternalBackupStatus {
  return {
    state,
    supported,
    configured: settings !== null,
    ...(settings?.directoryHandle.name ? { directoryName: settings.directoryHandle.name } : {}),
    ...(settings?.lastSuccessfulWriteAt ? { lastSuccessfulWriteAt: settings.lastSuccessfulWriteAt } : {}),
    ...(settings?.lastFailureAt ? { lastFailureAt: settings.lastFailureAt } : {}),
    ...(settings?.lastFailure ? { lastFailure: settings.lastFailure } : {}),
    metadataDurable: durable,
  };
}

/**
 * File System Access orchestration without startup prompts.
 *
 * `setupFromUserGesture` is the only method that opens the initial picker. `reconnectFromUserGesture`
 * is the only method that requests permission. `status` merely queries an already stored handle.
 */
export class ExternalBackupTarget {
  private settings: IRecoverySettings | null | undefined;
  private mappingTail: Promise<void> = Promise.resolve();
  private readonly environment: IExternalBackupEnvironment;
  private readonly now: () => Date;
  readonly writer: CoalescingExternalBackupWriter;

  constructor(
    private readonly store: IRecoveryStore,
    environment: IExternalBackupEnvironment = defaultEnvironment(),
    writer?: CoalescingExternalBackupWriter,
  ) {
    this.environment = environment;
    this.now = environment.now ?? (() => new Date());
    this.writer =
      writer ??
      new CoalescingExternalBackupWriter({
        now: this.now,
        onResult: (result) => {
          void this.recordWriteResult(result);
        },
      });
  }

  private async loadSettings(): Promise<IRecoverySettings | null> {
    if (this.settings !== undefined) return this.settings;
    try {
      this.settings = await this.store.getSettings();
    } catch {
      this.settings = null;
    }
    return this.settings;
  }

  private async setSettings(settings: IRecoverySettings | null): Promise<void> {
    this.settings = settings;
  }

  async status(): Promise<IExternalBackupStatus> {
    const supported = externalBackupSupported(this.environment);
    const settings = await this.loadSettings();
    if (!supported) return statusFromSettings(settings, 'unsupported', false, this.store.durable);
    if (!settings) return statusFromSettings(null, 'not-configured', true, this.store.durable);

    const permission = await queryPermission(settings.directoryHandle);
    if (permission === 'prompt' || permission === 'denied') {
      return statusFromSettings(settings, 'needs-permission', true, this.store.durable);
    }
    if (permission === 'unavailable') {
      return statusFromSettings(settings, 'folder-unavailable', true, this.store.durable);
    }
    return statusFromSettings(
      settings,
      settings.lastFailure ? 'backup-failed' : 'ready',
      true,
      this.store.durable,
    );
  }

  async getStatus(): Promise<IExternalBackupStatus> {
    return this.status();
  }

  /** Must be called from a user gesture; no caller should invoke it automatically on startup. */
  async setupFromUserGesture(): Promise<IExternalBackupConfigureResult> {
    if (!externalBackupSupported(this.environment)) {
      return { ok: false, status: await this.status() };
    }
    let handle: IRecoveryDirectoryHandle;
    try {
      handle = await this.environment.showDirectoryPicker!({ mode: 'readwrite' });
    } catch (error) {
      const settings = await this.loadSettings();
      return {
        ok: false,
        cancelled: isAbortError(error),
        status: isAbortError(error)
          ? await this.status()
          : statusFromSettings(settings, 'folder-unavailable', true, this.store.durable),
      };
    }
    const settings = recoverySettings(handle, this.now());
    await this.setSettings(settings);
    try {
      await this.store.putSettings(settings);
    } catch {
      // The target remains usable for this tab; `metadataDurable` makes the limitation visible.
    }
    return { ok: true, status: await this.status() };
  }

  /** Must be called from a user gesture; it never runs during `status()` or construction. */
  async reconnectFromUserGesture(): Promise<IExternalBackupConfigureResult> {
    const supported = externalBackupSupported(this.environment);
    const settings = await this.loadSettings();
    if (!supported)
      return { ok: false, status: statusFromSettings(settings, 'unsupported', false, this.store.durable) };
    if (!settings)
      return { ok: false, status: statusFromSettings(null, 'not-configured', true, this.store.durable) };
    if (!settings.directoryHandle.requestPermission) return { ok: false, status: await this.status() };
    try {
      const permission = await settings.directoryHandle.requestPermission({ mode: 'readwrite' });
      if (permission !== 'granted') return { ok: false, status: await this.status() };
      const next = { ...settings, lastFailure: undefined, lastFailureAt: undefined };
      await this.setSettings(next);
      try {
        await this.store.putSettings(next);
      } catch {
        // A successful browser permission is still useful in this tab if the metadata store is down.
      }
      return { ok: true, status: await this.status() };
    } catch (error) {
      return {
        ok: false,
        status: statusFromSettings(
          settings,
          isPermissionError(error) ? 'needs-permission' : 'folder-unavailable',
          true,
          this.store.durable,
        ),
      };
    }
  }

  /** Remove only QBSheet's remembered handle/mappings; never delete a user-visible backup file. */
  async removeConfiguration(): Promise<boolean> {
    this.writer.dispose();
    await this.setSettings(null);
    try {
      return await this.store.clearExternalConfiguration();
    } catch {
      return false;
    }
  }

  private async recordWriteResult(result: IExternalWriteResult): Promise<void> {
    if (result.state === 'superseded') return;
    const settings = await this.loadSettings();
    if (!settings) return;
    const timestamp = nowIso(this.now);
    const next: IRecoverySettings =
      result.state === 'saved'
        ? {
            ...settings,
            lastSuccessfulWriteAt: result.completedAt ?? timestamp,
            lastFailure: undefined,
            lastFailureAt: undefined,
          }
        : {
            ...settings,
            lastFailureAt: result.completedAt ?? timestamp,
            lastFailure: safeFailureText(result.error, 'The external backup could not be written.'),
          };
    await this.setSettings(next);
    try {
      await this.store.putSettings(next);
    } catch {
      // Failure metadata is best effort and must not turn a filesystem result into a scoring error.
    }
  }

  private async fileForGame(
    gameKey: string,
    gamePackage: IGamePackage,
  ): Promise<{ fileName: string; handle: IRecoveryFileHandle } | { status: ExternalBackupStatusState }> {
    const priorMappingWork = this.mappingTail;
    let releaseMappingWork!: () => void;
    this.mappingTail = new Promise<void>((resolve) => {
      releaseMappingWork = resolve;
    });
    await priorMappingWork;
    try {
      return await this.fileForGameSerial(gameKey, gamePackage);
    } finally {
      releaseMappingWork();
    }
  }

  private async fileForGameSerial(
    gameKey: string,
    gamePackage: IGamePackage,
  ): Promise<{ fileName: string; handle: IRecoveryFileHandle } | { status: ExternalBackupStatusState }> {
    const settings = await this.loadSettings();
    if (!settings) return { status: 'not-configured' };
    const permission = await queryPermission(settings.directoryHandle);
    if (permission === 'prompt' || permission === 'denied') return { status: 'needs-permission' };
    if (permission === 'unavailable') return { status: 'folder-unavailable' };

    let mappings: RecoveryFilenameMappings = [];
    try {
      mappings = await this.store.listFilenameMappings();
    } catch {
      // An empty mapping list is safe for choosing a filename; the current handle still works.
    }
    const fileName = chooseQbsheetBackupFileName(gamePackage, gameKey, mappings);
    let oldMapping: string | undefined;
    if (mappings instanceof Map) {
      oldMapping = mappings.get(gameKey);
    } else {
      for (const mapping of mappings) {
        if (Array.isArray(mapping)) continue;
        const candidate = mapping as { gameKey?: unknown; fileName?: unknown };
        if (candidate.gameKey === gameKey && typeof candidate.fileName === 'string') {
          oldMapping = candidate.fileName;
          break;
        }
      }
    }
    if (!oldMapping || oldMapping !== fileName) {
      const mapping: IRecoveryFilenameMapping = {
        id: gameKey,
        gameKey,
        fileName,
        baseFileName: chooseQbsheetBackupFileName(gamePackage, '__base__', []),
        createdAt: nowIso(this.now),
        updatedAt: nowIso(this.now),
      };
      try {
        await this.store.putFilenameMapping(mapping);
      } catch {
        // File creation remains useful even when the mapping DB is temporarily unavailable.
      }
    }
    try {
      const handle = await settings.directoryHandle.getFileHandle(fileName, { create: true });
      return { fileName, handle };
    } catch (error) {
      return { status: isPermissionError(error) ? 'needs-permission' : 'folder-unavailable' };
    }
  }

  /** Queue a normal `.qbsheet` file; the returned completion is intentionally optional to await. */
  async enqueueBackup(request: IExternalBackupRequest): Promise<IExternalBackupEnqueueResult> {
    const status = await this.status();
    if (!status.supported) return { ok: false, status: 'unsupported' };
    if (!status.configured) return { ok: false, status: 'not-configured' };
    if (status.state === 'needs-permission' || status.state === 'folder-unavailable') {
      return { ok: false, status: status.state };
    }
    const target = await this.fileForGame(request.gameKey, request.gamePackage);
    if ('status' in target) return { ok: false, status: target.status };
    let contents: string;
    try {
      contents = serializeQbsheetBackup(request.backup);
    } catch {
      return { ok: false, status: 'backup-failed' };
    }
    const completion = this.writer.enqueue(request.gameKey, target.handle, contents, request.revision);
    return { ok: true, status: 'ready', filename: target.fileName, completion };
  }

  /** Fire-and-forget form for scoring/event handlers; it never returns filesystem latency. */
  queueBackup(request: IExternalBackupRequest): void {
    void this.enqueueBackup(request);
  }

  async flush(gameKey?: string): Promise<void> {
    await this.writer.flush(gameKey);
  }
}

export type { ExternalWriteState };
