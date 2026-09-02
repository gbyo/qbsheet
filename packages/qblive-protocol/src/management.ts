/**
 * QBLive management API.
 *
 * The authenticated half of the protocol: what a Director (or any compatible publisher) sends to a
 * QBLive server. Kept in its own module so that a client bundle can import the public types without
 * pulling in the shapes of privileged requests, and so that the separation is visible in the source
 * tree rather than only in the routing table.
 *
 * Authentication is a bearer management credential. Every route below requires it; no public route
 * accepts it. See `docs/QBLIVE.md#management-api`.
 */

import type { QbliveAnnouncement, QbliveSections, QbliveSnapshot, QbliveId } from './types.js';

/** Replace the entire public state. Used for the first publish and for conflict repair. */
export interface QbliveSnapshotRequest {
  snapshot: QbliveSnapshot;
}

/**
 * Advance the publication by replacing named sections.
 *
 * `baseRevision` is the revision the publisher believes the server holds. A server that holds a
 * different one answers `409` with its own `currentRevision` rather than applying the update, which
 * is what makes a lost acknowledgement recoverable instead of corrupting.
 */
export interface QbliveSectionsRequest {
  baseRevision: number;
  revision: number;
  generatedAt: string;
  sections: Partial<QbliveSections>;
}

export interface QbliveAnnouncementRequest {
  revision: number;
  announcement: QbliveAnnouncement;
}

export interface QbliveFinalizeRequest {
  revision: number;
  /** The last public state. Sent whole, because a final page must not depend on replay history. */
  snapshot: QbliveSnapshot;
}

export interface QbliveManagementAck {
  publicationId: QbliveId;
  /** The revision the server holds after applying the request. */
  revision: number;
  final: boolean;
}

/**
 * The one-time claim a freshly deployed backend issues.
 *
 * A tournament director deploys the template, the deployment mints this, and Director exchanges it
 * once for a long-lived management credential. The short-lived value is the one that travels
 * through a browser address bar; the durable one never does.
 */
export interface QbliveClaimRequest {
  setupToken: string;
  publicationId: QbliveId;
  displayName?: string;
}

export interface QbliveClaimResponse {
  publicationId: QbliveId;
  managementToken: string;
  /** Echoed so Director can record exactly the origin the backend believes it serves. */
  origin: string;
}
