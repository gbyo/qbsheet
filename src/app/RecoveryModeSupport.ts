/**
 * Low-level Recovery Mode support.
 *
 * This module deliberately stops below the normal app and scorer components. It can inspect the
 * existing local sources and restore an existing `.qbsheet` envelope, but it never prunes records,
 * claims a scoring tab, contacts tournament control, or clears a key. Those are important safe-mode
 * properties: opening this screen must preserve evidence even when the normal UI is the problem.
 */
import { GameRecordConflictError, GameStore, isActive, memoryGameStore } from '../game/GameStore';
import type { IStoredGameRecord } from '../game/GameStore';
import { gamePackageIdentity, gamePackageLabel, gamePackageMatchup } from '../game/GamePackage';
import type { IGamePackage } from '../game/GamePackage';
import { openRecordStore } from '../persistence/GameDatabase';
import { exportJournals, saveGame } from '../scorer/GameSession';
import type { IGameSessionHistory } from '../scorer/GameSession';
import { maxQbsheetBackupBytes, readQbsheetBackup } from '../scorer/QBSheetBackup';
import type { IQbsheetBackup } from '../scorer/QBSheetBackup';
import { restoreRoomClocks } from '../scorer/RoomClock';
import { parseDisplaySideMapping, saveDisplaySideMapping } from '../scorer/DisplaySideMapping';
import { saveSeating } from '../scorer/PlayerSeating';
import { ExternalBackupTarget } from '../recovery/ExternalBackup';
import type { IExternalBackupEnvironment, IExternalBackupStatus } from '../recovery/ExternalBackup';
import { validateRecoveryCheckpoint } from '../recovery/RecoveryCheckpoints';
import { chooseQbsheetBackupFileName, isSafeQbsheetFileName } from '../recovery/RecoveryFilenames';
import { openRecoveryStore } from '../recovery/RecoveryStore';
import type { IRecoveryStore } from '../recovery/RecoveryStore';
import type { IRecoveryCheckpoint, IRecoveryDirectoryHandle } from '../recovery/RecoveryTypes';
import { inspectJournals } from './RecoveryJournal';
import type { IJournalInspection, JournalInspectionStatus } from './RecoveryJournal';

export { maxQbsheetBackupBytes };
export { inspectJournal, inspectJournals, summarizeJournalRecovery } from './RecoveryJournal';

export type RecoverySourceKind = 'journal' | 'durable' | 'checkpoint' | 'external';
export type RecoverySourceStatus =
  JournalInspectionStatus | 'missing' | 'needs-permission' | 'folder-unavailable' | 'backup-failed';

export interface IRecoverySourceStatus {
  id?: string;
  kind: RecoverySourceKind;
  label: string;
  status: RecoverySourceStatus;
  exact: boolean;
  updatedAt?: string;
  eventCount?: number;
  latestQuestion?: number;
  /** Available only for a validated exact source; never rendered as raw JSON. */
  backup?: IQbsheetBackup;
  progressLabel?: string;
}

export interface IRecoveryGameStatus {
  /** Internal grouping key. It is never shown in the recovery UI. */
  key: string;
  label: string;
  matchup: string;
  record?: IStoredGameRecord;
  sources: IRecoverySourceStatus[];
  resumeSource?: RecoverySourceKind;
}

export interface IRecoverySnapshot {
  /** Raw strings stay in memory only for the explicit emergency export action. */
  journals: Record<string, string>;
  journalEntries: IJournalInspection[];
  games: IRecoveryGameStatus[];
  unreadableCount: number;
  durable: boolean;
  storageDegraded: boolean;
  storageError?: string;
  journalUnavailable: boolean;
  /** The same store is reused by a deliberate restore action. */
  store: GameStore;
  /** Separate recovery metadata is optional so a broken recovery database never blocks inspection. */
  recoveryStore?: IRecoveryStore;
  externalBackup?: IExternalBackupStatus;
  inspectedAt: Date;
}

export interface IRecoveryLoadOptions {
  now?: Date;
  readJournals?: () => Record<string, string>;
  openStore?: () => Promise<GameStore>;
  openRecoveryStore?: () => Promise<IRecoveryStore>;
  externalEnvironment?: IExternalBackupEnvironment;
}

export interface IRecoveryCandidate {
  kind: RecoverySourceKind;
  status: RecoverySourceStatus;
  exact: boolean;
  updatedAt?: string;
}

