import { IQbsheetBackup } from '../scorer/QBSheetBackup';

/** The one record used for the external-backup directory handle and its safe status metadata. */
export const recoverySettingsId = 'external-backup' as const;

/**
 * The subset of the File System Access API that recovery needs.
 *
 * Keeping these interfaces structural makes the recovery core usable in browsers that do not ship
 * the API, in jsdom, and with small fake handles in unit tests. The real browser objects are
 * accepted without adapters.
 */
export interface IRecoveryWritableFile {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface IRecoveryFileHandle {
  readonly kind?: 'file';
  readonly name?: string;
  createWritable(): Promise<IRecoveryWritableFile>;
  /** Read access is optional so write-only test doubles and browsers remain supported. */
  getFile?(): Promise<{ size?: number; lastModified?: number; text(): Promise<string> }>;
}

export interface IRecoveryDirectoryHandle {
  readonly kind?: 'directory';
  readonly name?: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<IRecoveryFileHandle>;
  queryPermission?(descriptor?: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode: 'readwrite' }): Promise<PermissionState>;
}

/** Stored settings contain a browser handle, never a serialized path or an application secret. */
export interface IRecoverySettings {
  id: typeof recoverySettingsId;
  directoryHandle: IRecoveryDirectoryHandle;
  configuredAt: string;
  lastSuccessfulWriteAt?: string;
  lastFailureAt?: string;
  /** Safe human-readable error text only; backup contents are never recorded here. */
  lastFailure?: string;
}

/** A stable local-game-to-file mapping. `gameKey` remains local metadata and never enters a file. */
export interface IRecoveryFilenameMapping {
  id: string;
  gameKey: string;
  fileName: string;
  baseFileName: string;
  createdAt: string;
  updatedAt: string;
}

export type RecoveryCheckpointKind = 'rolling' | 'anchor';

/**
 * An exact, credential-free `.qbsheet` snapshot plus local-only ranking metadata.
 *
 * The serialized backup is intentionally the same text accepted by the normal Open game file
 * workflow. No parallel recovery payload is introduced here.
 */
export interface IRecoveryCheckpoint {
  id: string;
  gameKey: string;
  capturedAt: string;
  serializedBackup: string;
  /** A SHA-256 core fingerprint when Web Crypto was available, otherwise omitted. */
  coreFingerprint?: string;
  kind: RecoveryCheckpointKind;
  /** A stable key such as `halftime:1`; distinct anchors should use distinct keys. */
  anchorKey?: string;
  reason?: string;
  progressLabel?: string;
  questionNumber?: number;
  completed?: boolean;
}

/** Convenience input for making a checkpoint from an already sanitized backup object. */
export interface IRecoveryCheckpointInput {
  id: string;
  gameKey: string;
  capturedAt: string;
  backup: IQbsheetBackup;
  kind?: RecoveryCheckpointKind;
  anchorKey?: string;
  reason?: string;
  progressLabel?: string;
  questionNumber?: number;
  completed?: boolean;
  coreFingerprint?: string;
}
