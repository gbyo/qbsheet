/**
 * The line between the file that leaves this device and the state that never does.
 *
 * # Two payloads that look alike and are not
 *
 * The scorer builds one QBJ object per render and hands the same object to three places: the live
 * snapshot going back to tournament control, the final submission, and the download. The first two
 * are transport between this browser and a server that is already holding the game; the third is a
 * file that goes onto a USB stick, into an email, into whatever folder a tournament chose, and into
 * an import on somebody else's laptop.
 *
 * Those are not the same object and must not be. The internal payload carries
 * `_yf_scorekeeper_recovery` — the complete `ScoreEvent` history and the frozen setup — because
 * that is what lets a wiped Chromebook be handed its half-scored game back intact. The portable
 * payload must not, because it is a scorer's private state model shipped inside a file that claims
 * to be an interchange format, it will confuse anything that walks unknown keys, and it makes a
 * three-kilobyte result into a much larger one for no benefit to the person receiving it.
 *
 * So `portableQbj` is the only way a payload leaves the device, and it is subtractive: it removes
 * the recovery layer and anything credential-shaped, and then adds back exactly the small block of
 * identity described below.
 *
 * # Why the download carries any metadata at all
 *
 * Because the alternative is matching on the filename, and the filename is the one thing about a
 * result that is guaranteed to have been changed by the time it arrives. A tournament that receives
 * sixteen QBJs from sixteen rooms has to attach each to the right scheduled game, and asking a human
 * to do that from `Round 7 — Ninety Six A vs Greenwood (1).qbj` is how a result ends up on the wrong
 * match.
 *
 * The block is small, non-secret, and ignorable: nothing here is a credential, nothing identifies a
 * device or a person, and a tool that has never heard of it reads the statistical result exactly as
 * it would have anyway.
 */
import { IGamePackage, gamePackageProducer, gamePackageVersion } from './GamePackage';
import { scorerRecoveryKey } from '../scorer/ScorerRecovery';

/** The extension namespace a downloaded result carries. Deliberately one key, deliberately inert. */
export const sourceExtensionKey = '_qbsheet_source';
/** Read-only compatibility for results downloaded before QBSheet was named. */
const legacySourceExtensionKey = '_scoresheet_source';

export interface IQbjSourceMetadata {
  producer?: typeof gamePackageProducer;
  /** Which package schema produced this result. */
  gamePackageVersion: number;
  /** The tournament's stable identifier, when the package had one. */
  tournamentId?: string;
  tournamentName: string;
  /** The scheduled game this was scored from, when the package named one. */
  scheduledMatchId?: string;
  roundNumber: number;
  /**
   * Which issue of the round's pairings this was scored against.
   *
   * The field that makes a stale result detectable. A result carrying revision 1 for a round that
   * has since been redrawn is not wrong, but it is not current either, and tournament control has
   * to be able to tell the difference without asking the room.
   */
  roundRevision: number;
  roomName?: string;
  /** Stable fingerprint of the portable statistical payload, used for backup reconciliation. */
  resultFingerprint?: string;
}

/**
 * Keys stripped from anything leaving the device, matched after removing separators and case.
 *
 * In practice this removes nothing: the scorer's payload is built by `toQbjMatch`, which has no
 * access to a credential and never puts one anywhere. It is here because "in practice nothing" is a
 * property of today's code rather than of the format, and the cost of being wrong is a room token
 * sitting in a file that gets emailed around.
 */
const forbiddenKeys = new Set([
  'accesstoken',
  'token',
  'sessiontoken',
  'sessionid',
  'sessioncredentials',
  'roomtoken',
  'pairingcode',
  'deviceid',
  'authorization',
  'credentials',
  'secret',
]);

function isForbiddenKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
  return forbiddenKeys.has(normalized) || key === scorerRecoveryKey;
}

/**
 * A deep copy with the recovery layer and anything credential-shaped removed.
 *
 * Deliberately a copy. The caller keeps the exact bytes it will send to the server, and preparing a
 * download must not be able to change what tournament control eventually receives.
 */