/**
 * Choose an exact local copy for the Resume action.
 *
 * A valid synchronous journal remains first by authority, even if an asynchronous mirror reports a
 * later wall-clock timestamp. When no journal is usable, a valid exact local mirror is chosen by
 * freshness. Hashes/checkpoints/server snapshots are intentionally not invented here.
 */
export function chooseSafestRecoveryCandidate(
  candidates: readonly IRecoveryCandidate[],
): IRecoveryCandidate | null {
  const usable = candidates.filter((candidate) => candidate.exact && candidate.status === 'valid');
  const journal = usable.find((candidate) => candidate.kind === 'journal');
  if (journal) return journal;
  return (
    usable.slice().sort((first, second) => {
      const firstAt = new Date(first.updatedAt ?? '').getTime();
      const secondAt = new Date(second.updatedAt ?? '').getTime();
      return secondAt - firstAt;
    })[0] ?? null
  );
}

export function recoverySourceLabel(kind: RecoverySourceKind): string {
  switch (kind) {
    case 'journal':
      return 'Instant scoring journal';
    case 'durable':
      return 'Durable device copy';
    case 'checkpoint':
      return 'Recovery checkpoint';
    case 'external':
      return 'External backup';
  }
}

export function recoveryStatusLabel(status: RecoverySourceStatus): string {
  switch (status) {
    case 'valid':
      return 'Valid';
    case 'missing':
      return 'Not found';
    case 'stale':
      return 'Stale';
    case 'unsupported':
      return 'Unsupported version';
    case 'malformed':
      return 'Could not verify';
    case 'needs-permission':
      return 'Needs permission';
    case 'folder-unavailable':
      return 'Folder unavailable';
    case 'backup-failed':
      return 'Backup failed';
  }
}

/** A compact, deterministic description suitable for a source row. */
export function formatRecoveryAge(iso: string | undefined, now: Date): string {
  if (!iso) return '';
  const updated = new Date(iso).getTime();
  if (!Number.isFinite(updated)) return '';
  const age = Math.max(0, now.getTime() - updated);
  if (age < 10_000) return 'saved just now';
  if (age < 60_000) return `saved ${Math.floor(age / 1_000)} seconds ago`;
  if (age < 60 * 60_000) return `saved ${Math.floor(age / 60_000)} minutes ago`;
  if (age < 24 * 60 * 60_000) {
    return `saved at ${new Date(updated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return `saved ${new Date(updated).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function sourceFromJournal(entry: IJournalInspection): IRecoverySourceStatus {
  return {
    kind: 'journal',
    label: recoverySourceLabel('journal'),
    status: entry.status,
    exact: entry.status === 'valid',
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    ...(entry.events ? { eventCount: entry.events.length } : {}),
    ...(entry.events && entry.events.length > 0
      ? { latestQuestion: Math.max(...entry.events.map((event) => event.questionNumber)) }
      : {}),
  };
}

function sourceFromRecord(record: IStoredGameRecord): IRecoverySourceStatus {
  return {
    kind: 'durable',
    label: recoverySourceLabel('durable'),
    status: 'valid',
    exact: true,
    updatedAt: record.updatedAt,
    eventCount: record.events.length,
    ...(record.events.length > 0
      ? { latestQuestion: Math.max(...record.events.map((event) => event.questionNumber)) }
      : {}),
  };
}

function latestQuestionOf(events: readonly { questionNumber: number }[]): number | undefined {
  if (events.length === 0) return undefined;
  return Math.max(...events.map((event) => event.questionNumber));
}

function sourceFromCheckpoint(checkpoint: IRecoveryCheckpoint): IRecoverySourceStatus {
  const validation = validateRecoveryCheckpoint(checkpoint);
  const backup = validation.backup;
  const progressLabel =
    checkpoint.progressLabel ?? (backup ? `Tossup ${latestQuestionOf(backup.events) ?? 0}` : undefined);
  const status: RecoverySourceStatus = validation.valid
    ? 'valid'
    : validation.errors.some((error) => /version|unsupported/i.test(error))
      ? 'unsupported'
      : 'malformed';
  return {
    id: checkpoint.id,
    kind: 'checkpoint',
    label: progressLabel
      ? `${recoverySourceLabel('checkpoint')} · ${progressLabel}`
      : recoverySourceLabel('checkpoint'),
    status,
    exact: validation.valid,
    updatedAt: checkpoint.capturedAt,
    ...(backup ? { eventCount: backup.events.length, backup } : {}),
    ...(backup && latestQuestionOf(backup.events) !== undefined
      ? { latestQuestion: latestQuestionOf(backup.events) }
      : checkpoint.questionNumber === undefined
        ? {}
        : { latestQuestion: checkpoint.questionNumber }),
    ...(checkpoint.progressLabel ? { progressLabel: checkpoint.progressLabel } : {}),
  };
}

function backupErrorStatus(errors: readonly string[]): 'unsupported' | 'malformed' {
  return errors.some((error) => /version|unsupported/i.test(error)) ? 'unsupported' : 'malformed';
}

function sourceFromExternal(
  fileName: string,
  status: RecoverySourceStatus,
  updatedAt?: string,
  backup?: IQbsheetBackup,
): IRecoverySourceStatus {
  return {
    id: fileName,
    kind: 'external',
    label: fileName ? `${recoverySourceLabel('external')} · ${fileName}` : recoverySourceLabel('external'),
    status,
    exact: status === 'valid',
    ...(updatedAt ? { updatedAt } : {}),
    ...(backup ? { eventCount: backup.events.length, backup } : {}),
    ...(backup && latestQuestionOf(backup.events) !== undefined
      ? { latestQuestion: latestQuestionOf(backup.events) }
      : {}),
  };
}

function externalReadFailureStatus(error: unknown): RecoverySourceStatus {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name?: unknown }).name)
      : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'needs-permission';
  if (name === 'NotFoundError') return 'missing';
  return 'folder-unavailable';
}

