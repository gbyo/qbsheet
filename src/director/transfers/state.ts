/**
 * Draft mutations for transfers.
 *
 * Kept out of `useDirectorController` because they are ordinary functions of a state document and
 * nothing about them is React. That makes the whole set — a drive appearing, a drive vanishing, a
 * round prepared onto a stick, a batch of files imported, a duplicate arriving by a second route —
 * testable by calling functions in order against a plain object, which is how the mixed-transport
 * cases in `mixedTransport.test.ts` are written.
 *
 * Every function here takes a mutable draft and returns a small summary. None of them accepts a
 * result into the tournament: staging puts a submission in the results inbox and that is the end of
 * this subsystem's authority.
 */
import { isoNow, newDirectorId, type DirectorId, type DirectorState } from '../domain/model';
import {
  alreadySeen,
  assessIncomingDocument,
  recordTransferEvent,
  stageIncomingDocument,
  stageInvalidDocument,
  type IncomingDocument,
} from './ingest';
import { detectCloudProvider, exchangePaths, lastPathSegment } from './layout';
import type {
  AssignmentTransfer,
  ArtifactClassification,
  TransferLocation,
  TransferLocationKind,
  TransportKind,
} from './model';
import type { TransferVolume } from './ports';
import type { PrepareReport } from './prepare';

export interface AddLocationInput {
  kind: TransferLocationKind;
  label: string;
  path: string;
  mountPoint?: string;
  readOnly?: boolean;
  availableBytes?: number;
  watching?: boolean;
}

/**
 * Add a place, or re-adopt one already known.
 *
 * Matching on path rather than on a generated id is what makes "remember approved transfer
 * locations across restarts" work: the same folder chosen twice is the same location, and a drive
 * that comes back at the mount point it had before is the location the director already configured
 * rather than a second copy of it.
 */
export function addTransferLocation(draft: DirectorState, input: AddLocationInput): TransferLocation {
  const normalized = input.path.replace(/[\\/]+$/, '');
  const existing = draft.transfers.locations.find(
    (location) => location.path.replace(/[\\/]+$/, '') === normalized,
  );
  const cloudProvider = detectCloudProvider(normalized);
  if (existing) {
    existing.label = input.label || existing.label;
    existing.connected = true;
    existing.readOnly = input.readOnly ?? existing.readOnly;
    existing.lastSeenAt = isoNow();
    if (input.availableBytes !== undefined) existing.availableBytes = input.availableBytes;
    if (input.watching !== undefined) existing.watching = input.watching;
    if (cloudProvider) existing.cloudProvider = cloudProvider;
    delete existing.message;
    return existing;
  }
  const location: TransferLocation = {
    id: newDirectorId('transfer-location'),
    kind: input.kind,
    label: input.label || lastPathSegment(normalized),
    path: normalized,
    ...(input.mountPoint ? { mountPoint: input.mountPoint } : {}),
    connected: true,
    readOnly: input.readOnly ?? false,
    watching: input.watching ?? input.kind === 'folder',
    initialized: false,
    addedAt: isoNow(),
    lastSeenAt: isoNow(),
    ...(input.availableBytes === undefined ? {} : { availableBytes: input.availableBytes }),
    ...(cloudProvider ? { cloudProvider } : {}),
  };
  draft.transfers.locations.push(location);
  recordTransferEvent(draft, {
    kind: 'location-added',
    summary: `Added ${location.label}`,
    locationId: location.id,
    detail: location.path,
  });
  return location;
}

export function removeTransferLocation(draft: DirectorState, locationId: DirectorId): void {
  const location = draft.transfers.locations.find((entry) => entry.id === locationId);
  if (!location) return;
  draft.transfers.locations = draft.transfers.locations.filter((entry) => entry.id !== locationId);
  recordTransferEvent(draft, {
    kind: 'location-removed',
    summary: `Removed ${location.label}`,
    detail: location.path,
  });
}

/**
 * Reconcile the known locations against what the platform can currently see.
 *
 * A removable drive that appears becomes a connected location; one that vanishes stays in the list
 * marked disconnected rather than being deleted, because a director who configured a stick and
 * pulled it to walk it to a room has not stopped using that stick. Explicitly chosen folders are
 * untouched by volume enumeration — a folder is not a volume, and a network share that is briefly
 * unreachable must not be forgotten because a poll missed it.
 */
