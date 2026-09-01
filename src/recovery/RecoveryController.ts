import { IGamePackage } from '../game/GamePackage';
import { IQbsheetBackup } from '../scorer/QBSheetBackup';
import { IRecoveryWebCrypto, fingerprintRecoveryCore } from './RecoveryFingerprint';
import {
  ExternalBackupTarget,
  IExternalBackupConfigureResult,
  IExternalBackupEnqueueResult,
  IExternalBackupEnvironment,
  IExternalBackupRequest,
  IExternalBackupStatus,
} from './ExternalBackup';
import { IRecoveryCheckpointInput, IRecoveryCheckpoint } from './RecoveryTypes';
import {
  defaultRecoveryCheckpointLimits,
  IRecoveryCheckpointLimits,
  latestValidRecoveryCheckpoint,
  makeRecoveryCheckpoint,
} from './RecoveryCheckpoints';
import { CoalescingCheckpointWriter } from './RecoveryCheckpointWriter';
import { openRecoveryStore, IRecoveryStore, IRecoveryStoreEnvironment } from './RecoveryStore';

export interface IRecoveryControllerOptions {
  store?: IRecoveryStore;
  storeEnvironment?: IRecoveryStoreEnvironment;
  externalEnvironment?: IExternalBackupEnvironment;
  checkpointLimits?: IRecoveryCheckpointLimits;
  checkpointDebounceMs?: number;
  webCrypto?: IRecoveryWebCrypto | null;
}

export interface IRecoveryControllerStatus {
  externalBackup: IExternalBackupStatus;
  checkpoints: {
    durable: boolean;
    storageDegraded: boolean;
  };
}

export interface IRecoverySnapshotRequest {
  gameKey: string;
  gamePackage: IGamePackage;
  backup: IQbsheetBackup;
  checkpoint?: Omit<IRecoveryCheckpointInput, 'gameKey' | 'backup'> & {
    /** The checkpoint can use the same game key as the snapshot, but cannot silently use another. */
    gameKey?: string;
  };
  revision?: number;
}

export interface IRecoverySnapshotSchedule {
  checkpoint: Promise<boolean>;
  externalBackup: Promise<IExternalBackupEnqueueResult>;
}

/**
 * Public recovery facade for future scorer/UI integration.
 *
 * It deliberately does not import or mount scorer components. Callers can create it at bootstrap,
 * inspect status without prompts, and hand a complete sanitized `IQbsheetBackup` to the two
 * asynchronous persistence layers after the synchronous journal has accepted an action.
 */
export class RecoveryController {
  readonly store: IRecoveryStore;
  readonly externalBackup: ExternalBackupTarget;
  readonly checkpointWriter: CoalescingCheckpointWriter;
  private readonly checkpointLimits: IRecoveryCheckpointLimits;
  private readonly webCrypto: IRecoveryWebCrypto | null | undefined;

  constructor(
    store: IRecoveryStore,
    options: Omit<IRecoveryControllerOptions, 'store' | 'storeEnvironment'> = {},
  ) {
    this.store = store;
    this.externalBackup = new ExternalBackupTarget(store, options.externalEnvironment);
    this.checkpointLimits = options.checkpointLimits ?? defaultRecoveryCheckpointLimits;
    this.webCrypto = options.webCrypto;
    this.checkpointWriter = new CoalescingCheckpointWriter((input) => this.writeCheckpoint(input), {
      debounceMs: options.checkpointDebounceMs,
    });
  }

  static async open(options: IRecoveryControllerOptions = {}): Promise<RecoveryController> {
    const store = options.store ?? (await openRecoveryStore(options.storeEnvironment));
    return new RecoveryController(store, options);
  }

  async status(): Promise<IRecoveryControllerStatus> {
    return {
      externalBackup: await this.externalBackup.status(),
      checkpoints: {
        durable: this.store.durable,
        storageDegraded: this.store.storageDegraded,
      },
    };
  }

  async getStatus(): Promise<IRecoveryControllerStatus> {
    return this.status();
  }

  /** Explicit user action: opens the initial folder picker. */
  async setupExternalBackup(): Promise<IExternalBackupConfigureResult> {
    return this.externalBackup.setupFromUserGesture();
  }