function fileLastModified(value: number | undefined, fallback?: string): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    try {
      return new Date(value).toISOString();
    } catch {
      // Fall through to the safe metadata timestamp.
    }
  }
  return fallback;
}

async function inspectExternalFile(
  directoryHandle: IRecoveryDirectoryHandle,
  fileName: string,
  fallbackUpdatedAt: string | undefined,
): Promise<IRecoverySourceStatus> {
  let fileHandle;
  try {
    // `create:false` is important: inspecting Recovery Mode must not manufacture an empty file when
    // the user moved or deleted the remembered backup.
    fileHandle = await directoryHandle.getFileHandle(fileName, { create: false });
  } catch (error) {
    return sourceFromExternal(fileName, externalReadFailureStatus(error), fallbackUpdatedAt);
  }
  if (!fileHandle.getFile) return sourceFromExternal(fileName, 'unsupported', fallbackUpdatedAt);

  try {
    const file = await fileHandle.getFile();
    const updatedAt = fileLastModified(file.lastModified, fallbackUpdatedAt);
    if (file.size !== undefined && file.size > maxQbsheetBackupBytes) {
      return sourceFromExternal(fileName, 'malformed', updatedAt);
    }
    const parsed = parseRecoveryFileText(await file.text());
    return parsed.ok
      ? sourceFromExternal(fileName, 'valid', updatedAt, parsed.backup)
      : sourceFromExternal(fileName, backupErrorStatus(parsed.errors), updatedAt);
  } catch (error) {
    return sourceFromExternal(fileName, externalReadFailureStatus(error), fallbackUpdatedAt);
  }
}

function addSource(
  sourcesByGame: Map<string, IRecoverySourceStatus[]>,
  gameKey: string,
  source: IRecoverySourceStatus,
): void {
  const sources = sourcesByGame.get(gameKey) ?? [];
  if (!sources.some((candidate) => candidate.id !== undefined && candidate.id === source.id)) {
    sources.push(source);
  }
  sourcesByGame.set(gameKey, sources);
}

