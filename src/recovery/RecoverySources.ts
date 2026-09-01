import { readQbsheetBackup } from '../scorer/QBSheetBackup';
import { IRecoveryCheckpoint } from './RecoveryTypes';

export type RecoverySourceName = 'journal' | 'durable' | 'checkpoint' | 'external' | 'server' | 'qbj';

export interface IRecoveryCandidate<T = unknown> {
  source: RecoverySourceName;
  value: T;
  valid: boolean;
  /** Exact candidates preserve the full QBSheet scoring state. */
  exact: boolean;
  capturedAt?: string | number | Date;
  fingerprint?: string | null;
  label?: string;
}

export interface IRecoverySelectionOptions {
  /** Once local scoring has begun, a late server response may not replace it. */
  localScoringStarted?: boolean;
}

function timestampOf(candidate: IRecoveryCandidate): number {
  const value = candidate.capturedAt;
  if (value === undefined) return Number.NEGATIVE_INFINITY;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

const sourceTieBreak: Record<RecoverySourceName, number> = {
  journal: 6,
  durable: 5,
  checkpoint: 4,
  external: 3,
  server: 2,
  qbj: 1,
};

function sourceClass(candidate: IRecoveryCandidate): number {
  if (candidate.source === 'journal') return 5;
  if (
    candidate.source === 'durable' ||
    candidate.source === 'checkpoint' ||
    candidate.source === 'external'
  ) {
    return candidate.exact ? 4 : 1;
  }
  if (candidate.source === 'server') return candidate.exact ? 3 : 1;
  return candidate.exact ? 2 : 0;
}

function candidateRank(candidate: IRecoveryCandidate): [number, number, number] {
  return [sourceClass(candidate), timestampOf(candidate), sourceTieBreak[candidate.source]];
}

function compareCandidates(first: IRecoveryCandidate, second: IRecoveryCandidate): number {
  const firstRank = candidateRank(first);
  const secondRank = candidateRank(second);
  for (let index = 0; index < firstRank.length; index += 1) {
    if (firstRank[index] !== secondRank[index]) return secondRank[index] - firstRank[index];
  }
  return 0;
}

/**
 * Select a recovery source without changing the authority policy.
 *
 * A valid synchronous journal is an explicit first-source rule, even if an async mirror claims a
 * later timestamp. Outside that case, exact state wins over lossy QBJ/server data; timestamp only
 * resolves exact-state freshness, and source priority resolves equal or missing timestamps.
 */
export function selectRecoveryCandidate<T>(
  candidates: readonly IRecoveryCandidate<T>[],
  options: IRecoverySelectionOptions = {},
): IRecoveryCandidate<T> | null {
  const usable = candidates.filter(
    (candidate) => candidate.valid && !(options.localScoringStarted && candidate.source === 'server'),
  );
  const journal = usable.find((candidate) => candidate.source === 'journal');
  if (journal) return journal;
  return usable.slice().sort(compareCandidates)[0] ?? null;
}

/** Compare a recovery source's exact state with another source when hashes are available. */
export function sourcesMatch(
  first: Pick<IRecoveryCandidate, 'fingerprint'>,
  second: Pick<IRecoveryCandidate, 'fingerprint'>,
): 'match' | 'different' | 'unavailable' {
  if (!first.fingerprint || !second.fingerprint) return 'unavailable';
  return first.fingerprint === second.fingerprint ? 'match' : 'different';
}

export interface ICheckpointInspection {
  checkpoint: IRecoveryCheckpoint;
  valid: boolean;
  errors: string[];
}

/** Inspect a stored checkpoint while preserving its raw serialized text. */
export function inspectRecoveryCheckpoint(checkpoint: IRecoveryCheckpoint): ICheckpointInspection {
  try {
    const parsed: unknown = JSON.parse(checkpoint.serializedBackup);
    const result = readQbsheetBackup(parsed);
    return result.ok
      ? { checkpoint, valid: true, errors: [] }
      : { checkpoint, valid: false, errors: result.errors };
  } catch {
    return { checkpoint, valid: false, errors: ['The checkpoint is not readable as JSON.'] };
  }
}

/** Return checkpoint inspections newest first; invalid newest entries remain visible to diagnostics. */
export function inspectCheckpoints(checkpoints: readonly IRecoveryCheckpoint[]): ICheckpointInspection[] {
  return checkpoints
    .slice()
    .sort((first, second) => {
      const byTime = new Date(second.capturedAt ?? '').getTime() - new Date(first.capturedAt ?? '').getTime();
      return byTime !== 0 ? byTime : String(second.id ?? '').localeCompare(String(first.id ?? ''));
    })
    .map(inspectRecoveryCheckpoint);
}
