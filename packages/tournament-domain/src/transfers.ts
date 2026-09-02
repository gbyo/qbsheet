/**
 * The persistent shape of transport-agnostic transfers.
 *
 * # Why there is no `mode` field anywhere in here
 *
 * A tournament does not pick a transport. Room 101 is on QBTCP, room 102 has a USB stick, room 103
 * shares a synced folder, and room 104 hands in paper — in the same round, sometimes for the same
 * game. A `mode` on `Tournament` or on `ScheduledGame` would make one of those the truth and the
 * rest an exception, and the first time a room's tablet dropped off the network the director would
 * have to change a setting on the tournament to hand out a file.
 *
 * So delivery and return are modelled as *events around* the scheduled game rather than as a
 * property of it. `AssignmentTransfer` records that a particular revision of a particular game's
 * assignment went somewhere. `IncomingArtifact` records that a file showed up. Neither of them is
 * exclusive, both of them are many-per-game, and the scheduled game itself is unchanged.
 *
 * # What is deliberately not here
 *
 * File *contents*. An artifact keeps a digest, a length, a classification and the identity it
 * parsed out of the QBJ. The document itself lives on the staged `ResultSubmission` that the
 * ingestion pipeline produces, which is where every other result already lives. Keeping bytes in
 * two places would make the transfer log a second, worse copy of the results inbox.
 */
/**
 * Declared here rather than imported from the domain model, so that the domain model can import
 * this file without the two forming a cycle. It is the same alias on both sides.
 */
type DirectorId = string;

/**
 * How an assignment or a result travelled.
 *
 * `qbtcp` is present because the unified history is more useful than a history with a hole in it:
 * a director asking "did room 104 ever get round 6?" wants one answer, not two lists to reconcile.
 * It does not mean QBTCP is implemented through the file subsystem — it is not, and the QBTCP
 * transfer record is written by the QBTCP release path rather than by anything in this directory.
 */
export type TransportKind = 'qbtcp' | 'removable-drive' | 'folder' | 'manual-file' | 'download' | 'other';

export const transportKinds: readonly TransportKind[] = [
  'qbtcp',
  'removable-drive',
  'folder',
  'manual-file',
  'download',
  'other',
];

export type AssignmentTransferStatus = 'pending' | 'written' | 'failed';

/** One delivery of one revision of one game's assignment to one destination. */
export interface AssignmentTransfer {
  id: DirectorId;
  scheduledGameId: DirectorId;
  /** The round revision the assignment was cut from, so a stale return is recognisable. */
  roundRevision: number;
  /** The room-local issue number of the assignment, separate from the round's pairing revision. */
  assignmentRevision: number;
  /** Digest of the exact bytes written, so a returned copy can be identified as that copy. */
  artifactDigest: string;
  transportKind: TransportKind;
  /** What a person would call the destination: "SanDisk Ultra", "Quiz Bowl Exchange", "Room 104". */
  destinationLabel: string;
  /** Present for a filesystem destination; absent for QBTCP and for a browser download. */
  destinationPath?: string;
  fileName?: string;
  createdAt: string;
  completedAt?: string;
  status: AssignmentTransferStatus;
  /** Why a `failed` transfer failed, in the words shown to the director. */
  message?: string;
}

/** Where a file came from. Parallel to `TransportKind`, but for the return direction. */
export type ArtifactSourceKind = 'removable-drive' | 'folder' | 'drop' | 'file-picker' | 'qbtcp' | 'other';

/**
 * What Director decided a detected file is.
 *
 * `ready` and `duplicate` are decisions. `needs-review` is a deliberate refusal to decide — the
 * file parses and matches a game, but something about it (a stale revision, a different roster, a
 * result that already exists with different numbers) is a question for a person. `assignment` is
 * the case that would otherwise be the worst bug in the feature: an unplayed assignment file
 * imported as a final 0–0 game.
 */
export type ArtifactClassification =
  'ready' | 'duplicate' | 'needs-review' | 'assignment' | 'not-a-result' | 'invalid';

export type ArtifactStatus = 'detected' | 'staged' | 'imported' | 'ignored' | 'failed';

/** One file Director has seen, and what it decided about it. */
export interface IncomingArtifact {
  id: DirectorId;
  sourceKind: ArtifactSourceKind;
  sourceLabel: string;
  /** Absent for a dropped or picked file in the browser, where there is no readable path. */
  originalPath?: string;
  fileName: string;
  byteLength: number;
  digest: string;
  detectedAt: string;

  parsedTournamentId?: string;
  parsedMatchId?: string;
  roundRevision?: number;
  assignmentRevision?: number;