async function inspectRecoveryStoreSources(
  recoveryStore: IRecoveryStore,
  gamePackagesByGame: ReadonlyMap<string, IGamePackage>,
  knownGameKeys: readonly string[],
  externalEnvironment?: IExternalBackupEnvironment,
): Promise<{
  sourcesByGame: Map<string, IRecoverySourceStatus[]>;
  externalBackup: IExternalBackupStatus;
  error?: string;
}> {
  const sourcesByGame = new Map<string, IRecoverySourceStatus[]>();
  let error: string | undefined;

  try {
    const checkpoints = recoveryStore.listAllCheckpoints
      ? await recoveryStore.listAllCheckpoints()
      : (
          await Promise.all(
            knownGameKeys.map(async (gameKey) => {
              try {
                return await recoveryStore.listCheckpoints(gameKey);
              } catch {
                return [];
              }
            }),
          )
        ).flat();
    for (const checkpoint of checkpoints) {
      addSource(sourcesByGame, checkpoint.gameKey, sourceFromCheckpoint(checkpoint));
    }
  } catch {
    error = 'Recovery checkpoints could not be inspected. The other local copies remain unchanged.';
  }

  const external = new ExternalBackupTarget(recoveryStore, externalEnvironment);
  let externalStatus: IExternalBackupStatus;
  try {
    externalStatus = await external.status();
  } catch {
    externalStatus = {
      state: 'folder-unavailable',
      supported: true,
      configured: false,
      metadataDurable: recoveryStore.durable,
    };
  }

  if (!externalStatus.configured || !externalStatus.supported) {
    return { sourcesByGame, externalBackup: externalStatus, ...(error ? { error } : {}) };
  }

  let settings;
  try {
    settings = await recoveryStore.getSettings();
  } catch {
    return {
      sourcesByGame,
      externalBackup: externalStatus,
      error: error ?? 'External backup settings could not be inspected.',
    };
  }
  if (!settings) return { sourcesByGame, externalBackup: externalStatus, ...(error ? { error } : {}) };

  let mappings: Awaited<ReturnType<IRecoveryStore['listFilenameMappings']>>;
  try {
    mappings = await recoveryStore.listFilenameMappings();
  } catch {
    mappings = [];
    error = error ?? 'External backup filename mappings could not be inspected.';
  }

  const candidates = new Map<string, { fileName: string; fallbackUpdatedAt?: string }>();
  for (const mapping of mappings) {
    if (typeof mapping.gameKey !== 'string' || typeof mapping.fileName !== 'string') continue;
    if (!isSafeQbsheetFileName(mapping.fileName)) {
      addSource(sourcesByGame, mapping.gameKey, sourceFromExternal('', 'malformed', mapping.updatedAt));
      continue;
    }
    candidates.set(mapping.gameKey, { fileName: mapping.fileName, fallbackUpdatedAt: mapping.updatedAt });
  }
  for (const gameKey of knownGameKeys) {
    if (candidates.has(gameKey)) continue;
    const gamePackage = gamePackagesByGame.get(gameKey);
    if (!gamePackage) continue;
    // This read uses the same deterministic base name the writer would choose, but never creates it.
    const fileName = chooseQbsheetBackupFileName(gamePackage, gameKey, mappings);
    candidates.set(gameKey, { fileName, fallbackUpdatedAt: externalStatus.lastSuccessfulWriteAt });
  }

  if (externalStatus.state === 'needs-permission' || externalStatus.state === 'folder-unavailable') {
    for (const [gameKey, candidate] of candidates) {
      addSource(
        sourcesByGame,
        gameKey,
        sourceFromExternal(candidate.fileName, externalStatus.state, candidate.fallbackUpdatedAt),
      );
    }
    return { sourcesByGame, externalBackup: externalStatus, ...(error ? { error } : {}) };
  }

  for (const [gameKey, candidate] of candidates) {
    const source = await inspectExternalFile(
      settings.directoryHandle,
      candidate.fileName,
      candidate.fallbackUpdatedAt ?? externalStatus.lastSuccessfulWriteAt,
    );
    addSource(sourcesByGame, gameKey, source);
  }

  return { sourcesByGame, externalBackup: externalStatus, ...(error ? { error } : {}) };
}

function missingJournalSource(): IRecoverySourceStatus {
  return {
    kind: 'journal',
    label: recoverySourceLabel('journal'),
    status: 'missing',
    exact: false,
  };
}

function labelForUnmatchedJournal(): { label: string; matchup: string } {
  return {
    label: 'Saved game on this device',
    matchup: 'The journal has no readable game definition attached to it.',
  };
}