  async setup(): Promise<IExternalBackupConfigureResult> {
    return this.setupExternalBackup();
  }

  /** Explicit user action: asks an existing directory handle to reacquire read/write permission. */
  async reconnectExternalBackup(): Promise<IExternalBackupConfigureResult> {
    return this.externalBackup.reconnectFromUserGesture();
  }

  async reconnect(): Promise<IExternalBackupConfigureResult> {
    return this.reconnectExternalBackup();
  }

  /** Forget QBSheet's metadata only; ordinary `.qbsheet` files remain untouched. */
  async removeExternalBackup(): Promise<boolean> {
    return this.externalBackup.removeConfiguration();
  }

  async listCheckpoints(gameKey: string): Promise<IRecoveryCheckpoint[]> {
    try {
      return await this.store.listCheckpoints(gameKey);
    } catch {
      return [];
    }
  }

  /** Persist a sanitized exact checkpoint and prune only records outside the bounded policy. */
  async writeCheckpoint(input: IRecoveryCheckpointInput): Promise<boolean> {
    let coreFingerprint = input.coreFingerprint;
    if (!coreFingerprint)
      coreFingerprint =
        (await fingerprintRecoveryCore(input.backup.setup, input.backup.events, this.webCrypto)) ?? undefined;
    const checkpoint = makeRecoveryCheckpoint({ ...input, coreFingerprint });
    try {
      return await this.store.saveCheckpoint(checkpoint, this.checkpointLimits);
    } catch {
      return false;
    }
  }

  async saveCheckpoint(input: IRecoveryCheckpointInput): Promise<boolean> {
    return this.writeCheckpoint(input);
  }

  /** Write a prebuilt serialized checkpoint when a caller already performed sanitization. */
  async writeStoredCheckpoint(checkpoint: IRecoveryCheckpoint): Promise<boolean> {
    try {
      return await this.store.saveCheckpoint(checkpoint, this.checkpointLimits);
    } catch {
      return false;
    }
  }

  async latestValidCheckpoint(gameKey: string) {
    return latestValidRecoveryCheckpoint(await this.listCheckpoints(gameKey));
  }

  /**
   * Queue one ordinary `.qbsheet` file. The returned completion promise is optional to await; callers
   * on the scoring path should ignore it and let the writer run in the background.
   */
  async writeExternalBackup(request: IExternalBackupRequest): Promise<IExternalBackupEnqueueResult> {
    return this.externalBackup.enqueueBackup(request);
  }

  async enqueueExternalBackup(request: IExternalBackupRequest): Promise<IExternalBackupEnqueueResult> {
    return this.writeExternalBackup(request);
  }

  /** Fire-and-forget convenience for a scorer event handler. */
  queueExternalBackup(request: IExternalBackupRequest): void {
    this.externalBackup.queueBackup(request);
  }

  /** Start both best-effort layers after the journal/render path; neither is required for scoring. */
  scheduleSnapshot(request: IRecoverySnapshotRequest): IRecoverySnapshotSchedule {
    const checkpoint = request.checkpoint ?? {
      id: `${request.gameKey}:${request.revision ?? 'snapshot'}`,
      capturedAt: new Date().toISOString(),
      kind: 'rolling' as const,
    };
    const checkpointInput: IRecoveryCheckpointInput = {
      ...checkpoint,
      gameKey: checkpoint.gameKey ?? request.gameKey,
      backup: request.backup,
    };
    const externalRequest: IExternalBackupRequest = {
      gameKey: request.gameKey,
      gamePackage: request.gamePackage,
      backup: request.backup,
      revision: request.revision,
    };
    return {
      checkpoint: this.checkpointWriter.enqueue(request.gameKey, checkpointInput, request.revision),
      externalBackup: this.writeExternalBackup(externalRequest),
    };
  }

  async flushCheckpoints(gameKey?: string): Promise<void> {
    await this.checkpointWriter.flush(gameKey);
  }

  async flushExternalBackup(gameKey?: string): Promise<void> {
    await this.externalBackup.flush(gameKey);
  }
}

/** Name used by application integration code that prefers “service” over “controller”. */
export { RecoveryController as RecoveryService };