  classification: ArtifactClassification;
  /** Machine-readable reasons, shared with the QBTCP path. See `ingest.ts`. */
  warnings: string[];
  status: ArtifactStatus;
  /** The staged submission this file became, when it became one. */
  submissionId?: DirectorId;
  scheduledGameId?: DirectorId;
  /** One sentence for a person, when the classification needs explaining. */
  detail?: string;
}

export type TransferLocationKind = 'removable-drive' | 'folder';

/**
 * A place Director can write assignments to and read results from.
 *
 * A USB stick, a folder on the desktop, a Google Drive folder, a mounted share and an external
 * drive are the same thing here: a directory a person chose. That is the whole reason cloud
 * services need no integration — the sync client already put the folder on the filesystem.
 */
export interface TransferLocation {
  id: DirectorId;
  kind: TransferLocationKind;
  /** Display name. For a drive this is the volume's own name. */
  label: string;
  /** The exchange root — the directory holding `QBSheet/` or the `QBSheet/` directory itself. */
  path: string;
  /** For a removable drive, the mount point it was found at, which the drive keeps across sessions. */
  mountPoint?: string;
  connected: boolean;
  readOnly: boolean;
  /** Watch the Results directory and stage what appears. */
  watching: boolean;
  /** True once Director has written the exchange layout here. */
  initialized: boolean;
  addedAt: string;
  lastSeenAt?: string;
  lastScanAt?: string;
  /** Available bytes, when the platform reports it. */
  availableBytes?: number;
  /** Why the location is currently unusable, in the words shown to the director. */
  message?: string;
  /** Set when the path looks like a cloud provider's sync folder. Advisory only. */
  cloudProvider?: string;
}

export type TransferEventKind =
  | 'location-added'
  | 'location-removed'
  | 'location-connected'
  | 'location-disconnected'
  | 'assignments-prepared'
  | 'assignment-failed'
  | 'results-discovered'
  | 'result-staged'
  | 'duplicate-detected'
  | 'result-imported'
  | 'scan-failed';

/**
 * The transfer log.
 *
 * Operational, not forensic. It says an assignment went to a drive and four results came back; it
 * does not say what was in them. A filesystem log dressed as tournament history would be both a
 * privacy problem and useless during a round.
 */
export interface TransferEvent {
  id: DirectorId;
  at: string;
  kind: TransferEventKind;
  summary: string;
  locationId?: DirectorId;
  count?: number;
  detail?: string;
}

export interface TransferState {
  version: number;
  locations: TransferLocation[];
  assignments: AssignmentTransfer[];
  artifacts: IncomingArtifact[];
  events: TransferEvent[];
}

export const transferStateVersion = 1;

/** How many transfer log entries are kept. Enough for a tournament day, bounded for a season. */
export const maxTransferEvents = 400;
/** How many seen-file records are kept. Bounds the duplicate memory without bounding a round. */
export const maxIncomingArtifacts = 2000;

export function emptyTransferState(): TransferState {
  return { version: transferStateVersion, locations: [], assignments: [], artifacts: [], events: [] };
}

/**
 * Repair a transfers block loaded from storage.
 *
 * Director state is a document, and a document written by an older build is missing this whole
 * block. Everything downstream may assume the arrays exist.
 */
export function normalizeTransferState(value: unknown): TransferState {
  const empty = emptyTransferState();
  if (!value || typeof value !== 'object') return empty;
  const candidate = value as Partial<TransferState>;
  return {
    version: transferStateVersion,
    locations: Array.isArray(candidate.locations) ? candidate.locations : [],
    assignments: Array.isArray(candidate.assignments) ? candidate.assignments : [],
    artifacts: Array.isArray(candidate.artifacts) ? candidate.artifacts : [],
    events: Array.isArray(candidate.events) ? candidate.events : [],
  };
}

export function transportLabel(kind: TransportKind): string {
  switch (kind) {
    case 'qbtcp':
      return 'QBTCP';
    case 'removable-drive':
      return 'USB drive';
    case 'folder':
      return 'Folder';
    case 'manual-file':
      return 'File';
    case 'download':
      return 'Download';
    default:
      return 'Other';
  }
}

export function sourceLabelForKind(kind: ArtifactSourceKind): string {
  switch (kind) {
    case 'removable-drive':
      return 'USB drive';
    case 'folder':
      return 'Watched folder';
    case 'drop':
      return 'Dropped file';
    case 'file-picker':
      return 'Chosen file';
    case 'qbtcp':
      return 'QBTCP';
    default:
      return 'Other';
  }
}