/** Build the source comparison without opening a database or touching browser state. */
export function buildRecoveryGames(
  journalEntries: readonly IJournalInspection[],
  records: readonly IStoredGameRecord[],
  additionalSourcesByGame: ReadonlyMap<string, readonly IRecoverySourceStatus[]> = new Map(),
): IRecoveryGameStatus[] {
  const games = new Map<string, IRecoveryGameStatus>();
  const recordGames = new Map<string, IRecoveryGameStatus>();

  for (const record of records) {
    const game: IRecoveryGameStatus = {
      key: `record:${record.id}`,
      label: gamePackageLabel(record.package),
      matchup: gamePackageMatchup(record.package),
      record,
      sources: [
        missingJournalSource(),
        sourceFromRecord(record),
        ...(additionalSourcesByGame.get(record.gameKey) ?? []),
      ],
    };
    if (isActive(record)) {
      game.resumeSource = chooseSafestRecoveryCandidate(game.sources)?.kind;
    }
    recordGames.set(record.gameKey, game);
    games.set(game.key, game);
  }

  for (const entry of journalEntries) {
    const existing = recordGames.get(entry.gameKey);
    if (existing) {
      existing.sources = [
        sourceFromJournal(entry),
        ...existing.sources.filter((source) => source.kind !== 'journal'),
      ];
      if (isActive(existing.record!)) {
        existing.resumeSource = chooseSafestRecoveryCandidate(existing.sources)?.kind;
      }
      continue;
    }
    const names = labelForUnmatchedJournal();
    const unmatched: IRecoveryGameStatus = {
      key: `journal:${entry.gameKey}`,
      ...names,
      sources: [sourceFromJournal(entry), ...(additionalSourcesByGame.get(entry.gameKey) ?? [])],
    };
    unmatched.resumeSource = chooseSafestRecoveryCandidate(unmatched.sources)?.kind;
    games.set(unmatched.key, unmatched);
  }

  const representedGameKeys = new Set([
    ...recordGames.keys(),
    ...journalEntries.map((entry) => entry.gameKey),
  ]);
  for (const [gameKey, sources] of additionalSourcesByGame) {
    if (representedGameKeys.has(gameKey) || sources.length === 0) continue;
    const backup = sources.find((source) => source.status === 'valid' && source.backup)?.backup;
    const extra: IRecoveryGameStatus = {
      key: `source:${gameKey}`,
      label: backup ? gamePackageLabel(backup.package) : 'Saved game on this device',
      matchup: backup ? gamePackageMatchup(backup.package) : 'Recovery source found',
      sources: [...sources],
    };
    extra.resumeSource = chooseSafestRecoveryCandidate(extra.sources)?.kind;
    games.set(extra.key, extra);
  }

  return [...games.values()];
}

async function defaultOpenStore(): Promise<GameStore> {
  return new GameStore(await openRecordStore<IStoredGameRecord>());
}

/** Inspect local sources without pruning, migrating through an import, or requesting permissions. */
export async function loadRecoverySources(options: IRecoveryLoadOptions = {}): Promise<IRecoverySnapshot> {
  const inspectedAt = options.now ?? new Date();
  let journals: Record<string, string> = {};
  let journalUnavailable = false;
  try {
    journals = options.readJournals ? options.readJournals() : exportJournals();
  } catch {
    journalUnavailable = true;
  }
  const journalEntries = inspectJournals(journals, inspectedAt);

  let store: GameStore;
  let records: IStoredGameRecord[] = [];
  let storageError: string | undefined;
  try {
    store = await (options.openStore ?? defaultOpenStore)();
    records = await store.list();
  } catch {
    // Recovery Mode can still export raw journals when IndexedDB cannot be opened. A memory store
    // gives the explicit restore action a safe place to fail without throwing through the UI.
    store = memoryGameStore();
    storageError = 'The durable device copy could not be inspected right now.';
  }

  let recoveryStore: IRecoveryStore | undefined;
  let recoveryStorageError: string | undefined;
  try {
    recoveryStore = await (options.openRecoveryStore ? options.openRecoveryStore() : openRecoveryStore());
  } catch {
    recoveryStorageError = 'The separate recovery store could not be inspected right now.';
  }

  const gamePackagesByGame = new Map(records.map((record) => [record.gameKey, record.package] as const));
  const knownGameKeys = [
    ...new Set([...records.map((record) => record.gameKey), ...journalEntries.map((entry) => entry.gameKey)]),
  ];
  let additionalSourcesByGame = new Map<string, IRecoverySourceStatus[]>();
  let externalBackup: IExternalBackupStatus | undefined;
  if (recoveryStore) {
    const inspectedRecovery = await inspectRecoveryStoreSources(
      recoveryStore,
      gamePackagesByGame,
      knownGameKeys,
      options.externalEnvironment,
    );
    additionalSourcesByGame = inspectedRecovery.sourcesByGame;
    externalBackup = inspectedRecovery.externalBackup;
    recoveryStorageError = recoveryStore.storageError ?? inspectedRecovery.error;
  }

  const combinedStorageError = storageError ?? recoveryStorageError;

  return {
    journals,
    journalEntries,
    games: buildRecoveryGames(journalEntries, records, additionalSourcesByGame),
    unreadableCount: store.unreadable.length,
    durable: store.durable,
    storageDegraded:
      store.storageDegraded ||
      storageError !== undefined ||
      recoveryStore?.storageDegraded === true ||
      recoveryStorageError !== undefined,
    ...((store.storageError ?? combinedStorageError)
      ? { storageError: store.storageError ?? combinedStorageError }
      : {}),
    journalUnavailable,
    store,
    ...(recoveryStore ? { recoveryStore } : {}),
    ...(externalBackup ? { externalBackup } : {}),
    inspectedAt,
  };
}