export function syncRemovableVolumes(
  draft: DirectorState,
  volumes: TransferVolume[],
): { appeared: TransferLocation[]; disappeared: TransferLocation[]; metadataChanged: boolean } {
  const now = isoNow();
  const removable = volumes.filter((volume) => volume.removable);
  const byMountPoint = new Map(removable.map((volume) => [volume.mountPoint, volume]));
  const appeared: TransferLocation[] = [];
  const disappeared: TransferLocation[] = [];
  let metadataChanged = false;

  for (const location of draft.transfers.locations) {
    if (location.kind !== 'removable-drive') continue;
    const volume = location.mountPoint ? byMountPoint.get(location.mountPoint) : undefined;
    if (volume) {
      const nextLabel = volume.name || location.label;
      if (
        !location.connected ||
        location.label !== nextLabel ||
        location.readOnly !== volume.readOnly ||
        location.availableBytes !== volume.availableBytes ||
        location.lastSeenAt !== now ||
        location.message !== undefined
      ) {
        metadataChanged = true;
      }
      if (!location.connected) {
        location.connected = true;
        appeared.push(location);
        recordTransferEvent(draft, {
          kind: 'location-connected',
          summary: `${location.label} connected`,
          locationId: location.id,
        });
      }
      location.label = nextLabel;
      location.readOnly = volume.readOnly;
      location.availableBytes = volume.availableBytes;
      location.lastSeenAt = now;
      delete location.message;
    } else if (location.connected) {
      location.connected = false;
      location.message = 'The drive is not connected.';
      disappeared.push(location);
      recordTransferEvent(draft, {
        kind: 'location-disconnected',
        summary: `${location.label} disconnected`,
        locationId: location.id,
      });
    }
  }

  const knownMountPoints = new Set(
    draft.transfers.locations
      .filter((location) => location.kind === 'removable-drive')
      .map((location) => location.mountPoint),
  );
  for (const volume of removable) {
    if (knownMountPoints.has(volume.mountPoint)) continue;
    const location = addTransferLocation(draft, {
      kind: 'removable-drive',
      label: volume.name || lastPathSegment(volume.mountPoint),
      path: volume.mountPoint,
      mountPoint: volume.mountPoint,
      readOnly: volume.readOnly,
      ...(volume.availableBytes === undefined ? {} : { availableBytes: volume.availableBytes }),
      watching: false,
    });
    appeared.push(location);
  }

  return { appeared, disappeared, metadataChanged };
}

export function setTransferWatching(draft: DirectorState, locationId: DirectorId, watching: boolean): void {
  const location = draft.transfers.locations.find((entry) => entry.id === locationId);
  if (location) location.watching = watching;
}

export function noteTransferScan(
  draft: DirectorState,
  locationId: DirectorId,
  outcome: { at: string; message?: string; found?: number },
): void {
  const location = draft.transfers.locations.find((entry) => entry.id === locationId);
  if (!location) return;
  location.lastScanAt = outcome.at;
  if (outcome.message) location.message = outcome.message;
  else delete location.message;
  if (outcome.message)
    recordTransferEvent(draft, {
      kind: 'scan-failed',
      summary: `${location.label} could not be read`,
      locationId: location.id,
      detail: outcome.message,
    });
}

export interface RecordPreparedInput {
  report: PrepareReport;
  transportKind: TransportKind;
  destinationLabel: string;
  locationId?: DirectorId;
}

/**
 * Write the transfer records for a completed prepare.
 *
 * One `AssignmentTransfer` per file, carrying the revisions the file was cut from and the digest of
 * its bytes. The revisions are the whole point: when that file comes back three rounds later,
 * `assessIncomingDocument` compares what it carries against what the round is at now, and the
 * difference is the only thing separating a current result from one scored against a bracket that
 * has since been rebuilt.
 */
export function recordPreparedAssignments(draft: DirectorState, input: RecordPreparedInput): void {
  const now = isoNow();
  for (const written of input.report.written) {
    const transfer: AssignmentTransfer = {
      id: newDirectorId('assignment-transfer'),
      scheduledGameId: written.assignment.scheduledGameId,
      roundRevision: written.assignment.roundRevision,
      assignmentRevision: written.assignment.assignmentRevision,
      artifactDigest: written.digest,
      transportKind: input.transportKind,
      destinationLabel: input.destinationLabel,
      destinationPath: written.path,
      fileName: written.fileName,
      createdAt: now,
      completedAt: now,
      status: 'written',
    };
    draft.transfers.assignments.push(transfer);
  }
  for (const failure of input.report.failures) {
    draft.transfers.assignments.push({
      id: newDirectorId('assignment-transfer'),
      scheduledGameId: failure.scheduledGameId,
      roundRevision: 0,
      assignmentRevision: 0,
      artifactDigest: '',
      transportKind: input.transportKind,
      destinationLabel: input.destinationLabel,
      createdAt: now,
      status: 'failed',
      message: failure.reason,
    });
  }
  const count = input.report.written.length;
  if (count > 0) {
    recordTransferEvent(draft, {
      kind: 'assignments-prepared',
      summary: `Prepared ${count} assignment${count === 1 ? '' : 's'} on ${input.destinationLabel}`,
      ...(input.locationId ? { locationId: input.locationId } : {}),
      count,
    });
    draft.audit.push({
      id: newDirectorId('audit'),
      at: now,
      actor: 'Director',
      type: 'assignment-prepared',
      summary: `Prepared ${count} assignment file${count === 1 ? '' : 's'} for ${input.destinationLabel}.`,
      details: { transport: input.transportKind, destination: input.destinationLabel, count },
    });
  }
  if (input.report.failures.length > 0)
    recordTransferEvent(draft, {
      kind: 'assignment-failed',
      summary: `${input.report.failures.length} assignment${input.report.failures.length === 1 ? '' : 's'} could not be written to ${input.destinationLabel}`,
      ...(input.locationId ? { locationId: input.locationId } : {}),
      count: input.report.failures.length,
      detail: input.report.failures[0]?.reason,
    });
}

