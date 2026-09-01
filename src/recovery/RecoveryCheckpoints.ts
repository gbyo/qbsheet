import { IQbsheetBackup, readQbsheetBackup, serializeQbsheetBackup } from '../scorer/QBSheetBackup';
import { IRecoveryCheckpoint, IRecoveryCheckpointInput, RecoveryCheckpointKind } from './RecoveryTypes';

/** The bounded default requested by the recovery design. */
export const defaultRecoveryCheckpointLimits = {
  maxRolling: 8,
  maxAnchors: 32,
} as const;

export interface IRecoveryCheckpointLimits {
  /** Number of recent non-anchor snapshots to retain per game. */
  maxRolling?: number;
  /** Maximum number of anchor snapshots to retain per game. */
  maxAnchors?: number;
}

function timestampOf(checkpoint: Pick<IRecoveryCheckpoint, 'capturedAt'>): number {
  const timestamp = new Date(checkpoint.capturedAt ?? '').getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function stableCheckpointOrder(first: IRecoveryCheckpoint, second: IRecoveryCheckpoint): number {
  const byTime = timestampOf(second) - timestampOf(first);
  if (byTime !== 0) return byTime;
  return String(second.id ?? '').localeCompare(String(first.id ?? ''));
}

function isAnchor(checkpoint: IRecoveryCheckpoint): boolean {
  return checkpoint.kind === 'anchor';
}

/**
 * Retain a bounded, non-mutating checkpoint set.
 *
 * Anchor keys are deliberately de-duplicated by keeping their newest copy. A caller that wants to
 * preserve two halftimes should use `halftime:1` and `halftime:2`, while repeated writes for the
 * same logical anchor do not consume the bounded anchor budget. At least one checkpoint survives
 * for a non-empty input, even if a caller supplies an accidental zero rolling limit.
 */
export function retainRecoveryCheckpoints(
  checkpoints: readonly IRecoveryCheckpoint[],
  limits: IRecoveryCheckpointLimits = defaultRecoveryCheckpointLimits,
): IRecoveryCheckpoint[] {
  if (checkpoints.length === 0) return [];
  const maxRolling = Math.max(1, Math.floor(limits.maxRolling ?? defaultRecoveryCheckpointLimits.maxRolling));
  const maxAnchors = Math.max(0, Math.floor(limits.maxAnchors ?? defaultRecoveryCheckpointLimits.maxAnchors));

  const anchorsByKey = new Map<string, IRecoveryCheckpoint>();
  for (const checkpoint of checkpoints.filter(isAnchor).sort(stableCheckpointOrder)) {
    const key = checkpoint.anchorKey ?? checkpoint.id;
    if (!anchorsByKey.has(key)) anchorsByKey.set(key, checkpoint);
  }
  const anchors = [...anchorsByKey.values()].slice(0, maxAnchors);
  const anchorIds = new Set(anchors.map((checkpoint) => checkpoint.id));

  const rolling = checkpoints
    .filter((checkpoint) => !isAnchor(checkpoint) && !anchorIds.has(checkpoint.id))
    .sort(stableCheckpointOrder)
    .slice(0, maxRolling);

  const retained = [...anchors, ...rolling];
  if (retained.length === 0) {
    const newest = checkpoints.slice().sort(stableCheckpointOrder)[0];
    if (newest) retained.push(newest);
  }
  return retained.sort((first, second) => {
    const byTime = timestampOf(first) - timestampOf(second);
    return byTime !== 0 ? byTime : String(first.id ?? '').localeCompare(String(second.id ?? ''));
  });
}

/** The exact checkpoint representation stored in IndexedDB. */
export function makeRecoveryCheckpoint(input: IRecoveryCheckpointInput): IRecoveryCheckpoint {
  const kind: RecoveryCheckpointKind = input.kind ?? 'rolling';
  return {
    id: input.id,
    gameKey: input.gameKey,
    capturedAt: input.capturedAt,
    serializedBackup: serializeQbsheetBackup(input.backup),
    ...(input.coreFingerprint ? { coreFingerprint: input.coreFingerprint } : {}),
    kind,
    ...(kind === 'anchor' && input.anchorKey ? { anchorKey: input.anchorKey } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.progressLabel ? { progressLabel: input.progressLabel } : {}),
    ...(input.questionNumber === undefined ? {} : { questionNumber: input.questionNumber }),
    ...(input.completed === undefined ? {} : { completed: input.completed }),
  };
}

export interface ICheckpointValidation {
  checkpoint: IRecoveryCheckpoint;
  valid: boolean;
  backup?: IQbsheetBackup;
  errors: string[];
}

/** Validate a stored snapshot without changing or deleting the stored evidence. */
export function validateRecoveryCheckpoint(checkpoint: IRecoveryCheckpoint): ICheckpointValidation {
  try {
    const parsed: unknown = JSON.parse(checkpoint.serializedBackup);
    const result = readQbsheetBackup(parsed);
    return result.ok
      ? { checkpoint, valid: true, backup: result.value, errors: [] }
      : { checkpoint, valid: false, errors: result.errors };
  } catch {
    return { checkpoint, valid: false, errors: ['The checkpoint is not readable as JSON.'] };
  }
}

/**
 * Pick the newest valid checkpoint while retaining invalid records for diagnostics.
 *
 * This is intentionally not a destructive cleanup operation: a malformed newest checkpoint is
 * evidence about what happened and must not make an older valid copy disappear.
 */
export function latestValidRecoveryCheckpoint(
  checkpoints: readonly IRecoveryCheckpoint[],
): ICheckpointValidation | null {
  const ranked = checkpoints.slice().sort(stableCheckpointOrder);
  for (const checkpoint of ranked) {
    const validation = validateRecoveryCheckpoint(checkpoint);
    if (validation.valid) return validation;
  }
  return null;
}