export interface IRestoreSuccess {
  ok: true;
  record: IStoredGameRecord;
  journalSaved: boolean;
  restoringAlongsideActive: boolean;
  skippedOccupiedSlot: boolean;
}

export interface IRestoreFailure {
  ok: false;
  message: string;
  /** A newly created record is returned so callers never assume it was deleted. */
  record?: IStoredGameRecord;
  journalSaved: boolean;
}

export type RestoreBackupResult = IRestoreSuccess | IRestoreFailure;

/**
 * Restore a validated backup as a new offline attempt.
 *
 * The identity/attempt loop mirrors the established app import path. It handles an unreadable record
 * occupying a slot by choosing another one, and never calls `remove`: existing evidence and even a
 * partially committed new copy are safer left visible for the scorekeeper to inspect.
 */
export async function restoreBackupAsSeparateAttempt(
  backup: IQbsheetBackup,
  store: GameStore,
  now: Date = new Date(),
): Promise<RestoreBackupResult> {
  const identity = gamePackageIdentity(backup.package);
  let existing: IStoredGameRecord[] = [];
  try {
    existing = await store.findByIdentity(identity);
  } catch {
    return {
      ok: false,
      message: 'QBSheet could not inspect existing local attempts. Nothing was changed.',
      journalSaved: false,
    };
  }

  const restoringAlongsideActive = existing.some(isActive);
  let attempt = Math.max(0, ...existing.map((record) => record.attempt)) + 1;
  let created: IStoredGameRecord | undefined;
  let skippedOccupiedSlot = false;
  let journalSaved = false;

  try {
    for (let tries = 0; tries < 100; tries += 1) {
      try {
        created = await store.create({
          package: backup.package,
          setup: backup.setup,
          connected: false,
          attempt,
          now,
        });
        break;
      } catch (error) {
        if (!(error instanceof GameRecordConflictError)) throw error;
        skippedOccupiedSlot = true;
        attempt += 1;
      }
    }
    if (!created) throw new Error('No unused local record slot was available.');

    // The fast journal is deliberately attempted before the asynchronous mirror, matching normal
    // scoring. A false result is reported, never turned into a promise that scoring is safe.
    journalSaved = saveGame(
      created.gameKey,
      backup.setup,
      backup.events,
      now,
      undefined,
      backup.history as IGameSessionHistory | undefined,
    );
    const updated = await store.update(created.id, { setup: backup.setup, events: backup.events });
    if (!updated) throw new Error('The durable local copy refused this backup.');

    // These are presentation/clock auxiliaries. Each existing API already treats failure as a
    // disposable preference and, importantly, none of them can change or delete the event history.
    restoreRoomClocks(created.gameKey, backup.clocks);
    const mapping = parseDisplaySideMapping(backup.displaySideMapping);
    if (mapping) saveDisplaySideMapping(created.gameKey, mapping);
    if (backup.playerSeating) saveSeating(created.gameKey, backup.playerSeating, now);

    return {
      ok: true,
      record: updated,
      journalSaved,
      restoringAlongsideActive,
      skippedOccupiedSlot,
    };
  } catch {
    return {
      ok: false,
      message: created
        ? journalSaved
          ? 'The backup is saved in a separate local journal, but its durable copy could not be completed. No existing record was changed.'
          : 'A separate local attempt was created, but the backup could not be saved to the fast journal. No existing record was changed.'
        : 'QBSheet could not restore this backup on the device. Nothing existing was changed.',
      ...(created ? { record: created } : {}),
      journalSaved,
    };
  }
}

export interface IParsedRecoveryFile {
  ok: true;
  backup: IQbsheetBackup;
}

/** Parse only the existing exact QBSheet backup format; QBJ remains the ordinary app workflow. */
export function parseRecoveryFileText(text: string): IParsedRecoveryFile | { ok: false; errors: string[] } {
  try {
    const value: unknown = JSON.parse(text);
    const parsed = readQbsheetBackup(value);
    return parsed.ok ? { ok: true, backup: parsed.value } : parsed;
  } catch {
    return { ok: false, errors: ['That file is not readable as JSON.'] };
  }
}
