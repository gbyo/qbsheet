/**
 * Transport-agnostic transfers, re-exported from the canonical tournament domain.
 *
 * Transfers are part of the persisted tournament document, so the types moved to
 * `@qbsheet/tournament-domain` alongside `DirectorState`. Naming the exports rather than
 * re-exporting the whole domain keeps this module's surface the same as it was. See
 * `docs/TRANSFERS.md`.
 */

export {
  emptyTransferState,
  maxIncomingArtifacts,
  maxTransferEvents,
  normalizeTransferState,
  sourceLabelForKind,
  transferStateVersion,
  transportKinds,
  transportLabel,
} from '@qbsheet/tournament-domain';

export type {
  ArtifactClassification,
  ArtifactSourceKind,
  ArtifactStatus,
  AssignmentTransfer,
  AssignmentTransferStatus,
  IncomingArtifact,
  TransferEvent,
  TransferEventKind,
  TransferLocation,
  TransferLocationKind,
  TransferState,
  TransportKind,
} from '@qbsheet/tournament-domain';