export function stripInternalState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripInternalState(entry));
  if (typeof value !== 'object' || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenKey(key)) continue;
    output[key] = stripInternalState(entry);
  }
  return output;
}

export function sourceMetadata(packageValue: IGamePackage): IQbjSourceMetadata {
  return {
    producer: gamePackageProducer,
    gamePackageVersion,
    ...(packageValue.tournament.key ? { tournamentId: packageValue.tournament.key } : {}),
    tournamentName: packageValue.tournament.name,
    ...(packageValue.scheduledMatchId ? { scheduledMatchId: packageValue.scheduledMatchId } : {}),
    roundNumber: packageValue.round.number,
    roundRevision: packageValue.round.revision,
    ...(packageValue.room?.name ? { roomName: packageValue.room.name } : {}),
  };
}

/** Canonical JSON for a portable result, with object-key order made irrelevant. */
function canonicalPortableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalPortableJson(entry)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== sourceExtensionKey && key !== legacySourceExtensionKey)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalPortableJson(entry)}`)
    .join(',')}}`;
}

/**
 * A small browser-safe fingerprint for matching an automatic server result to its later QBJ backup.
 *
 * This is an equality aid, not an authenticity claim: the server still authenticates the room and
 * the director still reviews results. BigInt keeps the value deterministic across browsers without
 * pulling a Node crypto polyfill into the static site.
 */
export function portableResultFingerprint(qbj: object): string {
  const canonical = canonicalPortableJson(stripInternalState(qbj));
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= BigInt(canonical.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

/** Attach source identity to the internal payload sent to control without removing recovery data. */
export function qbjWithSourceMetadata(qbj: object, packageValue: IGamePackage): object {
  return {
    ...qbj,
    [sourceExtensionKey]: {
      ...sourceMetadata(packageValue),
      resultFingerprint: portableResultFingerprint(qbj),
    },
  };
}

/**
 * The result as a file: an ordinary QBJ Match, plus one block saying which game it came from.
 *
 * The only function that produces something for a human to carry away. Everything that downloads,
 * re-downloads or shows a result goes through it, so there is exactly one place where the question
 * "could this file contain something it shouldn't" has to be answered.
 */
export function portableQbj(qbj: object, packageValue: IGamePackage): object {
  const stripped = stripInternalState(qbj) as Record<string, unknown>;
  return {
    ...stripped,
    [sourceExtensionKey]: {
      ...sourceMetadata(packageValue),
      resultFingerprint: portableResultFingerprint(qbj),
    },
  };
}

/** Read the source block back, for a tool that wants to know where a result came from. */
export function readSourceMetadata(qbj: unknown): IQbjSourceMetadata | null {
  if (typeof qbj !== 'object' || qbj === null) return null;
  const record = qbj as Record<string, unknown>;
  const block = record[sourceExtensionKey] ?? record[legacySourceExtensionKey];
  if (typeof block !== 'object' || block === null) return null;
  const candidate = block as Partial<IQbjSourceMetadata>;
  if (candidate.producer !== undefined && candidate.producer !== gamePackageProducer) return null;
  if (typeof candidate.gamePackageVersion !== 'number' || !Number.isInteger(candidate.gamePackageVersion)) return null;
  if (typeof candidate.tournamentName !== 'string' || candidate.tournamentName.trim() === '') return null;
  if (typeof candidate.roundNumber !== 'number' || !Number.isInteger(candidate.roundNumber) || candidate.roundNumber < 1)
    return null;
  if (
    typeof candidate.roundRevision !== 'number' ||
    !Number.isInteger(candidate.roundRevision) ||
    candidate.roundRevision < 1
  )
    return null;
  if (candidate.tournamentId !== undefined && typeof candidate.tournamentId !== 'string') return null;
  if (candidate.scheduledMatchId !== undefined && typeof candidate.scheduledMatchId !== 'string') return null;
  if (candidate.roomName !== undefined && typeof candidate.roomName !== 'string') return null;
  if (candidate.resultFingerprint !== undefined && typeof candidate.resultFingerprint !== 'string') return null;
  return candidate as IQbjSourceMetadata;
}