/**
 * Record that QBTCP delivered assignments for a round.
 *
 * The QBTCP release path is not routed through the file subsystem and this does not make it so — it
 * writes the same history row a file delivery writes, so that "how did room 104 get round 6" has
 * one answer in one table instead of two answers a director has to join by hand.
 */
export function recordQbtcpDelivery(draft: DirectorState, roundId: DirectorId): void {
  const round = draft.rounds.find((entry) => entry.id === roundId);
  if (!round) return;
  const now = isoNow();
  const games = draft.scheduledGames.filter(
    (game) => game.roundId === roundId && !game.bye && game.status !== 'cancelled',
  );
  for (const game of games) {
    draft.transfers.assignments.push({
      id: newDirectorId('assignment-transfer'),
      scheduledGameId: game.id,
      roundRevision: round.revision,
      assignmentRevision: game.assignmentRevision,
      artifactDigest: '',
      transportKind: 'qbtcp',
      destinationLabel: draft.rooms.find((room) => room.id === game.roomId)?.name ?? 'QBTCP',
      createdAt: now,
      completedAt: now,
      status: 'written',
    });
  }
}

export interface ImportSummary {
  imported: number;
  duplicates: number;
  needsReview: number;
  assignments: number;
  invalid: number;
  skipped: number;
  classifications: ArtifactClassification[];
  messages: string[];
}

export type ImportInput =
  | { ok: true; document: IncomingDocument }
  | {
      ok: false;
      sourceKind: IncomingDocument['sourceKind'];
      sourceLabel: string;
      fileName: string;
      originalPath?: string;
      byteLength: number;
      digest: string;
      reason: string;
    };

/**
 * Import a batch.
 *
 * One malformed file does not fail the batch. That is the difference between a director dropping
 * twelve downloads on the window and getting eleven results plus one explained refusal, and a
 * director getting nothing and no idea which file was the problem.
 *
 * A file whose bytes Director has already read from the same path is skipped rather than staged
 * again, which is what stops a drive plugged in four times from producing four copies of every
 * result on it.
 */
export function importTransferDocuments(draft: DirectorState, inputs: ImportInput[]): ImportSummary {
  const summary: ImportSummary = {
    imported: 0,
    duplicates: 0,
    needsReview: 0,
    assignments: 0,
    invalid: 0,
    skipped: 0,
    classifications: [],
    messages: [],
  };
  for (const input of inputs) {
    if (!input.ok) {
      stageInvalidDocument(draft, input);
      summary.invalid += 1;
      summary.classifications.push('invalid');
      summary.messages.push(`${input.fileName}: ${input.reason}`);
      continue;
    }
    const seen = alreadySeen(draft, input.document.digest, input.document.originalPath);
    if (seen) {
      summary.skipped += 1;
      continue;
    }
    const assessment = assessIncomingDocument(draft, input.document);
    stageIncomingDocument(draft, input.document, assessment);
    summary.classifications.push(assessment.classification);
    switch (assessment.classification) {
      case 'ready':
        summary.imported += 1;
        break;
      case 'needs-review':
        summary.needsReview += 1;
        summary.messages.push(`${input.document.fileName}: ${assessment.detail}`);
        break;
      case 'duplicate':
        summary.duplicates += 1;
        break;
      case 'assignment':
        summary.assignments += 1;
        summary.messages.push(`${input.document.fileName}: ${assessment.detail}`);
        break;
      default:
        summary.invalid += 1;
        summary.messages.push(`${input.document.fileName}: ${assessment.detail}`);
        break;
    }
  }
  const staged = summary.imported + summary.needsReview;
  if (staged > 0)
    recordTransferEvent(draft, {
      kind: 'results-discovered',
      summary: `Imported ${staged} result${staged === 1 ? '' : 's'} from ${
        inputs.find((entry) => entry.ok)?.document.sourceLabel ?? 'a transfer location'
      }`,
      count: staged,
    });
  return summary;
}

export function dismissTransferArtifact(draft: DirectorState, artifactId: DirectorId): void {
  const artifact = draft.transfers.artifacts.find((entry) => entry.id === artifactId);
  if (artifact) artifact.status = 'ignored';
}

/** Where a location's exchange directories are, for the UI and for the native watcher. */
export function locationExchangePaths(location: TransferLocation) {
  return exchangePaths(location.path);
}
